let current;
let language = localStorage.getItem('ego-linux-language') || 'zh';
const words = {
  zh: {spaces:'任务空间',agent:'Agent 正在控制',human:'你正在控制',take:'接管',release:'交还智能体',compat:'SDK 兼容版 · 独立 Linux 实现',welcome:'独立任务空间，同一沙箱桌面。',help:'输入网址开始浏览，或让智能体使用 ego-browser 操作。',new:'新的空间',newtab:'新标签页',tls:'证书校验失败，请检查网站或镜像信任链；未绕过证书校验。',failed:'页面加载失败，请检查网址和网络。'},
  en: {spaces:'SPACES',agent:'Agent in control',human:'You are in control',take:'Take over',release:'Return to agent',compat:'SDK compatible · Independent Linux host',welcome:'Independent spaces. One sandbox desktop.',help:'Enter an address, or let your agent use ego-browser.',new:'New space',newtab:'New tab',tls:'Certificate verification failed. Check the site or image trust store; verification remains enabled.',failed:'Page could not load. Check the address and network.'},
};
const t = key => words[language][key];
const el = id => document.getElementById(id);
const overviewWords = {
  zh: {all:'所有空间',help:'选择一个空间，查看智能体的页面和操作进展。空间各自保留标签页和站点数据。',back:'返回当前空间',running:'Agent 运行中',human:'你正在控制',paused:'已暂停',manual:'你的空间',idle:'等待智能体继续',completed:'已完成',awaiting_user:'等待接管',preview:'页面预览正在更新',tabs:'个标签页'},
  en: {all:'All spaces',help:'Choose a space to see its pages and agent activity. Each space keeps its own tabs and site data.',back:'Return to current space',running:'Agent running',human:'You are in control',paused:'Paused',manual:'Your space',idle:'Waiting for agent',completed:'Completed',awaiting_user:'Waiting for takeover',preview:'Updating page preview',tabs:'tabs'},
};
const ot = key => overviewWords[language][key];
const cards = new Map();
function activity(space, state) {
  if (state.desktopHuman) return space.id === state.activeSpaceId ? 'human' : 'paused';
  if (space.running) return 'running';
  if (['completed','awaiting_user'].includes(space.taskStatus)) return space.taskStatus;
  return space.ownership === 'user' ? (space.createdBy === 'agent' ? 'human' : 'manual') : 'idle';
}
function renderOverview(state, selected) {
  document.body.classList.toggle('overview-open',state.overviewOpen);
  el('overview').hidden=!state.overviewOpen;
  el('spaces-toggle').textContent=String(state.spaces.length);
  el('spaces-toggle').setAttribute('aria-expanded',String(state.overviewOpen));
  el('spaces-toggle').setAttribute('aria-label',ot('all')+' · '+state.spaces.length);
  el('overview-title').textContent=state.spaces.length+' '+(language==='zh'?'个空间':'Spaces');
  el('overview-help').textContent=ot('help');el('overview-back').textContent=ot('back');
  el('space-name').textContent=selected?.name||'';
  el('space-state').textContent=selected?ot(activity(selected,state)):'';
  el('space-state').className=selected?'activity '+activity(selected,state):'activity';
  el('space-action').textContent=selected?.running?selected.action:'';
  const live = new Set(state.spaces.map(space=>space.id));
  for(const [id,card] of cards)if(!live.has(id)){card.node.remove();cards.delete(id);}
  let position=0;
  for(const space of state.spaces){
    let card=cards.get(space.id);
    if(!card){
      const node=button('',()=>act('select-space',space.id),'space-card');
      const preview=document.createElement('div');preview.className='space-preview';
      const image=document.createElement('img');image.draggable=false;
      const placeholder=document.createElement('div');placeholder.className='preview-placeholder';
      preview.append(image,placeholder);
      const caption=document.createElement('div');caption.className='space-caption';
      const title=document.createElement('strong');const badge=document.createElement('span');
      const detail=document.createElement('small');const tabs=document.createElement('small');tabs.className='space-count';
      caption.append(title,badge,detail,tabs);node.append(preview,caption);
      card={node,image,placeholder,title,badge,detail,tabs};cards.set(space.id,card);
    }
    const page=space.tabs.find(tab=>tab.id===space.activeTabId);
    const key=activity(space,state);
    card.node.classList.toggle('selected',space.id===state.activeSpaceId);
    card.node.classList.toggle('running',key==='running');
    card.node.setAttribute('aria-label',space.name+' · '+ot(key)+' · '+(page?.title||t('newtab')));
    card.title.textContent=space.name;card.badge.textContent=ot(key);card.badge.className='activity '+key;
    card.detail.textContent=page?.title||t('newtab');card.tabs.textContent=space.tabs.length+' '+ot('tabs');
    card.image.alt=space.name+' · '+(page?.title||t('newtab'));
    card.image.hidden=!space.preview;card.placeholder.hidden=!!space.preview;
    card.placeholder.textContent=page?.url&&page.url!=='about:blank'?ot('preview'):'＋';
    if(space.preview&&card.image.getAttribute('src')!==space.preview)card.image.src=space.preview;
    const grid=el('space-grid');if(grid.children[position]!==card.node)grid.insertBefore(card.node,grid.children[position]??null);position++;
  }
  let add=el('add-space-card');
  if(!add){add=button('＋',()=>act('new-space',t('new')+' '+((current?.spaces.length??0)+1)),'space-card add-space-card');add.id='add-space-card';}
  add.setAttribute('aria-label',language==='zh'?'新建空间':'New space');if(el('space-grid').lastElementChild!==add)el('space-grid').append(add);
}
async function act(action, value) {
  try { await window.egoDesktop.act(action, value); } catch (error) { el('notice').textContent = String(error.message).slice(0,200); }
}
function button(text, action, className='') {
  const node = document.createElement('button'); node.textContent=text;node.className=className;node.onclick=action;return node;
}
function render(state) {
  current=state; const space=state.spaces.find(s=>s.id===state.activeSpaceId); const page=space?.tabs.find(p=>p.id===space.activeTabId);
  renderOverview(state,space);
  el('spaces-title').textContent=t('spaces');el('compatibility').textContent=t('compat');
  const human=state.desktopHuman||space?.ownership==='user';
  el('status').textContent=human?t('human'):space?.running?t('agent'):ot(space?activity(space,state):'idle');el('control').textContent=t(human?'release':'take');
  el('control').disabled=state.desktopHuman;el('control').title=state.desktopHuman?(language==='zh'?'请在 host 桌面面板交还控制权':'Return control from the host desktop panel'):'';
  el('language').textContent=language==='zh'?'EN':'中';
  el('spaces').replaceChildren();
  for(const item of state.spaces){
    const node=button('',()=>act('select-space',item.id),'space'+(item.id===state.activeSpaceId?' active':''));
    const dot=document.createElement('span');dot.className='dot';const body=document.createElement('span');body.textContent=item.name;
    const detail=document.createElement('small');detail.textContent=ot(activity(item,state))+' · '+item.tabs.length+' '+ot('tabs');body.append(detail);node.append(dot,body);el('spaces').append(node);
  }
  el('tabs').replaceChildren();
  for(const tab of space?.tabs??[]){
    const wrapper=document.createElement('div');wrapper.className='tab'+(tab.id===space.activeTabId?' active':'');
    wrapper.append(button(tab.title||t('newtab'),()=>act('select-tab',tab.id),'title'),button('×',()=>act('close-tab',tab.id),'close'));
    el('tabs').append(wrapper);
  }
  if(document.activeElement!==el('address'))el('address').value=page?.url==='about:blank'?'':page?.url??'';
  el('security').style.color=page?.url?.startsWith('https:')?'#8fbb9b':'#9aacc5';
  el('notice').textContent=page?.error?(page.error.includes('CERT')?t('tls'):t('failed')):'';
  el('welcome').style.display=page?.url&&page.url!=='about:blank'?'none':'flex';
  el('welcome-text').textContent=t('welcome');el('welcome-help').textContent=t('help');
}
el('new-space').onclick=()=>act('new-space',t('new')+' '+((current?.spaces.length??0)+1));
el('spaces-toggle').onclick=()=>act('overview');
el('overview-back').onclick=()=>act('close-overview');
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&current?.overviewOpen)void act('close-overview');});
el('new-tab').onclick=()=>act('new-tab');
el('control').onclick=()=>act('control');
el('back').onclick=()=>act('back');el('forward').onclick=()=>act('forward');el('reload').onclick=()=>act('reload');
el('address-form').onsubmit=event=>{event.preventDefault();void act('navigate',el('address').value);};
el('language').onclick=()=>{language=language==='zh'?'en':'zh';localStorage.setItem('ego-linux-language',language);if(current)render(current);};
window.egoDesktop.onState(render);window.egoDesktop.state().then(render);
