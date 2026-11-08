import { app, BrowserWindow, WebContentsView, ipcMain, session, clipboard, dialog } from 'electron';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { captureSnapshot } from './snapshot.mjs';

process.umask(0o077);
const root = path.dirname(fileURLToPath(import.meta.url));
const runtime = process.env.EGO_LINUX_RUNTIME;
if (process.getuid() === 0 || !runtime || !path.isAbsolute(runtime)) throw new Error('An unprivileged desktop runtime is required');
const runtimeInfo = fs.lstatSync(runtime);
if (runtimeInfo.isSymbolicLink() || runtimeInfo.uid !== process.getuid() || runtimeInfo.mode & 0o077) throw new Error('Unsafe runtime directory');
const config = JSON.parse(fs.readFileSync(path.join(runtime, 'runtime.json'), 'utf8'));
app.setName('Ego Browser Linux');
app.setPath('userData', config.userData);
app.commandLine.appendSwitch('disable-dev-shm-usage');
const primary = app.requestSingleInstanceLock();
const browserInstanceId = `linux-host:${randomUUID()}`;

let window;
let server;
let nextSpace = 1;
let activeSpaceId;
let desktopHuman = false;
let overviewOpen = false;
let capturingPreviews = false;
let stateReady = false;
let clipboardTransaction;
const spaces = new Map();
const targets = new Map();
const clients = new Set();
const stateFile = path.join(config.userData, 'spaces.json');
const socketPath = path.join(runtime, 'bridge.sock');
const failure = (message, code = 'EGO_OPERATION_FAILED') => Object.assign(new Error(message), { error_code: code });

function writeState() {
  if (!stateReady) return;
  const state = [...spaces.values()].map(space => ({ id: space.id, name: space.name, createdBy: space.createdBy, ownership: space.ownership, taskStatus: space.taskStatus,
    activeIndex: [...space.pages.keys()].indexOf(space.activeTarget), urls: [...space.pages.values()].map(page => {
      const url = page.view.webContents.getURL();
      try { const saved = new URL(url); for (const key of [...saved.searchParams.keys()]) if (/token|secret|password|authorization|^code$/i.test(key)) saved.searchParams.delete(key); saved.hash=''; return saved.href; } catch { return 'about:blank'; }
    }) }));
  const temp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ nextSpace, activeSpaceId, spaces: state }), { mode: 0o600, flag: 'w' });
  fs.renameSync(temp, stateFile);
}

function uiState() {
  return { activeSpaceId, desktopHuman, overviewOpen, version: '0.2.2', sdkVersion: '2.2.0', spaces: [...spaces.values()].map(space => ({
    id: space.id, name: space.name, ownership: space.ownership, activeTabId: space.activeTarget,
    running: !desktopHuman && space.ownership === 'agent' && [...clients].some(client => client.spaceId === space.id),
    taskStatus: space.taskStatus, action: space.action || '',
    preview: space.preview && space.preview.targetId === space.activeTarget ? space.preview.data : '',
    tabs: [...space.pages.values()].map(page => ({ id: page.targetId, title: page.view.webContents.getTitle(), url: page.view.webContents.getURL() || 'about:blank', error: page.error })),
  })) };
}

function update() {
  if (window && !window.isDestroyed()) window.webContents.send('ego-state', uiState());
  layout();
}

function layout() {
  if (!window || window.isDestroyed()) return;
  const [width, height] = window.getContentSize();
  const sidebar = width <= 800 ? 170 : 220;
  const current = spaces.get(activeSpaceId);
  for (const space of spaces.values()) for (const page of space.pages.values()) {
    const visible = !overviewOpen && space === current && page.targetId === current.activeTarget && page.view.webContents.getURL() !== 'about:blank';
    page.view.setVisible(visible);
    page.view.setBounds({ x: sidebar, y: 192 + (page.error ? 24 : 0), width: Math.max(1, width - sidebar), height: Math.max(1, height - 192 - (page.error ? 24 : 0)) });
  }
}

async function capturePreviews() {
  if (!overviewOpen || capturingPreviews || !window || window.isDestroyed()) return;
  capturingPreviews = true;
  try {
    for (const space of spaces.values()) {
      if (!overviewOpen) break;
      const page = space.pages.get(space.activeTarget);
      if (!page || page.view.webContents.isDestroyed() || page.view.webContents.getURL() === 'about:blank') continue;
      const targetId = page.targetId;
      try {
        const capture = await page.view.webContents.capturePage(undefined, { stayHidden: true });
        if (!capture.isEmpty() && spaces.has(space.id) && space.activeTarget === targetId) {
          const data = capture.resize({ width: 640 }).toJPEG(75).toString('base64');
          space.preview = { targetId, data: 'data:image/jpeg;base64,' + data };
        }
      } catch { /* A closing or navigating page is refreshed on the next pass. */ }
    }
    if (overviewOpen) update();
  } finally { capturingPreviews = false; }
}

function select(space, page) {
  activeSpaceId = space.id;
  if (page) space.activeTarget = page.targetId;
  update();
}

function validUrl(input) {
  if (input === 'about:blank' || input === '') return 'about:blank';
  if (typeof input !== 'string' || input.length > 16384) throw failure('Invalid URL', 'EGO_INVALID_ARGUMENT');
  let url;
  try { url = new URL(input); } catch { throw failure('An absolute HTTP, HTTPS, or workspace file URL is required', 'EGO_INVALID_ARGUMENT'); }
  if (!['http:', 'https:', 'file:'].includes(url.protocol) || url.username || url.password) throw failure('Unsupported URL', 'EGO_INVALID_ARGUMENT');
  if (url.protocol === 'file:') {
    const file = fs.realpathSync(fileURLToPath(url));
    if (![config.workspace, config.downloads, config.outputDir].some(root => file === root || file.startsWith(root + path.sep))) throw failure('File is outside the workspace', 'EGO_INVALID_ARGUMENT');
  }
  return url.href;
}

async function desktopState() {
  // Optional local supervisor integration. Without it, the per-space ownership
  // controls below remain authoritative; this package exposes no remote API.
  if (!config.controlFile) return { ready: true, boot_id: config.bootId, control_mode: 'agent' };
  let state;
  try {
    const info = fs.lstatSync(config.controlFile);
    if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.getuid() || info.mode & 0o077 || info.size > 8192) throw Error('Unsafe control state');
    state = JSON.parse(fs.readFileSync(config.controlFile, 'utf8'));
  } catch {
    desktopHuman = true;
    throw failure('Desktop supervisor state is unavailable', 'EGO_BROWSER_UNAVAILABLE');
  }
  if (!state.ready || state.boot_id !== config.bootId || !['agent', 'human'].includes(state.control_mode)) {
    desktopHuman = true;
    throw failure('Desktop boot has changed; reconnect the browser', 'EGO_BROWSER_UNAVAILABLE');
  }
  desktopHuman = state.control_mode === 'human';
  return state;
}

async function guard(space, allowUser = false) {
  if (!space || !spaces.has(space.id)) throw failure('Task space not found', 'EGO_TASK_SPACE_NOT_FOUND');
  await desktopState();
  if (desktopHuman || (!allowUser && space.ownership !== 'agent')) throw failure('manual_takeover', 'EGO_TASK_SPACE_USER_IN_CONTROL');
}

function descriptor(space) {
  return { id: space.id, taskId: space.name, name: space.name, ownership: space.ownership, createdBy: space.createdBy, active: true,
    profileId: 'Default', profileName: 'Linux session', recentTabTitles: [...space.pages.values()].map(p => p.view.webContents.getTitle()) };
}

function emit(page, method, params, childSession) {
  for (const client of clients) {
    const sessionId = childSession || client.roots.get(page.targetId);
    if (!sessionId || !client.roots.has(page.targetId)) continue;
    send(client, { kind: 'cdp', message: { method, params, sessionId } });
  }
}

function configureSession(ses, space) {
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    space.ownership = 'user'; update(); writeState();
    let origin = '';
    try { origin = new URL(details.requestingUrl || contents.getURL()).origin; } catch {}
    dialog.showMessageBox(window, { type: 'question', buttons: ['拒绝 / Deny', '允许 / Allow'], defaultId: 0, cancelId: 0,
      message: `网站权限 / Site permission: ${permission}`, detail: origin }).then(result => callback(result.response === 1), () => callback(false));
  });
  ses.on('will-download', (_event, item, contents) => {
    const page = [...space.pages.values()].find(p => p.view.webContents === contents);
    if (!page) { item.cancel(); return; }
    const guid = randomUUID();
    const directory = page.downloadDirectory || path.join(config.downloads, String(space.id));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    item.setSavePath(path.join(directory, guid));
    const begin = { frameId: page.mainFrameId, guid, url: item.getURL(), suggestedFilename: item.getFilename() };
    emit(page, 'Page.downloadWillBegin', begin);
    const progress = state => emit(page, 'Page.downloadProgress', { guid, state, totalBytes: item.getTotalBytes(), receivedBytes: item.getReceivedBytes() });
    item.on('updated', (_event, state) => progress(state === 'interrupted' ? 'canceled' : 'inProgress'));
    item.once('done', (_event, state) => progress(state === 'completed' ? 'completed' : 'canceled'));
  });
}

async function newPage(space, input = 'about:blank', focus = true) {
  if (space.pages.size >= 20) throw failure('Task page limit reached', 'EGO_OPERATION_FAILED');
  const url = validUrl(input);
  const view = new WebContentsView({ webPreferences: { session: space.session, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false } });
  window.contentView.addChildView(view);
  view.webContents.debugger.attach('1.3');
  const { targetInfo } = await view.webContents.debugger.sendCommand('Target.getTargetInfo');
  const page = { view, targetId: targetInfo.targetId, space, childTargets: new Map(), error: null };
  space.pages.set(page.targetId, page); targets.set(page.targetId, page);
  view.webContents.debugger.on('message', (_event, method, params, sessionId) => {
    if (method === 'Target.attachedToTarget') page.childTargets.set(params.sessionId, { targetInfo: params.targetInfo });
    if (method === 'Target.detachedFromTarget') page.childTargets.delete(params.sessionId);
    if (method === 'Page.frameNavigated' && !params.frame?.parentId) page.mainFrameId = params.frame.id;
    if (method === 'Page.downloadWillBegin' || method === 'Page.downloadProgress') return; // emitted from the scoped Electron download handler
    emit(page, method, params, sessionId);
  });
  view.webContents.on('page-title-updated', update);
  view.webContents.on('did-start-navigation', (_event, _url, _inPlace, main) => { if (main) { page.error=null; update(); } });
  view.webContents.on('did-navigate', () => { update(); writeState(); });
  view.webContents.on('did-navigate-in-page', () => { update(); writeState(); });
  view.webContents.on('did-fail-load', (_event, code, description, _url, main) => { if (main && code !== -3) { page.error=description; update(); } });
  view.webContents.on('will-navigate', (event, destination) => { try { validUrl(destination); } catch { event.preventDefault(); } });
  view.webContents.setWindowOpenHandler(({ url: destination }) => {
    try { validUrl(destination); void newPage(space, destination).catch(() => {}); } catch {}
    return { action: 'deny' };
  });
  view.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control) return;
    if (input.key.toLowerCase() === 'l') {
      event.preventDefault(); window.webContents.focus();
      void window.webContents.executeJavaScript("document.getElementById('address').focus();document.getElementById('address').select()").catch(() => {});
    } else if (input.key.toLowerCase() === 't') { event.preventDefault(); void newPage(space).catch(() => {}); }
  });
  if (focus) select(space, page);
  void view.webContents.loadURL(url).catch(() => {});
  return page;
}

async function newSpace(name, ownership = 'agent', id) {
  if (typeof name !== 'string' || !name.trim() || name.length > 160) throw failure('Invalid task-space name', 'EGO_INVALID_ARGUMENT');
  if (spaces.size >= 16) throw failure('Task-space limit reached', 'EGO_OPERATION_FAILED');
  const space = { id: id ?? nextSpace++, name, createdBy: ownership === 'user' ? 'user' : 'agent', ownership, taskStatus: ownership === 'user' ? 'manual' : 'idle', pages: new Map() };
  nextSpace = Math.max(nextSpace, space.id + 1);
  space.session = session.fromPartition(`persist:ego-linux-space-${space.id}`);
  configureSession(space.session, space); spaces.set(space.id, space);
  return space;
}

function closePage(page) {
  window.contentView.removeChildView(page.view);
  page.space.pages.delete(page.targetId);targets.delete(page.targetId);
  page.view.webContents.close();
  for (const client of clients) client.roots.delete(page.targetId);
  if (page.space.activeTarget === page.targetId) page.space.activeTarget = page.space.pages.keys().next().value;
  update();writeState();
}

function pageFor(space, targetId) {
  const page = space.pages.get(targetId ?? space.activeTarget);
  if (!page) throw failure('Page is not in this task space', 'EGO_WEB_CONTENTS_UNAVAILABLE');
  return page;
}

async function cdp(client, space, packet) {
  await guard(space);
  const { id, method, params = {}, sessionId } = packet;
  try {
    let page, nativeSession;
    if (sessionId) {
      const target = [...client.roots].find(([, value]) => value === sessionId)?.[0];
      if (target) page = pageFor(space, target);
      else {
        page = [...space.pages.values()].find(p => p.childTargets.has(sessionId) && client.roots.has(p.targetId));
        if (!page) throw failure('Session is not in this task space', 'EGO_WEB_CONTENTS_UNAVAILABLE');
        nativeSession = sessionId;
      }
    }
    let result;
    if (method === 'Target.getTargets') {
      result = { targetInfos: [...space.pages.values()].map(p => ({ targetId: p.targetId, type: 'page', title: p.view.webContents.getTitle(), url: p.view.webContents.getURL(), attached: true })) };
    } else if (method === 'Target.getTargetInfo') {
      const target = pageFor(space, params.targetId ?? page?.targetId);
      result = { targetInfo: { targetId: target.targetId, type: 'page', title: target.view.webContents.getTitle(), url: target.view.webContents.getURL(), attached: true } };
    } else if (method === 'Target.attachToTarget') {
      const target = pageFor(space, params.targetId);
      let attached = client.roots.get(target.targetId);
      if (!attached) { attached=`ego-linux-${randomUUID()}`;client.roots.set(target.targetId, attached); }
      result={ sessionId: attached };
    } else if (method === 'Target.detachFromTarget') {
      const target = [...client.roots].find(([, value]) => value === params.sessionId)?.[0];
      if (target) client.roots.delete(target);
      else { if (!page) throw failure('Unknown target session'); await page.view.webContents.debugger.sendCommand(method, params, nativeSession); }
      result={};
    } else if (method === 'Target.activateTarget') {
      const target = pageFor(space, params.targetId);select(space, target);target.view.webContents.focus();result={};
    } else if (method === 'Target.closeTarget') {
      closePage(pageFor(space, params.targetId));result={success:true};
    } else if (method === 'Target.createTarget') {
      if (params.browserContextId) throw failure('External browser contexts are unavailable', 'EGO_INVALID_ARGUMENT');
      result={targetId:(await newPage(space, params.url ?? 'about:blank')).targetId};
    } else if (method === 'Target.setDiscoverTargets') result={};
    else if (method === 'Browser.getVersion') result={protocolVersion:'1.3',product:`Chrome/${process.versions.chrome}`,revision:'ego-linux-desktop-host-0.2.2',userAgent:pageFor(space).view.webContents.getUserAgent(),jsVersion:process.versions.v8};
    else if (method.startsWith('Browser.') || (method.startsWith('Target.') && !['Target.setAutoAttach','Target.autoAttachRelated'].includes(method))) throw failure('Browser-wide operation is outside this task space', 'EGO_INVALID_ARGUMENT');
    else if (method.startsWith('egoAutomated.')) result={}; // stock Chromium has no custom Ego engine domain
    else {
      page ??= pageFor(space);
      if (method === 'Page.setDownloadBehavior') {
        if (params.behavior === 'default') page.downloadDirectory=undefined;
        else if (params.behavior === 'allowAndName' || params.behavior === 'allow') {
          if (typeof params.downloadPath !== 'string' || !path.isAbsolute(params.downloadPath)) throw failure('Absolute download directory required', 'EGO_INVALID_ARGUMENT');
          page.downloadDirectory=params.downloadPath;
        } else throw failure('Unsupported download behavior', 'EGO_INVALID_ARGUMENT');
        result={};
      } else {
        if (method === 'Page.navigate') validUrl(params.url);
        result=await page.view.webContents.debugger.sendCommand(method, params, nativeSession);
      }
    }
    return { id, result, ...(sessionId ? {sessionId} : {}) };
  } catch (error) {
    if (error.error_code === 'EGO_TASK_SPACE_USER_IN_CONTROL') throw error;
    return { id, error:{code:-32000,message:String(error.message).slice(0,500)}, ...(sessionId ? {sessionId} : {}) };
  }
}

async function rpc(client, request) {
  const args=request.args??[];
  const space=spaces.get(request.spaceId);
  if (space && client.spaceId !== space.id) { client.spaceId=space.id; update(); }
  if (request.method === 'getBrowserVersion') return {currentVersion:'0.2.2',updateAvailable:false,host:'Linux SDK-compatible reference host',sdkVersion:'2.2.0',browserInstanceId};
  if (request.method === 'listProfiles') return {profiles:[{id:'Default',name:'Linux session',isDefault:true}]};
  if (request.method === 'listTaskSpaces') return {taskSpaces:[...spaces.values()].map(descriptor)};
  if (request.method === 'createTaskSpace') {
    await desktopState();if(desktopHuman)throw failure('manual_takeover','EGO_TASK_SPACE_USER_IN_CONTROL');
    if (args[1] && !['Default','default'].includes(args[1])) throw failure('Profile not found','EGO_PROFILE_NOT_FOUND');
    const created=await newSpace(args[0]);client.spaceId=created.id;await newPage(created);writeState();return descriptor(created);
  }
  if (request.method === 'claimTaskSpace') {
    const claimed=spaces.get(args[0]);await guard(claimed,true);claimed.ownership='agent';if(args[1])claimed.name=String(args[1]).slice(0,160);select(claimed);writeState();return descriptor(claimed);
  }
  if (request.method === 'cdp') return cdp(client,space,args[0]);
  if (request.method === 'takeOverTaskSpace') { await guard(space,true);space.ownership='agent';update();writeState();return descriptor(space); }
  await guard(space);
  if (request.method === 'createTab') { const page=await newPage(space,args[0]);writeState();return {targetId:page.targetId}; }
  if (request.method === 'listTabs') return {tabs:[...space.pages.values()].map((p,index)=>({index,targetId:p.targetId,title:p.view.webContents.getTitle(),url:p.view.webContents.getURL(),active:p.targetId===space.activeTarget}))};
  if (request.method === 'snapshot') return captureSnapshot(pageFor(space,request.targetId),args[0],()=>guard(space));
  if (request.method === 'handOffTaskSpace') { space.ownership='user';space.taskStatus='awaiting_user';update();writeState();return {}; }
  if (request.method === 'completeTaskSpace') {space.ownership='user';space.taskStatus='completed';update();writeState();return {};}
  if (request.method === 'closeTaskSpace') {
    for(const page of [...space.pages.values()])closePage(page);spaces.delete(space.id);activeSpaceId=spaces.keys().next().value;update();writeState();return {};
  }
  if (request.method === 'setAgentTaskState') { space.action=String(args[0]??'').replace(/[\u0000-\u001f]/g,' ').slice(0,160);update();return {}; }
  if (request.method === 'animationHighlightMouseToPosition') return {};
  if (request.method === 'clipboard.begin') {
    if (clipboardTransaction) throw failure('Another clipboard transaction is active','EGO_OPERATION_FAILED');
    const formats=clipboard.availableFormats();
    if(formats.some(format=>!/^(text\/(plain(?:;.*)?|html|rtf|bookmark)|image\/(png|jpeg|bmp)|UTF8_STRING|STRING|TEXT|TARGETS|TIMESTAMP|SAVE_TARGETS|COMPOUND_TEXT)$/i.test(format)))throw failure('Clipboard contains an unsupported format; use insertText to preserve it','EGO_OPERATION_FAILED');
    const previous={text:clipboard.readText(),html:clipboard.readHTML(),rtf:clipboard.readRTF()};
    const image=clipboard.readImage();if(!image.isEmpty())previous.image=image;
    const input=typeof args[0]==='string'?{text:args[0]}:args[0];
    if(!input||typeof input.text!=='string'||input.text.length>2_000_000)throw failure('Invalid clipboard input','EGO_INVALID_ARGUMENT');
    clipboard.write({text:input.text,...(typeof input.html==='string'?{html:input.html}:{})});
    const published=clipboard.availableFormats().map(format=>[format,clipboard.readBuffer(format)]);
    clipboardTransaction={id:randomUUID(),client,previous,published};return {id:clipboardTransaction.id};
  }
  if (request.method === 'clipboard.finish') return restoreClipboard(client,args[0]);
  throw failure('Unknown native host operation','EGO_INVALID_ARGUMENT');
}

function restoreClipboard(client,id) {
  const tx=clipboardTransaction;
  if(!tx||tx.client!==client||tx.id!==id)throw failure('Clipboard transaction not found','EGO_INVALID_ARGUMENT');
  clipboardTransaction=undefined;
  const formats=clipboard.availableFormats();
  if(formats.length!==tx.published.length||tx.published.some(([name,data])=>!clipboard.readBuffer(name).equals(data)))return 'changed';
  clipboard.clear();clipboard.write(tx.previous);return 'restored';
}

function send(client,value) { if(!client.socket.destroyed)client.socket.write(JSON.stringify(value)+'\n'); }

function connect(socket) {
  if(clients.size>=32){socket.destroy();return;}
  const client={socket,roots:new Map()};clients.add(client);let buffer='';
  socket.setEncoding('utf8');
  socket.on('data',chunk=>{
    buffer+=chunk;if(buffer.length>8*1024*1024){socket.destroy();return;}
    let index;
    while((index=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,index);buffer=buffer.slice(index+1);let request;
      try{request=JSON.parse(line);if(!Number.isSafeInteger(request.id)||typeof request.method!=='string'||!Array.isArray(request.args??[]))throw Error();}
      catch{socket.destroy();return;}
      void rpc(client,request).then(result=>send(client,{id:request.id,result}),error=>send(client,{id:request.id,error:{message:String(error.message).slice(0,500),error_code:error.error_code??'EGO_OPERATION_FAILED'}}));
    }
  });
  socket.on('error',()=>{});
  socket.once('close',()=>{if(clipboardTransaction?.client===client)restoreClipboard(client,clipboardTransaction.id);clients.delete(client);update();});
}

async function ui(request) {
  const space=spaces.get(activeSpaceId);
  const page=space?.pages.get(space.activeTarget);
  if(request.action==='state')return uiState();
  if(request.action==='overview'){overviewOpen=!overviewOpen;update();if(overviewOpen)void capturePreviews();return uiState();}
  if(request.action==='close-overview'){overviewOpen=false;update();return uiState();}
  if(request.action==='select-space'){const selected=spaces.get(request.value);if(selected){overviewOpen=false;select(selected);}}
  else if(request.action==='select-tab')select(space,pageFor(space,request.value));
  else if(request.action==='new-space'){overviewOpen=false;const created=await newSpace(String(request.value), 'user');await newPage(created);}
  else if(request.action==='new-tab'){if(space)await newPage(space);}
  else if(request.action==='close-tab'){if(space)closePage(pageFor(space,request.value));}
  else if(request.action==='control'){if(!desktopHuman&&space)space.ownership=space.ownership==='user'?'agent':'user';}
  else if(request.action==='navigate'){
    let destination=String(request.value??'').trim();if(!/^[a-z]+:/i.test(destination))destination='https://'+destination;
    destination=validUrl(destination);if(page)void page.view.webContents.loadURL(destination).catch(()=>{});else if(space)await newPage(space,destination);
  } else if(request.action==='back'&&page?.view.webContents.navigationHistory.canGoBack())page.view.webContents.navigationHistory.goBack();
  else if(request.action==='forward'&&page?.view.webContents.navigationHistory.canGoForward())page.view.webContents.navigationHistory.goForward();
  else if(request.action==='reload'&&page)page.view.webContents.reload();
  update();writeState();return uiState();
}

async function start() {
  await app.whenReady();
  console.info('[ego-linux-host] Electron ready');
  window=new BrowserWindow({width:1280,height:820,minWidth:640,minHeight:400,title:'Ego Browser Linux · SDK compatible',backgroundColor:'#11151b',autoHideMenuBar:true,
    webPreferences:{preload:path.join(root,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  ipcMain.handle('ego-ui',(event,request)=>{
    if(event.sender!==window.webContents||event.senderFrame.url!==new URL('./index.html',import.meta.url).href)throw Error('Untrusted UI sender');
    return ui(request);
  });
  window.on('resize',layout);window.on('closed',()=>app.quit());
  await window.loadFile(path.join(root,'index.html'));
  let saved;
  try{const info=fs.lstatSync(stateFile);if(!info.isSymbolicLink()&&info.uid===process.getuid())saved=JSON.parse(fs.readFileSync(stateFile,'utf8'));}catch{}
  if(saved){
    nextSpace=saved.nextSpace||1;
    for(const item of (saved.spaces??[]).slice(0,16)){
      const space=await newSpace(item.name,item.ownership,item.id);
      if(['idle','manual','awaiting_user','completed'].includes(item.taskStatus))space.taskStatus=item.taskStatus;
      for(const url of (item.urls??[]).slice(0,20)){try{await newPage(space,url,false);}catch{}}
      space.activeTarget=[...space.pages.keys()][item.activeIndex]??space.pages.keys().next().value;
    }
    activeSpaceId=spaces.has(saved.activeSpaceId)?saved.activeSpaceId:spaces.keys().next().value;
  }
  if(!spaces.size){const initial=await newSpace('我的空间 / My space','user');await newPage(initial);}
  if(fs.existsSync(socketPath)){const info=fs.lstatSync(socketPath);if(!info.isSocket()||info.uid!==process.getuid())throw Error('Unsafe bridge socket');fs.unlinkSync(socketPath);}
  server=net.createServer(connect);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});fs.chmodSync(socketPath,0o600);
  console.info('[ego-linux-host] Browser bridge ready');
  stateReady=true;
  update();writeState();
  const timer=setInterval(()=>{const before=desktopHuman;void desktopState().then(()=>{if(before!==desktopHuman)update();},error=>{if(error.message.startsWith('Desktop boot has changed'))app.quit();});},500);timer.unref();
  const previews=setInterval(()=>void capturePreviews(),2000);previews.unref();
  app.on('second-instance',(_event,argv)=>{window.show();window.focus();const url=argv.find(value=>/^https?:\/\//.test(value));const space=spaces.get(activeSpaceId);if(url&&space)void newPage(space,url).catch(()=>{});});
  app.on('before-quit',()=>{server?.close();for(const client of clients)client.socket.destroy();try{if(fs.existsSync(socketPath))fs.unlinkSync(socketPath);}catch{}});
}

// Electron waits for the ESM entry point to settle before emitting ready.
// Awaiting start() here waits for an event that module evaluation itself blocks.
if (primary) void start().catch(error => {
  console.error('[ego-linux-host] Browser host startup failed:', String(error.message).slice(0, 500));
  app.exit(1);
});
else app.quit();
