import{digest}from'./security.mjs';
import{HttpError}from'./validation.mjs';
import{pairingRequest,decodeInvite}from'./pairing-transport.mjs';

export const relayEventTypes=new Set(['service.failed','tunnel.failed','upstream.disconnected','certificate.failed','maintenance.failed']);
function load(store){const value=store.get('notification-peers');return value?JSON.parse(store.unseal(value)):[];}
function active(store,peer){const encoded=store.get('network-config');const network=encoded?JSON.parse(store.unseal(encoded)):{};return(network.peers||[]).some(p=>p.publicKey===peer.publicKey);}
export function registerNotificationPeer(store,{id,name,publicKey,target,key}){
 const checked=decodeInvite('ATT1.'+Buffer.from(JSON.stringify({...target,token:key})).toString('base64url'));
 if(typeof id!=='string'||id.length>64||typeof name!=='string'||name.length>48)throw new Error('通知对端信息错误');
 const peers=load(store).filter(p=>active(store,p)&&p.id!==id);
 peers.push({id,name,publicKey,target:checked,inboundHash:digest(key)});
 store.set('notification-peers',store.seal(JSON.stringify(peers.slice(-254))));
}
export function notificationRelayStatus(store){return{peers:load(store).filter(p=>active(store,p)).map(p=>({name:p.name})),usesOriginalRecipient:true};}
export async function delegateNotification(store,event,{transport=pairingRequest,allowLocal=false}={}){
 for(const peer of load(store).filter(p=>active(store,p))){
  if(store.get('notification-profiles')?.enabled===false)return{accepted:false};
  try{const result=await transport(peer.target,{action:'notification',...event},{allowLocal});if(result?.accepted===true){store.audit('故障告警已由配对服务器代发',{eventId:event.eventId,peer:peer.name});return{accepted:true};}}
  catch{}store.audit('配对服务器未确认代发',{eventId:event.eventId,peer:peer.name});
 }
 store.audit('故障告警所有代发路径均未受理',{eventId:event.eventId});return{accepted:false};
}
export async function receiveNotification(store,key,payload,{fetchImpl=fetch}={}){
 const peer=load(store).find(p=>p.inboundHash===digest(key)&&active(store,p));
 if(!peer)throw new HttpError(404,'Not found');
 if(!relayEventTypes.has(payload.type)||!/^[-a-f0-9]{36}$/.test(payload.eventId||'')||JSON.stringify(payload).length>12000)throw new HttpError(400,'代发请求错误');
 const encoded=store.get('bark');if(!encoded)return{accepted:false};const config=JSON.parse(store.unseal(encoded)),request=payload.request;
 // A peer cannot choose arbitrary destinations or turn this into an HTTP proxy.
 if(!request||typeof request.url!=='string'||!request.body||typeof request.body!=='object'||Array.isArray(request.body))throw new HttpError(400,'代发请求错误');
 const url=new URL(request.url),base=new URL(config.server),tail=url.pathname.slice(base.pathname.replace(/\/$/,'').length);
 if(!url.pathname.startsWith(base.pathname.replace(/\/$/,'')+'/')||url.origin!==base.origin||url.username||url.password||url.search||url.hash||!(tail==='/push'||/^\/[A-Za-z0-9_-]{8,256}$/.test(tail)))throw new HttpError(400,'代发仅允许对端已配置的Bark服务');
 const keys=Object.keys(request.body),encrypted=typeof request.body.ciphertext==='string';
 if(keys.some(k=>!(encrypted?['ciphertext','iv']:['device_key','title','body','group']).includes(k))||keys.some(k=>typeof request.body[k]!=='string')||encrypted&&(!/^[A-Za-z0-9+/=]+$/.test(request.body.ciphertext)||request.body.iv?.length!==16)||!encrypted&&!/^[A-Za-z0-9_-]{8,256}$/.test(request.body.device_key||''))throw new HttpError(400,'代发消息格式错误');
 const receiptKey='notification-receipts',now=store.clock(),receipts=store.get(receiptKey)||{},id=peer.id+':'+payload.eventId;
 if(receipts[id]?.accepted)return{accepted:true};
 if(receipts[id]?.at&&now-receipts[id].at<60000)return{accepted:false};
 const recent=Object.values(receipts).filter(r=>r.peer===peer.id&&now-r.at<60000);if(recent.length>=3)return{accepted:false};
 receipts[id]={peer:peer.id,at:now,accepted:false};store.set(receiptKey,Object.fromEntries(Object.entries(receipts).filter(([,r])=>now-r.at<7*86400000).slice(-2048)));
 try{
  const response=await fetchImpl(request.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/json'},body:JSON.stringify(request.body)});
  if(!response.ok||(await response.json()).code!==200)throw new Error();
  const current=store.get(receiptKey)||{};current[id]={peer:peer.id,at:now,accepted:true};store.set(receiptKey,current);store.audit('已代发配对服务器故障告警',{peer:peer.name,eventId:payload.eventId});return{accepted:true};
 }catch{store.audit('配对服务器故障告警代发未受理',{peer:peer.name,eventId:payload.eventId});return{accepted:false};}
}
