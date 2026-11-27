import{execFile}from'node:child_process';
import{promisify}from'node:util';
import{createSystemDriver}from'./system-driver.mjs';
import{tripFuse}from'./safety-fuses.mjs';

if(process.platform!=='linux'||process.getuid()!==0)throw new Error('底层应急操作必须由root运行');
const action=process.argv[2];if(!['stop-all','emergency-stop'].includes(action))throw new Error('不支持的应急操作');
const run=promisify(execFile),units=['vmess-att','vmess-direct','hy2-att','hy2-direct'].map(name=>'vps-panel-'+name+'.service');
let persistenceFailed=false;
try{tripFuse('/etc/vps-panel','network');for(const name of['vmess.att','vmess.direct','hy2.att','hy2.direct'])tripFuse('/etc/vps-panel',name);if(action==='emergency-stop')tripFuse('/etc/vps-panel','emergency');}catch{persistenceFailed=true;}
// Bypass the web/agent entirely. A persistence error must not prevent issuing a stop.
await run('/usr/bin/systemctl',['stop',...units],{timeout:30000,windowsHide:true});
try{
 await run('/usr/sbin/runuser',['-u','vps-panel','--','/usr/local/lib/vps-panel/runtime/bin/node','--input-type=module','-e',`import{openStore}from'/usr/local/lib/vps-panel/app/src/store.mjs';const s=await openStore({directory:'/var/lib/vps-panel'});s.set('runtime',{...s.get('runtime'),maintenance:true,emergencyStop:${action==='emergency-stop'?'true':"!!s.get('runtime')?.emergencyStop"}});s.audit('通过SSH底层应急停止',{action:'${action}'});s.close();`],{timeout:20000,windowsHide:true});
}catch{persistenceFailed=true;}
try{await createSystemDriver().action(action);}catch{throw new Error('代理停止已下发，但底层状态未完整保存；请检查磁盘和本机日志');}
if(persistenceFailed)throw new Error('线路已停止，但面板中的维护状态未保存；请检查数据库与磁盘');
console.log(action==='emergency-stop'?'全部线路已停止并锁定急停，不依赖网页或管理器连接。':'全部线路已停止，停止状态已持久保存。');
