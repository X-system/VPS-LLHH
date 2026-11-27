import{readFile,writeFile,rename,unlink,lstat}from'node:fs/promises';
import{join}from'node:path';
import{release}from'node:os';
import{randomBytes}from'node:crypto';

const keys=['net.ipv4.tcp_congestion_control','net.core.default_qdisc','net.ipv4.tcp_mtu_probing'];
const modes=['off','bbr','bbrx'];
const config='/etc/sysctl.d/99-vps-panel-tcp.conf',legacy='/etc/sysctl.d/99-bbrx-manager.conf';
export function createTcpAcceleration({directory='/etc/vps-panel',coreDirectory='/usr/local/lib/vps-panel',runner,kernel=release,read=readFile,write=writeFile,move=rename,remove=unlink,stat=lstat}={}){
 const path=join(directory,'tcp-acceleration.json');
 const call=(binary,args,timeout=30000)=>runner(binary,args,{timeout,maxBuffer:1024*1024,windowsHide:true});
 async function state(){try{return JSON.parse(await read(path,'utf8'));}catch(e){if(e.code==='ENOENT')return{mode:'off'};throw e;}}
 async function save(value){const tmp=path+'.'+randomBytes(8).toString('hex')+'.tmp';try{await write(tmp,JSON.stringify(value),{mode:0o600,flag:'wx'});await move(tmp,path);}finally{await remove(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
 async function sysctl(key){return(await call('/usr/sbin/sysctl',['-n',key])).stdout.trim();}
 async function support(){let os='';try{os=await read('/etc/os-release','utf8');}catch{}return /^ID=debian$/m.test(os)&&/^VERSION_ID="?12"?$/m.test(os)&&/^6\.1\./.test(kernel());}
 async function status(){let current=await state();if(current.job?.state==='running'&&Date.now()-current.job.started>5000){try{await call('/usr/bin/systemctl',['is-active','--quiet','vps-panel-tcp-apply.service']);}catch{current={...current,job:{state:'failed',message:'配置任务已中断，请重新选择；当前生效算法见下方'}};await save(current);}}const effective=await sysctl(keys[0]);return{mode:current.baseline?current.mode||'off':['bbr','bbrx'].includes(effective)?effective:'off',effective,available:(await sysctl('net.ipv4.tcp_available_congestion_control')).split(/\s+/),bbrxSupported:await support(),job:current.job||null,experimental:true};}
 async function owned(file,marker){try{const s=await stat(file);if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)||!(await read(file,'utf8')).split('\n').includes(marker))throw new Error('发现其他程序的同名加速配置，未覆盖，请查看诊断');return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
 async function baseline(current){if(current.baseline)return current;const values={};for(const key of keys)values[key]=await sysctl(key);return{...current,baseline:values};}
 async function disableVendor(){if(await owned('/usr/local/sbin/bbrx','# managed-by: bbrx-oneclick'))await call('/usr/local/sbin/bbrx',['disable-boot']);if(await owned(legacy,'# managed-by: bbrx-manager'))await remove(legacy);}
 async function apply(mode,current,{boot=false}={}){
  await owned(config,'# managed-by: vps-panel-tcp');await owned(legacy,'# managed-by: bbrx-manager');
  if(mode==='bbrx'&&!boot){
   if(!await support())throw new Error('BBRX实验版仅支持Debian 12与Linux 6.1内核');
   const available=(await sysctl('net.ipv4.tcp_available_congestion_control')).split(/\s+/);
   if(!available.includes('bbrx'))await call('/bin/bash',[join(coreDirectory,'app/scripts/bbrx-oneclick.sh'),'install'],1800000);
  }
  await disableVendor();
  if(mode!=='off')await call('/usr/sbin/modprobe',['tcp_bbr']);let selected=mode==='off'?'cubic':mode;
  if(mode==='bbrx')try{await call('/usr/sbin/modprobe',['tcp_bbrx']);}catch(e){if(!boot)throw e;selected='bbr';}
  const values={[keys[0]]:selected,[keys[1]]:mode==='off'?current.baseline?.[keys[1]]||'fq_codel':'fq',[keys[2]]:mode==='bbrx'?'1':current.baseline?.[keys[2]]||'0'};
  await write(config,'# managed-by: vps-panel-tcp\n'+keys.map(key=>key+' = '+values[key]).join('\n')+'\n',{mode:0o644});
  for(const key of keys)await call('/usr/sbin/sysctl',['-w',key+'='+values[key]]);
  if(await sysctl(keys[0])!==selected)throw new Error('TCP加速未通过生效检查');
  await call('/usr/bin/systemctl',['enable','vps-panel-tcp-acceleration.service']);
 }
 async function configure(mode){
  if(!modes.includes(mode))throw new Error('请选择关闭、BBR或BBRX');
  const current=await state();if(current.job?.state==='running')throw new Error('TCP加速正在配置，请等待完成');
  if(mode==='bbrx'&&!await support())throw new Error('BBRX实验版仅支持Debian 12与Linux 6.1内核');
  await save({...current,job:{state:'running',target:mode,started:Date.now()}});
  try{await call('/usr/bin/systemctl',['enable','vps-panel-tcp-acceleration.service']);await call('/usr/bin/systemd-run',['--unit=vps-panel-tcp-apply','--collect','--property=RuntimeMaxSec=1900','--property=UMask=0077','--property=StandardOutput=journal','--property=StandardError=journal','--','/usr/bin/flock','--exclusive','--nonblock',join(directory,'tcp-acceleration.lock'),join(coreDirectory,'runtime/bin/node'),join(coreDirectory,'app/src/tcp-acceleration-cli.mjs'),mode]);}
  catch(e){await save({...current,job:{state:'failed',message:'无法启动TCP加速配置任务'}});throw e;}
  return status();
 }
 async function execute(mode,{boot=false}={}){
  if(!modes.includes(mode))throw new Error('TCP加速模式错误');
  let current=await state();const interrupted=boot&&current.job?.state==='running';
  if(boot){if(current.job?.state==='running'){current={...current,job:{state:'failed',message:'上次配置被中断，请重新选择'}};await save(current);}mode=current.mode||'off';}
  if(boot&&mode==='off'&&!current.baseline){await save({...current,mode:'off',job:null});return status();}
  const previouslyManaged=!!current.baseline;current=await baseline(current);await save(current);
  try{await apply(mode,current,{boot});await save({...current,mode,job:interrupted?{state:'failed',message:'上次配置被中断，已恢复上次选择',finished:Date.now()}:{state:'done',finished:Date.now()}});}
  catch(e){let restored=true;try{if(previouslyManaged)await apply(current.mode||'off',current,{boot:true});else{await restore();current.mode=['bbr','bbrx'].includes(current.baseline[keys[0]])?current.baseline[keys[0]]:'off';}}catch{restored=false;}
   await save({...current,job:{state:'failed',message:restored?'配置失败，已恢复上次设置；可查看TCP加速日志':'配置失败且未能完整恢复，请查看TCP加速日志'}});throw e;}
  return status();
 }
 async function restore(){const current=await state();if(!current.baseline)return;await owned(config,'# managed-by: vps-panel-tcp');await disableVendor();for(const key of keys){const value=current.baseline[key];if(typeof value!=='string'||!/^[a-zA-Z0-9_ ]{1,128}$/.test(value))throw new Error('加速恢复参数错误');await call('/usr/sbin/sysctl',['-w',key+'='+value]);}if(await owned(config,'# managed-by: vps-panel-tcp'))await remove(config);await call('/usr/bin/systemctl',['disable','vps-panel-tcp-acceleration.service']);await save({mode:'off'});}
 return{status,configure,execute,restore};
}
