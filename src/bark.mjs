import { createCipheriv,randomBytes,randomUUID } from 'node:crypto';
import { HttpError } from './validation.mjs';

export const eventTypes = {
  'entrance.rotated':'安全入口已更新','panel.changed':'管理连接已变更','login.failures':'登录失败过于频繁','user.quota':'用户流量接近额度',
  'user.spike':'用户流量异常消耗','user.bandwidth':'用户长期占用带宽','host.bandwidth':'线路持续高占用',
  'host.cpu':'CPU 持续高占用','host.memory':'内存持续高占用','host.disk':'磁盘空间不足',
  'service.failed':'服务异常','tunnel.failed':'隧道异常','certificate.failed':'证书续签失败',
  'repair.started':'正在尝试修复','repair.succeeded':'修复成功','repair.failed':'自动修复失败',
  'maintenance.failed':'维护操作失败','bark.test':'推送通道测试'
};
export function parseBarkLink(value){
  if(typeof value!=='string'||value.trim().length>4096)throw new HttpError(400,'请粘贴Bark提供的完整推送链接');
  let link;try{link=new URL(value.trim());}catch{throw new HttpError(400,'Bark推送链接格式不正确');}
  if(link.username||link.password)throw new HttpError(400,'Bark推送链接不能包含登录凭证');
  const path=link.pathname.split('/').filter(Boolean);let deviceKey;
  try{deviceKey=decodeURIComponent(path[0]||'');}catch{throw new HttpError(400,'Bark推送链接格式不正确');}
  if(!/^[A-Za-z0-9_-]{8,256}$/.test(deviceKey))throw new HttpError(400,'链接中没有有效推送Key，请复制 https://服务地址/推送Key 形式的链接');
  return{server:link.origin,deviceKey};
}
export function validateBark(input,{allowLocalHttp=false}={}) {
  if (!input || typeof input!=='object' || Array.isArray(input)) throw new HttpError(400,'Bark 配置格式不正确');
  if(input.pushUrl!==undefined&&typeof input.pushUrl!=='string')throw new HttpError(400,'Bark推送链接格式不正确');
  if(input.pushUrl?.trim())input={...input,...parseBarkLink(input.pushUrl)};
  let endpoint;try {endpoint=new URL(input.server);}catch{throw new HttpError(400,'Bark 服务地址不正确');}
  const local=['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname);
  if ((endpoint.protocol!=='https:' && !(allowLocalHttp&&local&&endpoint.protocol==='http:')) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new HttpError(400,'Bark 必须使用无附加凭证的 HTTPS 地址');
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(input.deviceKey||'')) throw new HttpError(400,'Bark 设备 Key 格式不正确');
  const encryptionKey=input.encryptionKey||'';
  if (encryptionKey && ![16,32].includes(Buffer.byteLength(encryptionKey))) throw new HttpError(400,'Bark 加密密钥必须为16或32字节');
  const events=input.events??Object.keys(eventTypes).filter(event=>event!=='bark.test');
  if (!Array.isArray(events) || events.some(event=>!Object.hasOwn(eventTypes,event))) throw new HttpError(400,'事件配置不正确');
  return {server:endpoint.href.replace(/\/$/,''),deviceKey:input.deviceKey,encryptionKey,events:[...new Set(events)]};
}
export function barkPayload(config,message) {
  const payload={title:message.title,body:message.body,group:message.group||'服务器管理',...(message.url?{url:message.url}:{})};
  if (!config.encryptionKey) {
    if (message.sensitive) throw new Error('包含安全入口的通知必须配置 Bark 加密');
    return {url:config.server+'/push',body:{device_key:config.deviceKey,...payload}};
  }
  // Bark interprets iv as a 16-byte UTF-8 string, not a hexadecimal byte array.
  const iv=randomBytes(12).toString('base64url');
  const cipher=createCipheriv(`aes-${Buffer.byteLength(config.encryptionKey)*8}-cbc`,Buffer.from(config.encryptionKey),Buffer.from(iv));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]).toString('base64');
  return {url:config.server+'/'+encodeURIComponent(config.deviceKey),body:{ciphertext,iv}};
}
export async function sendBark(config,message,{fetchImpl=fetch}={}) {
  const request=barkPayload(config,message);
  const response=await fetchImpl(request.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/json'},body:JSON.stringify(request.body)});
  if (!response.ok) throw new Error('Bark 服务未接受请求');
  const data=await response.json();
  if (data.code!==200) throw new Error('Bark 服务返回失败');
  return {accepted:true}; // Server acceptance is not proof of delivery to a phone.
}

export function configureBark(store,input,options={}) {
  const current=store.get('bark');
  const prior=current?JSON.parse(store.unseal(current)):{};
  const next=validateBark({...prior,...input,deviceKey:input.deviceKey||prior.deviceKey,encryptionKey:input.encryptionKey===undefined?prior.encryptionKey:input.encryptionKey},options);
  store.set('bark',store.seal(JSON.stringify(next)));store.audit('更新 Bark 配置');
  return barkStatus(store);
}
export function barkStatus(store) {
  const encoded=store.get('bark');
  if (!encoded) return {configured:false,encrypted:false,events:[],availableEvents:eventTypes};
  const config=JSON.parse(store.unseal(encoded));
  return {configured:true,server:config.server,encrypted:!!config.encryptionKey,events:config.events,availableEvents:eventTypes};
}
export function enqueueEvent(store,type,data,{cooldown=30*60000,key=type}={}) {
  if (!Object.hasOwn(eventTypes,type)) throw new Error('未知事件类型');
  const encoded=store.get('bark');
  const config=encoded?JSON.parse(store.unseal(encoded)):null;
  if (config && !config.events.includes(type) && type!=='bark.test') return null;
  const now=store.clock();
  const last=store.get('event-cooldowns')||{};
  if (last[key]!==undefined && now-last[key]<cooldown) return null;
  return store.transaction(()=>{
    const id=randomUUID();
    store.db.prepare('INSERT INTO events(id,at,type,payload) VALUES(?,?,?,?)').run(id,now,type,store.seal(JSON.stringify(data)));
    last[key]=now;
    // Bound diagnostic cooldown entries independently from event retention.
    const cutoff=now-7*86400000;
    const recent=Object.entries(last).filter(([,at])=>at>=cutoff).slice(-4096);
    store.set('event-cooldowns',Object.fromEntries(recent));return id;
  });
}
export async function dispatchEvents(store,{fetchImpl=fetch,origin,max=5}={}) {
  const encoded=store.get('bark');if(!encoded)return;
  const config=JSON.parse(store.unseal(encoded));
  const rows=store.db.prepare("SELECT * FROM events WHERE status='pending' AND attempts<5 AND next_at<=? ORDER BY at LIMIT ?").all(store.clock(),max);
  for (const row of rows) {
    if (!config.events.includes(row.type) && row.type!=='bark.test') {store.db.prepare("UPDATE events SET status='disabled' WHERE id=?").run(row.id);continue;}
    const data=JSON.parse(store.unseal(row.payload));
    const sensitive=row.type==='entrance.rotated'||row.type==='panel.changed'&&typeof data.url==='string';
    if(row.type==='entrance.rotated'&&data.entrance!==store.get('entrance').value||row.type==='panel.changed'&&data.origin&&origin&&data.origin!==origin){store.db.prepare("UPDATE events SET status='superseded' WHERE id=?").run(row.id);continue;}
    const includeAddress=sensitive&&!!config.encryptionKey&&!!origin;
    const name=store.get('settings').serverName;
    const message={title:`【${name}】${eventTypes[row.type]}`,body:sensitive?(includeAddress?'管理入口已更新，点击打开新入口。':'管理入口已更新，请通过SSH应急菜单查看当前地址。'):String(data.body||'请登录面板查看详情。'),group:name,sensitive:includeAddress,
      ...(includeAddress?{url:row.type==='entrance.rotated'?new URL('/'+data.entrance+'/',origin).href:new URL('/'+store.get('entrance').value+'/',data.origin).href}:{})};
    try {
      await sendBark(config,message,{fetchImpl});
      store.db.prepare("UPDATE events SET status='accepted',attempts=attempts+1 WHERE id=?").run(row.id);
    } catch {
      const attempts=row.attempts+1;
      store.db.prepare('UPDATE events SET attempts=?,status=?,next_at=? WHERE id=?').run(attempts,attempts>=5?'failed':'pending',store.clock()+[60000,300000,1800000,3600000,3600000][attempts-1],row.id);
      store.audit('Bark 推送未受理',{type:row.type,attempts});
    }
  }
}
