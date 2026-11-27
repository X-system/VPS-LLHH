import{execFile}from'node:child_process';
import{promisify}from'node:util';
if(process.platform!=='linux'||process.getuid()!==0)throw new Error('管理器断线保护必须由root运行');
const run=promisify(execFile),units=['vmess-att','vmess-direct','hy2-att','hy2-direct'].map(name=>'vps-panel-'+name+'.service');
// A lost privileged controller must not leave ungoverned quota-bearing proxies running.
await run('/usr/bin/systemctl',['kill','--kill-whom=all','--signal=SIGKILL',...units],{timeout:10000,windowsHide:true}).catch(()=>{});
await run('/usr/bin/systemctl',['--no-block','stop',...units],{timeout:10000,windowsHide:true});
