import{readFile,lstat,realpath,rm,unlink}from'node:fs/promises';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
import{createSystemDriver}from'./system-driver.mjs';
import{createFirewall}from'./firewall.mjs';
import{serviceUnits}from'./service-units.mjs';
import{ownsRouteRule}from'./network.mjs';

if(process.platform!=='linux'||process.getuid()!==0)throw new Error('卸载程序只能由Linux的root运行');
const mode=process.argv[2];if(!['--purge-data','--keep-data'].includes(mode))throw new Error('必须明确选择保留或清除数据');
const roots=['/usr/local/lib/vps-panel','/etc/vps-panel','/var/lib/vps-panel'];
for(const target of roots){const stat=await lstat(target);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(target)!==target)throw new Error('程序目录不安全，已停止卸载');}
const execute=promisify(execFile),run=(binary,args)=>execute(binary,args,{timeout:30000,maxBuffer:1024*1024,windowsHide:true});
const state=JSON.parse(await readFile('/etc/vps-panel/system.json','utf8'));
const identities=JSON.parse(await readFile('/etc/vps-panel/identities.json','utf8'));
const accounts=JSON.parse(await readFile('/etc/vps-panel/accounts.json','utf8'));
let networkRuntime={};try{networkRuntime=JSON.parse(await readFile('/etc/vps-panel/network-runtime.json','utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const driver=createSystemDriver();
// Guard the data plane first, while all helpers are still present.
await driver.action('emergency-stop');
await run('/usr/bin/systemctl',['stop','vps-panel-tcp-apply.service']).catch(error=>{if(error.code!==5)throw error;});
const{createTcpAcceleration}=await import('./tcp-acceleration.mjs');await createTcpAcceleration({runner:execute}).restore();
for(const unit of Object.keys(serviceUnits())){await run('/usr/bin/systemctl',['disable',unit]);await run('/usr/bin/systemctl',['stop',unit]);}
await createFirewall().removeOwned();
for(const[family,table]of[['inet','vps_panel_guard'],['inet','vps_panel_forward'],['ip','vps_panel_nat']]){
 try{await run('/usr/sbin/nft',['list','table',family,table]);await run('/usr/sbin/nft',['delete','table',family,table]);}catch(error){if(error.code!==1)throw error;}
}
for(const priority of[11000,11100,11101,11102,11103]){
 const rules=JSON.parse((await run('/usr/sbin/ip',['-j','rule','show'])).stdout);
 if(rules.some(rule=>rule.priority===priority&&!ownsRouteRule(rule,[identities['vmess.att'],identities['hy2.att']])))continue;
 try{await run('/usr/sbin/ip',['rule','delete','pref',String(priority),'protocol','196']);}catch(error){if(error.code!==2)throw error;}
}
if((networkRuntime.forwardPrior??state.forwardPrior)===0&&state.network){
 const interfaces=JSON.parse((await run('/usr/sbin/ip',['-j','link','show'])).stdout);
 if(interfaces.every(item=>['lo',state.network.physicalInterface].includes(item.ifname)))await run('/usr/sbin/sysctl',['-w','net.ipv4.ip_forward=0']);
 else console.log('其他接口可能仍需转发，保留当前IP转发设置。');
}
for(const unit of Object.keys(serviceUnits())){
 await unlink('/etc/systemd/system/'+unit).catch(error=>{if(error.code!=='ENOENT')throw error;});
 await rm('/etc/systemd/system/'+unit+'.d',{recursive:true,force:true});
}
await run('/usr/bin/systemctl',['daemon-reload']);
await unlink('/usr/local/bin/vps-panel').catch(error=>{if(error.code!=='ENOENT')throw error;});
// The running process has already loaded its code. Only fixed, verified roots are removed.
await rm('/usr/local/lib/vps-panel',{recursive:true,force:true});
if(mode==='--purge-data')for(const target of['/etc/vps-panel','/var/lib/vps-panel'])await rm(target,{recursive:true,force:true});
// Keep disabled nologin identities with retained data to preserve ownership on restore.
if(mode==='--purge-data'){
 for(const[stream,uid]of Object.entries(identities)){
  if(!['vmess.att','vmess.direct','hy2.att','hy2.direct'].includes(stream))continue;
  const name='vps-panel-'+stream.replace('.','-');
  try{const actual=Number((await run('/usr/bin/id',['-u',name])).stdout.trim());if(actual===uid)await run('/usr/sbin/userdel',[name]);}catch(error){if(error.code!==1&&error.code!==6)throw error;}
 }
 const panelUid=Number((await run('/usr/bin/id',['-u','vps-panel'])).stdout.trim());
 if(panelUid!==accounts['vps-panel']?.uid)throw new Error('管理账户身份发生变化，拒绝删除');
 await run('/usr/sbin/userdel',['vps-panel']);
 for(const[name,account]of Object.entries(accounts)){
  if(!['vps-panel','vps-panel-vmess-att','vps-panel-vmess-direct','vps-panel-hy2-att','vps-panel-hy2-direct'].includes(name))continue;
  try{const line=(await run('/usr/bin/getent',['group',name])).stdout.trim().split(':');if(Number(line[2])===account.gid&&!line[3])await run('/usr/sbin/groupdel',[name]);}catch(error){if(error.code!==2&&error.code!==6&&error.code!==8)throw error;}
 }
}
console.log(mode==='--purge-data'?'面板及运行数据已清除；系统共享依赖未删除。':'面板已卸载，账户与加密运行数据已保留；重新安装请使用--restore。');
await unlink('/etc/vps-panel/maintenance.lock').catch(error=>{if(error.code!=='ENOENT')throw error;});
