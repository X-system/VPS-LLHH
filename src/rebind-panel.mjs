import{readFile,unlink}from'node:fs/promises';
import{join,resolve}from'node:path';
import{fileURLToPath}from'node:url';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
import{atomicWrite,createSystemDriver}from'./system-driver.mjs';
import{managementHealth}from'./management-health.mjs';
import{parseWebEnvironment}from'./panel-network.mjs';
import{createFirewall}from'./firewall.mjs';

export async function executeRebind({root='/etc/vps-panel',restart,health=managementHealth,notify=async()=>{},firewall=createFirewall(),syncGuard=()=>createSystemDriver({directory:root}).syncPanelGuard()}){
 const request=JSON.parse(await readFile(join(root,'panel-rebind-request.json'),'utf8'));
 if(!/^panel-backup-[a-f0-9]{20}$/.test(request.backup))throw new Error('管理连接回退标识错误');
 const record=value=>atomicWrite(join(root,'panel-rebind-state.json'),JSON.stringify({...value,at:Date.now()}));
 async function cleanFirewall(){
  const env=parseWebEnvironment(await readFile(join(root,'web.env'),'utf8'));
  await firewall.removeOwned(['vps-panel-web'],{keepPorts:env.VPS_HOST==='0.0.0.0'?[Number(env.VPS_PORT)]:[]});
 }
 try{
  try{await restart();await syncGuard();await health();}
  catch{
   try{
    const backup=join(root,request.backup);
    await atomicWrite(join(root,'web.env'),await readFile(join(backup,'web.env')));
    for(const name of['panel-fullchain.pem','panel-privkey.pem'])await atomicWrite(join(root,'certs',name),await readFile(join(backup,name)));
    const state=JSON.parse(await readFile(join(root,'system.json'),'utf8')),previous=JSON.parse(await readFile(join(backup,'state.json'),'utf8'));
    await atomicWrite(join(root,'system.json'),JSON.stringify({...state,...previous}));
    await restart();await syncGuard();await health();
   }catch{await record({ok:false,rolledBack:false,needsRecovery:true});throw new Error('新旧管理连接均未通过自检，请通过SSH恢复面板');}
   let firewallCleanupFailed=false;try{await cleanFirewall();}catch{firewallCleanupFailed=true;}
   await record({ok:false,rolledBack:true,firewallCleanupFailed});return{ok:false,rolledBack:true};
  }
  // Notification or old-rule cleanup failure must not undo an already healthy connection.
  let notificationFailed=false,firewallCleanupFailed=false;
  try{await cleanFirewall();}catch{firewallCleanupFailed=true;}
  try{await notify(request.origin);}catch{notificationFailed=true;}
  await record({ok:true,origin:request.origin,notificationFailed,firewallCleanupFailed});return{ok:true};
 }finally{await unlink(join(root,'maintenance.lock')).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.platform!=='linux'||process.getuid()!==0)throw new Error('管理连接变更必须由root运行');
 const run=promisify(execFile);
 const result=await executeRebind({
  restart:async()=>{await run('/usr/bin/systemctl',['reset-failed','vps-panel-web.service'],{timeout:15000,windowsHide:true});await run('/usr/bin/systemctl',['restart','vps-panel-web.service'],{timeout:30000,windowsHide:true});},
  notify:origin=>run('/usr/sbin/runuser',['-u','vps-panel','--','/usr/local/lib/vps-panel/runtime/bin/node','/usr/local/lib/vps-panel/app/src/panel-event.mjs',origin],{timeout:20000,windowsHide:true})
 });
 if(!result.ok){console.error('管理连接变更自检失败，已恢复原连接。');process.exitCode=1;}
}
