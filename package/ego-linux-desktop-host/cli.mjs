#!/usr/bin/env node
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root=path.dirname(fileURLToPath(import.meta.url));
const argv=process.argv.slice(2);
if(argv[0]==='skill'){
  process.stdout.write(fs.readFileSync(path.join(root,'sdk/ego-browser/SKILL.md'),'utf8'));
  process.stdout.write('\n'+fs.readFileSync(path.join(root,'COMPATIBILITY.md'),'utf8'));
  process.exit(0);
}
if(argv[0]==='--version'){
  process.stdout.write('ego-browser Linux reference host 0.2.3; upstream SDK 2.2.0\n');process.exit(0);
}
const inline=argv.length===3&&['-e','--eval'].includes(argv[1]);
if(argv[0]!=='nodejs'||(argv.length!==1&&!inline)){
  process.stderr.write('Usage: ego-browser skill | ego-browser --version | ego-browser nodejs [-e script] <<\'JS\' ... JS\n');process.exit(2);
}
const launch=spawnSync('/usr/bin/python3',[path.join(root,'start-browser.py'),'--prepare'],{encoding:'utf8',timeout:47000,maxBuffer:16384});
if(launch.status!==0){process.stderr.write('Linux browser startup failed: '+String(launch.stderr||launch.error?.message||'launcher exited unexpectedly').slice(0,1000));process.exit(1);}
const config=JSON.parse(launch.stdout);
process.env.EGO_BROWSER_STATE_DIR=config.stateDir;
globalThis.EGO_BROWSER_OUTPUT_DIR=config.outputDir;
let nextId=1,selectedSpace,selectedTarget;
let buffer='';
const pending=new Map();
const socket=net.createConnection(config.socketPath);
await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
socket.setEncoding('utf8');
socket.on('data',chunk=>{
  buffer+=chunk;
  if(buffer.length>32*1024*1024){socket.destroy(new Error('Browser response exceeded the host limit'));return;}
  let index;
  while((index=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,index);buffer=buffer.slice(index+1);let value;
    try{value=JSON.parse(line);}catch{socket.destroy(new Error('Invalid browser response'));return;}
    if(value.kind==='cdp'){
      try{globalThis.ego?.onCDPMessage?.(JSON.stringify(value.message));}catch{}
    }else{
      const request=pending.get(value.id);if(!request)continue;pending.delete(value.id);clearTimeout(request.timer);
      if(value.error)request.reject(Object.assign(new Error(value.error.message),{error_code:value.error.error_code}));else request.resolve(value.result);
    }
  }
});
socket.on('error',()=>{});
socket.once('close',()=>{for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('Browser host disconnected'));}pending.clear();});
function call(method,args=[]){
  return new Promise((resolve,reject)=>{
    const id=nextId++;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Browser host request timed out: '+method));},30000);
    pending.set(id,{resolve,reject,timer});
    socket.write(JSON.stringify({id,method,args,spaceId:selectedSpace,targetId:selectedTarget})+'\n');
  });
}
const ego={};
for(const method of ['getBrowserVersion','listProfiles','listTaskSpaces','createTaskSpace','claimTaskSpace','createTab','listTabs','snapshot','handOffTaskSpace','takeOverTaskSpace','completeTaskSpace','closeTaskSpace','animationHighlightMouseToPosition','setAgentTaskState']){
  ego[method]=async(...args)=>{
    const result=await call(method,args);
    if(['createTaskSpace','claimTaskSpace'].includes(method)){selectedSpace=result.id;selectedTarget=undefined;}
    if(method==='createTab')selectedTarget=result.targetId;
    return result;
  };
}
ego.useTaskSpace=id=>{if(!Number.isSafeInteger(id))throw TypeError('Task-space id must be an integer');selectedSpace=id;selectedTarget=undefined;return id;};
ego.sendCDPMessage=message=>{
  const packet=JSON.parse(message);
  void call('cdp',[packet]).then(response=>{
    if(!response.error&&packet.method==='Target.activateTarget')selectedTarget=packet.params.targetId;
    ego.onCDPMessage?.(JSON.stringify(response));
  },error=>ego.onSendCDPMessageError?.(message,error.error_code??'EGO_CDP_SEND_FAILED'));
};
// Used only by the narrowly patched Linux clipboard branch of the pinned SDK.
ego.beginClipboardTransaction=async input=>{
  const transaction=await call('clipboard.begin',[input]);
  return {finish:()=>call('clipboard.finish',[transaction.id])};
};
globalThis.ego=ego;
try{
  const host=await call('getBrowserVersion');
  if(!/^linux-host:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(host.browserInstanceId??''))throw new Error('Browser host instance identity is unavailable');
  ego.browserInstanceId=host.browserInstanceId;
  const sdk=await import('./sdk/index.js');
  sdk.installEgoSdk(globalThis);
  try{process.exitCode=await sdk.runMain({argv:[],...(inline?{stdinText:argv[2]}:{})});}finally{await sdk.disposeEgoSdk(globalThis);}
}catch(error){
  process.stderr.write(`${error.error_code?error.error_code+': ':''}${error.message}\n`);process.exitCode=1;
}finally{socket.end();}
