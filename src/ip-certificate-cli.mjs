import{readFile}from'node:fs/promises';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
import{isIP}from'node:net';
import{issueIpCertificate,installIpMaterial}from'./ip-certificate.mjs';
import{createFirewall}from'./firewall.mjs';
const run=promisify(execFile),mode=process.argv[2];
if(process.platform!=='linux'||process.getuid()!==0||!['--initial','--renew'].includes(mode))throw Error('IP证书只能由服务器安装或续签任务管理');
const env=Object.fromEntries((await readFile('/etc/vps-panel/web.env','utf8')).split('\n').filter(s=>/^[A-Z_]+=/.test(s)).map(s=>{const at=s.indexOf('=');return[s.slice(0,at),s.slice(at+1)];}));
const origin=new URL(env.VPS_ORIGIN);let state={};try{state=JSON.parse(await readFile('/etc/vps-panel/system.json','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
const ip=new URL(state.initialOrigin||origin.origin).hostname;if(isIP(ip)!==4)throw Error('未找到面板初始公网IP');
let info;try{info=JSON.parse(await readFile('/etc/vps-panel/certs/ip/status.json','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
if(mode==='--renew'&&info?.ip===ip&&info.notAfter-Date.now()>72*3600000)process.exit(0);
await issueIpCertificate({ip,firewall:createFirewall()});
if(!state.panelUseAcme){await installIpMaterial({ip});if(mode==='--renew'){await run('/usr/bin/systemctl',['restart','vps-panel-web']);}}
else{const{copyFile}=await import('node:fs/promises');for(const name of['fullchain','privkey'])await copyFile('/etc/vps-panel/certs/ip/'+name+'.pem','/etc/vps-panel/certs/panel-initial/panel-'+name+'.pem');}
console.log('受信任IP证书已就绪；自动续期由系统任务管理。');
