import{healthSettings,validateHealthSettings}from'./node-health.mjs';
import { randomBytes,scryptSync,createCipheriv,createDecipheriv,randomUUID } from 'node:crypto';
import { HttpError } from './validation.mjs';
import { settings as validateSettings,user as validateUser } from './validation.mjs';
import { validateBark } from './bark.mjs';
import { validateCertificateSettings } from './certificates.mjs';
import { exportAppearance,validateAppearance,configureAppearance } from './appearance.mjs';
import { alertRules,validateAlertRules } from './metrics.mjs';

const MAGIC='vps-panel-backup';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function exportUser(store,user,full){
 const output={name:user.name,enabled:!!user.enabled,protocols:JSON.parse(user.protocols),exits:JSON.parse(user.exits),quota:user.quota,expires:user.expires};
 if(full){output.id=user.id;output.credentials=JSON.parse(store.unseal(user.credentials));}return output;
}
function prepareUsers(input,preserve){
 if(!Array.isArray(input)||input.length>10000)throw new HttpError(400,'备份用户列表错误');
 const ids=new Set();return input.map(value=>{
  if(!value||typeof value!=='object')throw new HttpError(400,'备份用户格式错误');
  const checked=validateUser(Object.fromEntries(['name','enabled','protocols','exits','quota','expires'].map(key=>[key,value[key]])));
  const id=preserve?value.id:randomUUID();if(typeof id!=='string'||!UUID.test(id)||ids.has(id))throw new HttpError(400,'备份用户标识不正确或重复');ids.add(id);
  const credentials=preserve?value.credentials:newCredentials();
  if(!credentials||!UUID.test(credentials.vmess)||![credentials.hy2,credentials.subscription].every(value=>typeof value==='string'&&/^[A-Za-z0-9_-]{24,128}$/.test(value))||credentials.hy2LegacyAuth!==undefined&&typeof credentials.hy2LegacyAuth!=='boolean')throw new HttpError(400,'备份用户凭证格式错误');
  return{...checked,id,oldId:value.id,credentials};
 });
}
function prepareHistory(data,users){
 if(data.totals!==undefined&&!Array.isArray(data.totals)||data.presence!==undefined&&!Array.isArray(data.presence))throw new HttpError(400,'备份统计或在线历史格式错误');
 const ids=new Map(users.map(user=>[user.oldId,user.id])),seenTotals=new Set(),seenPresence=new Set();
 const totals=(data.totals||[]).map(row=>{
  const id=ids.get(row.user_id);if(!id||seenTotals.has(id)||![row.up,row.down,row.up+row.down].every(value=>Number.isSafeInteger(value)&&value>=0)||!(row.last_activity===null||Number.isSafeInteger(row.last_activity)&&row.last_activity>=0))throw new HttpError(400,'备份统计无效、重复或引用了未知用户');seenTotals.add(id);
  return{...row,user_id:id};
 });
 const presence=(data.presence||[]).map(row=>{const id=ids.get(row.user_id);if(!id||seenPresence.has(id)||!Number.isSafeInteger(row.seen)||row.seen<0)throw new HttpError(400,'在线历史无效或重复');seenPresence.add(id);return{user_id:id,seen:row.seen};});
 return{totals,presence};
}
function derive(password,salt) {
  if(typeof password!=='string'||password.length<12||password.length>128)throw new HttpError(400,'备份密码长度为12至128位');
  return scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
}
export function exportBackup(store,{password,full=false}={}) {
  const settings=store.get('settings');
  const users=store.db.prepare('SELECT * FROM users ORDER BY created').all().map(user=>exportUser(store,user,full));
  const data={format:MAGIC,version:1,kind:full?'full':'config',created:store.clock(),settings,users};
  data.healthMonitor={probeEnabled:healthSettings(store).probeEnabled};data.appearance=exportAppearance(store);data.alertRules=alertRules(store);
  const archived=store.get('role-archives');if(archived){data.roles={};for(const[role,snapshot]of Object.entries(JSON.parse(store.unseal(archived))))data.roles[role]={users:snapshot.users.map(user=>exportUser(store,user,full)),...(full?{totals:snapshot.totals,presence:snapshot.presence||[]}:{} )};}
  if(full) {
    data.totals=store.db.prepare('SELECT * FROM totals').all();
    data.presence=store.db.prepare('SELECT * FROM user_presence').all();
    const bark=store.get('bark');if(bark)data.bark=JSON.parse(store.unseal(bark));
    const certificate=store.get('certificate-settings');if(certificate)data.certificateSettings=JSON.parse(store.unseal(certificate));
  }
  store.audit('导出配置',{kind:data.kind});
  if(!full){if(Buffer.byteLength(JSON.stringify(data))>8*1024*1024)throw new HttpError(413,'配置超过8MB限制');return data;}
  const salt=randomBytes(16),iv=randomBytes(12),key=derive(password,salt);
  try {
    const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(MAGIC+':1'));
    const ciphertext=Buffer.concat([cipher.update(JSON.stringify(data),'utf8'),cipher.final()]);
    const output={format:MAGIC,version:1,encrypted:true,kdf:'scrypt-32768-8-1',salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),body:ciphertext.toString('base64')};
    if(Buffer.byteLength(JSON.stringify(output))>8*1024*1024)throw new HttpError(413,'完整备份超过8MB限制');return output;
  } finally {key.fill(0);}
}
export function readBackup(input,{password}={}) {
  if(!input||typeof input!=='object'||Array.isArray(input)||input.format!==MAGIC||input.version!==1)throw new HttpError(400,'不支持的备份格式或版本');
  if(Buffer.byteLength(JSON.stringify(input))>8*1024*1024)throw new HttpError(413,'备份文件过大');
  let data=input;
  if(input.encrypted) {
    if(input.kdf!=='scrypt-32768-8-1')throw new HttpError(400,'不支持的备份加密格式');
    const salt=Buffer.from(input.salt||'','base64'),iv=Buffer.from(input.iv||'','base64'),tag=Buffer.from(input.tag||'','base64');
    if(salt.length!==16||iv.length!==12||tag.length!==16)throw new HttpError(400,'备份加密参数损坏');
    const key=derive(password,salt);
    try {
      const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(Buffer.from(MAGIC+':1'));decipher.setAuthTag(tag);
      data=JSON.parse(Buffer.concat([decipher.update(Buffer.from(input.body||'','base64')),decipher.final()]).toString('utf8'));
    }catch{throw new HttpError(400,'备份密码错误或文件已损坏');}finally{key.fill(0);}
  }
  if(data.format!==MAGIC||data.version!==1||!['config','full'].includes(data.kind)||!Array.isArray(data.users)||data.users.length>10000)throw new HttpError(400,'备份内容格式不正确');
  if(data.kind==='full'&&!input.encrypted)throw new HttpError(400,'完整备份必须加密');
  return data;
}
export function previewBackup(input,options) {
  const data=readBackup(input,options);
  return {kind:data.kind,serverName:data.settings?.serverName,role:data.settings?.role,users:data.users.length,hasCredentials:data.kind==='full',hasBark:!!data.bark,hasCertificateSettings:!!data.certificateSettings,
    requiresConfirmation:['本机IP、网卡及域名解析','WireGuard重新配对','代理默认停止','管理入口和管理员账户不从备份恢复']};
}
export function newCredentials() {return {vmess:randomUUID(),hy2:randomBytes(32).toString('base64url'),subscription:randomBytes(32).toString('base64url')};}

export function importBackup(store,input,{password,mode='clone',confirmed=false,allowLocalHttp=false,validateOnly=false}={}) {
  if(!confirmed)throw new HttpError(409,'必须先预览并确认导入影响');
  if(!['clone','move'].includes(mode))throw new HttpError(400,'请选择复制或搬家模式');
  const data=readBackup(input,{password});
  if(!data.settings||!['relay','exit'].includes(data.settings.role))throw new HttpError(400,'备份角色不正确');
  const config=validateSettings(Object.fromEntries(['serverName','rotationDays','bandwidthMbps','logRetentionDays'].map(key=>[key,data.settings[key]])),store.get('settings'));
  const users=prepareUsers(data.users,mode==='move'&&data.kind==='full');
  if(data.settings.role==='exit'&&users.length)throw new HttpError(400,'出口机备份不应包含代理用户');
  let bark;
  if(data.bark&&data.kind==='full')bark=validateBark(data.bark,{allowLocalHttp});
  let certificateSettings;
  if(data.certificateSettings&&data.kind==='full')certificateSettings=validateCertificateSettings(data.certificateSettings);
  const healthMonitor=data.healthMonitor===undefined?null:validateHealthSettings(data.healthMonitor);
  const appearance=data.appearance?validateAppearance(data.appearance):null,rules=data.alertRules?validateAlertRules(data.alertRules):null;
  const{totals,presence}=prepareHistory(data,users),roleArchives={};
  if(data.roles!==undefined){
   if(!data.roles||typeof data.roles!=='object'||Array.isArray(data.roles)||Object.keys(data.roles).some(role=>!['relay','exit'].includes(role)))throw new HttpError(400,'角色归档格式错误');
   for(const[role,snapshot]of Object.entries(data.roles)){
    const archivedUsers=prepareUsers(snapshot.users,mode==='move'&&data.kind==='full'),history=prepareHistory(snapshot,archivedUsers);
    if(role==='exit'&&archivedUsers.length)throw new HttpError(400,'出口角色归档不能包含代理用户');
    roleArchives[role]={users:archivedUsers.map(user=>({id:user.id,name:user.name,enabled:Number(user.enabled),protocols:JSON.stringify(user.protocols),exits:JSON.stringify(user.exits),quota:user.quota,expires:user.expires,credentials:store.seal(JSON.stringify(user.credentials)),created:store.clock()})),...history,traffic:[],config:{}};
   }
  }
  if(validateOnly)return{role:data.settings.role,users:users.length};
  // Validate everything before modifying local state. Keep a locally encrypted rollback snapshot.
  const snapshot=JSON.stringify({config:store.db.prepare("SELECT * FROM config WHERE key!='last-import-rollback'").all(),appearance:exportAppearance(store),users:store.db.prepare('SELECT * FROM users').all(),totals:store.db.prepare('SELECT * FROM totals').all(),traffic:store.db.prepare('SELECT * FROM traffic').all(),presence:store.db.prepare('SELECT * FROM user_presence').all()});
  return store.transaction(()=>{
    store.set('last-import-rollback',store.seal(snapshot));
    store.db.exec('DELETE FROM traffic; DELETE FROM totals; DELETE FROM users;');
    for(const user of users)store.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)').run(user.id,user.name,Number(user.enabled),JSON.stringify(user.protocols),JSON.stringify(user.exits),user.quota,user.expires,store.seal(JSON.stringify(user.credentials)),store.clock());
    for(const row of totals)store.db.prepare('INSERT INTO totals VALUES(?,?,?,?)').run(row.user_id,row.up,row.down,row.last_activity);
    for(const row of presence)store.db.prepare('INSERT INTO user_presence VALUES(?,?)').run(row.user_id,row.seen);
    store.set('settings',{...config,role:data.settings.role,autoStart:false,autoRepair:false});
    store.set('runtime',{maintenance:true,emergencyStop:false});
    store.set('onboarded',true);
    if(appearance)configureAppearance(store,store.directory,appearance);
    if(rules)store.set('alert-rules',rules);if(healthMonitor)store.set('health-settings',healthMonitor);
    if(bark)store.set('bark',store.seal(JSON.stringify(bark)));
    store.set('certificate-settings',certificateSettings?store.seal(JSON.stringify(certificateSettings)):null);
    store.set('role-archives',Object.keys(roleArchives).length?store.seal(JSON.stringify(roleArchives)):null);
    store.audit('导入配置',{mode,users:users.length});
    return {ok:true,users:users.length,maintenance:true,requiresPairing:true};
  });
}

export function rollbackImport(store,{confirmed=false,validateOnly=false}={}){
 if(!confirmed)throw new HttpError(409,'请确认回退导入并停止当前服务');
 const encoded=store.get('last-import-rollback');if(!encoded)throw new HttpError(409,'没有可回退的导入记录');
 const snapshot=JSON.parse(store.unseal(encoded));
 const settings=JSON.parse(snapshot.config.find(row=>row.key==='settings').value);
 if(validateOnly)return{role:settings.role,users:snapshot.users.length};
 return store.transaction(()=>{
  store.db.exec('DELETE FROM traffic; DELETE FROM totals; DELETE FROM users;');
  store.db.exec("DELETE FROM config WHERE key NOT IN ('identity','entrance','last-import-rollback')");
  for(const row of snapshot.config)if(!['identity','entrance','last-import-rollback'].includes(row.key))store.set(row.key,JSON.parse(row.value));
  if(snapshot.appearance)configureAppearance(store,store.directory,snapshot.appearance);
  for(const row of snapshot.users)store.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)').run(row.id,row.name,row.enabled,row.protocols,row.exits,row.quota,row.expires,row.credentials,row.created);
  for(const row of snapshot.totals)store.db.prepare('INSERT INTO totals VALUES(?,?,?,?)').run(row.user_id,row.up,row.down,row.last_activity);
  for(const row of snapshot.traffic)store.db.prepare('INSERT INTO traffic VALUES(?,?,?,?,?,?)').run(row.user_id,row.stream,row.epoch,row.up,row.down,row.at);
  for(const row of snapshot.presence||[])store.db.prepare('INSERT INTO user_presence VALUES(?,?)').run(row.user_id,row.seen);
  store.set('runtime',{maintenance:true,emergencyStop:true});store.set('last-import-rollback',null);
  store.audit('回退最近一次导入，保持急停');return{ok:true,role:settings.role,users:snapshot.users.length,maintenance:true,emergencyStop:true};
 });
}
