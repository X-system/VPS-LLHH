import test from'node:test';
import assert from'node:assert/strict';
import{mkdtempSync,rmSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{randomUUID}from'node:crypto';
import{openStore}from'../src/store.mjs';

import{configureBark,enqueueEvent,dispatchEvents}from'../src/bark.mjs';
import{registerNotificationPeer,delegateNotification,receiveNotification,notificationRelayStatus}from'../src/notification-relay.mjs';
import{exportBackup,importBackup}from'../src/backup.mjs';

async function fixture(t){const directory=mkdtempSync(join(tmpdir(),'vps-notifications-'));let now=1800000000000;const store=await openStore({directory,password:'network-test-password',clock:()=>now});t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});configureBark(store,{pushUrl:'https://api.day.app/originalDeviceKey'});return{store,advance(ms){now+=ms;}};}
function peers(store,n=5){const rows=Array.from({length:n},(_,i)=>({id:randomUUID(),name:'对端'+i,publicKey:'key'+i,target:{url:'https://11.0.0.'+(i+2)+':18443/node-link/att',fingerprint:'a'.repeat(64)},key:String(i).repeat(43)}));store.set('network-config',store.seal(JSON.stringify({peers:rows.map(p=>({publicKey:p.publicKey}))})));for(const row of rows)registerNotificationPeer(store,row);return rows;}
test('顺序尝试五个对端，收到Bark受理才停止；全失败记录，不泄露密钥',async t=>{
 const{store}=await fixture(t);const rows=peers(store),seen=[];
 const event={eventId:randomUUID(),type:'tunnel.failed',request:{url:'https://api.day.app/push',body:{device_key:'originalDeviceKey',title:'网络异常',body:'出站连接失败'}}};
 assert.deepEqual(await delegateNotification(store,event,{transport:async target=>{const i=rows.findIndex(p=>p.key===target.token);seen.push(i);if(i===0)throw Error('not reachable');return{accepted:i===2};}}),{accepted:true});assert.deepEqual(seen,[0,1,2]);
 seen.length=0;assert.deepEqual(await delegateNotification(store,event,{transport:async target=>{seen.push(target.token);return{accepted:false};}}),{accepted:false});assert.equal(seen.length,5);
 assert.ok(!JSON.stringify(notificationRelayStatus(store)).includes(rows[0].key));assert.ok(!JSON.stringify(store.db.prepare('SELECT detail FROM audit').all()).includes(rows[0].key));
});
test('代发认证、固定Bark目的地、原收件人、幂等和解除配对即时撤权，不形成转发环',async t=>{
 const{store}=await fixture(t);const[p]=peers(store,1);let sent=0;
 const payload={action:'notification',eventId:randomUUID(),type:'tunnel.failed',request:{url:'https://api.day.app/push',body:{device_key:'otherOriginalRecipient',title:'故障',body:'测试'}}};
 const fetchImpl=async(url,options)=>{sent++;assert.equal(url,'https://api.day.app/push');assert.equal(JSON.parse(options.body).device_key,'otherOriginalRecipient');assert.equal(options.redirect,'error');return{ok:true,json:async()=>({code:200})};};
 await assert.rejects(receiveNotification(store,'bad',payload,{fetchImpl}),/Not found/);
 await assert.rejects(receiveNotification(store,p.key,{...payload,request:{...payload.request,url:'https://internal.invalid/push'}},{fetchImpl}),/Bark/);
 assert.deepEqual(await receiveNotification(store,p.key,payload,{fetchImpl}),{accepted:true});assert.deepEqual(await receiveNotification(store,p.key,payload,{fetchImpl}),{accepted:true});assert.equal(sent,1);
 store.set('network-config',null);await assert.rejects(receiveNotification(store,p.key,{...payload,eventId:randomUUID()},{fetchImpl}),/Not found/);assert.equal(sent,1);
});
test('故障告警直发失败后代发，受理和全部失败分别持久保存，不持续轮询失败链',async t=>{
 const{store}=await fixture(t);const id=enqueueEvent(store,'tunnel.failed',{body:'网络检测失败'});let delegated=0;
 await dispatchEvents(store,{fetchImpl:async()=>{throw Error('offline');},delegate:async event=>{delegated++;assert.equal(event.eventId,id);assert.equal(event.request.body.device_key,'originalDeviceKey');return{accepted:true};}});
 assert.equal(store.db.prepare('SELECT status FROM events WHERE id=?').get(id).status,'accepted');assert.equal(delegated,1);
 const failed=enqueueEvent(store,'tunnel.failed',{body:'又一次故障'},{key:'second'});await dispatchEvents(store,{fetchImpl:async()=>{throw Error();},delegate:async()=>({accepted:false})});assert.equal(store.db.prepare('SELECT status FROM events WHERE id=?').get(failed).status,'failed');
 await dispatchEvents(store,{fetchImpl:async()=>{throw Error('must not retry');},delegate:async()=>{throw Error('must not retry');}});
});
