import{DatabaseSync}from'node:sqlite';
import{readFileSync}from'node:fs';
import{join}from'node:path';
import{chown}from'node:fs/promises';
import{decrypt}from'./security.mjs';
import{buildRelayConfigs}from'./core-config.mjs';
import{streams}from'./access.mjs';
import{atomicWrite}from'./system-driver.mjs';
import{tripped}from'./safety-fuses.mjs';

if(process.platform!=='linux'||process.getuid()!==0)throw new Error('核心启动校验必须由root运行');
const stream=process.argv[2];if(!streams.includes(stream))throw new Error('线路标识错误');
const directory='/etc/vps-panel',data='/var/lib/vps-panel';
if(tripped(directory,'emergency')||tripped(directory,stream))throw new Error('安全锁已停止该线路');
const config=JSON.parse(readFileSync(join(directory,'system.json')));
if(config.emergencyStop||!config.desired?.[stream])throw new Error('服务已手动停止或急停锁定');
const db=new DatabaseSync(join(data,'panel.sqlite'),{readOnly:true});
const key=readFileSync(join(data,'master.key'));
try{
 const get=name=>{const row=db.prepare('SELECT value FROM config WHERE key=?').get(name);return row?JSON.parse(row.value):null;};
 const runtime=get('runtime');if(!runtime||runtime.maintenance||runtime.emergencyStop||get('settings')?.role!=='relay')throw new Error('维护或急停状态禁止启动');
 const users=db.prepare('SELECT u.*,COALESCE(t.up,0) AS up,COALESCE(t.down,0) AS down FROM users u LEFT JOIN totals t ON t.user_id=u.id').all().map(row=>({...row,enabled:!!row.enabled,protocols:JSON.parse(row.protocols),exits:JSON.parse(row.exits),credentials:JSON.parse(decrypt(row.credentials,key))}));
 const generated=buildRelayConfigs(config.relay,users)[stream];
 if(stream.startsWith('hy2'))generated.tls={...generated.tls,cert:`/run/credentials/vps-panel-${stream.replace('.','-')}.service/fullchain.pem`,key:`/run/credentials/vps-panel-${stream.replace('.','-')}.service/privkey.pem`};
 const identities=JSON.parse(readFileSync(join(directory,'identities.json'))),uid=identities[stream];
 if(!Number.isInteger(uid)||uid<100||uid>60000)throw new Error('服务身份错误');
 const runtimeConfig=`/run/vps-panel-core-${stream.replace('.','-')}/config.json`;
 await atomicWrite(runtimeConfig,JSON.stringify(generated));await chown(runtimeConfig,uid,-1);
}finally{key.fill(0);db.close();}
