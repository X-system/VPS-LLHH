import test from'node:test';
import assert from'node:assert/strict';
import{X509Certificate,randomUUID}from'node:crypto';
import{mkdtempSync,rmSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import https from'node:https';
import{openStore}from'../src/store.mjs';
import{createPairing}from'../src/pairing.mjs';
import{decodeInvite,pairingRequest,pairingPath}from'../src/pairing-transport.mjs';

import{certificate}from'./tls-fixture.mjs';
import{wgKeys}from'../src/network.mjs';
const tls=certificate();
test('出口已有同名不同身份中转机时，双方均提示重名，尚未创建请求或更改网络',async t=>{
 const f=await fixture(t),existing={name:'中转一号',publicKey:Buffer.alloc(32,7).toString('base64'),address:'10.76.0.9'};
 const config={privateKey:wgKeys().privateKey,physicalInterface:'eth0',address:'10.76.0.1',listenPort:51820,peers:[existing]};f.exit.store.set('network-config',f.exit.store.seal(JSON.stringify(config)));
 const invite=await f.relay.pairing.action({action:'invite'});
 await assert.rejects(f.exit.pairing.action({action:'connect',key:invite.key}),/已有名为中转一号的中转机，请更换命名/);
 assert.match(f.exit.pairing.view().error,/已有名为/);assert.match(f.relay.pairing.view().error,/已有名为/);assert.equal(f.relay.pairing.view().pending,null);assert.equal(f.exit.calls.filter(c=>c.action==='configure-network').length,0);
});
async function fixture(t){
 let now=Date.now();const stores=[],directories=[];const target=new Map();
 const transport=async(invite,payload)=>{const node=target.get(new URL(invite.url).hostname);if(!node)throw new Error('unknown fixture');return node.machine(invite.token,payload);};
 async function node(role,name,ip){
  const directory=mkdtempSync(join(tmpdir(),'vps-pair-')),store=await openStore({directory,password:'test-password',clock:()=>now});stores.push(store);directories.push(directory);store.set('settings',{...store.get('settings'),role,serverName:name});const calls=[],network={up:false};let stopToken=null,failUp=false;
  const request=async(action,data)=>{
   calls.push({action,data});
   if(Object.hasOwn(data||{},'expectedAutomationToken')&&data.expectedAutomationToken!==stopToken)throw new Error('已收到手动停止操作');
   if(action==='inspect')return{publicIPv4:ip,physicalInterface:'eth0',uids:{'vmess.att':900,'vmess.direct':901,'hy2.att':902,'hy2.direct':903},stopTokens:{automation:stopToken}};
   if(action==='plan-network')return{listenPort:role==='exit'?51874:51820};
   if(action==='status')return{desired:{},network:{up:network.up}};
   if(action==='network-down'){network.up=false;return{up:false};}
   if(action==='forget-network'){network.config=null;return{forgotten:true};}
   if(action==='configure-network'){network.config=data.config;network.up=false;return{configured:true};}
   if(action==='network-up'){if(failUp){failUp=false;throw new Error('测试中的隧道启动失败');}network.up=true;return{up:true};}
   throw new Error('Unexpected fixture action '+action);
  };
  const pairing=createPairing({store,request,origin:'https://'+ip+':18443',tls,transport});target.set(ip,pairing);return{store,pairing,calls,network,stop:()=>{stopToken='manual-stop';},failOnce:()=>{failUp=true;}};
 }
 const relay=await node('relay','中转一号','11.0.0.2'),exit=await node('exit','出口一号','11.0.0.3');
 t.after(()=>{for(const store of stores)store.close();for(const directory of directories)rmSync(directory,{recursive:true,force:true});});
 return{relay,exit,expire:()=>{now+=16*60000;}};
}
test('ATT邀请一次绑定、双方确认后才应用；仅交换公钥和自动生成网络参数',async t=>{
 const f=await fixture(t),invite=await f.relay.pairing.action({action:'invite'});
 await f.exit.pairing.action({action:'connect',key:invite.key});assert.equal(f.relay.network.config,undefined);assert.equal(f.exit.network.config,undefined);
 await f.exit.pairing.action({action:'poll'});assert.equal(f.exit.network.up,false);
 const pending=f.relay.pairing.view().pending;assert.equal(pending.name,'出口一号');
 await assert.rejects(f.relay.pairing.action({action:'approve',id:pending.id}),/确认/);
 await f.relay.pairing.action({action:'approve',id:pending.id,confirmed:true});assert.equal(f.relay.network.up,false);
 await f.exit.pairing.action({action:'poll'});assert.equal(f.exit.network.up,true);assert.equal(f.relay.network.up,true);
 assert.equal(f.relay.pairing.view().binding.name,'出口一号');assert.equal(f.exit.pairing.view().binding.name,'中转一号');
 assert.equal(f.relay.network.config.address,'10.76.0.2');assert.equal(f.exit.network.config.address,'10.76.0.1');assert.equal(f.exit.network.config.peers[0].address,'10.76.0.2');
 const exposed=JSON.stringify(f.relay.pairing.view());assert.ok(!exposed.includes('privateKey'));assert.ok(!exposed.includes(decodeInvite(invite.key).token));
 const configured=f.exit.calls.filter(call=>call.action==='configure-network').length;await f.exit.pairing.action({action:'poll'});assert.equal(f.exit.calls.filter(call=>call.action==='configure-network').length,configured);
});
test('邀请过期、重复抢占、错误角色和总控密钥均拒绝',async t=>{
 const f=await fixture(t),invite=await f.relay.pairing.action({action:'invite'}),decoded=decodeInvite(invite.key);
 await f.exit.pairing.action({action:'connect',key:invite.key});
 const outgoing=JSON.parse(f.exit.store.unseal(f.exit.store.get('att-outgoing')));
 await assert.rejects(f.relay.pairing.machine(decoded.token,{action:'request',peer:{...outgoing.peer,id:randomUUID()}}),error=>error.status===404);
 await assert.rejects(f.exit.pairing.action({action:'invite'}),/中转/);
 assert.throws(()=>decodeInvite('CTRL1.'+invite.key.slice(5)),/ATT/);
 f.expire();await assert.rejects(f.exit.pairing.action({action:'poll'}),/过期/);
 await assert.rejects(f.relay.pairing.action({action:'approve',id:f.relay.pairing.view().pending?.id,confirmed:true}),/过期/);
});
test('最后确认响应失败可重试，不重复配置出口；人工停止阻止后续自动开启',async t=>{
 const f=await fixture(t),invite=await f.relay.pairing.action({action:'invite'});await f.exit.pairing.action({action:'connect',key:invite.key});await f.relay.pairing.action({action:'approve',id:f.relay.pairing.view().pending.id,confirmed:true});
 f.relay.failOnce();await assert.rejects(f.exit.pairing.action({action:'poll'}));assert.equal(f.exit.pairing.view().outgoing.state,'applied');
 const count=f.exit.calls.filter(call=>call.action==='configure-network').length;await f.exit.pairing.action({action:'poll'});assert.equal(f.exit.calls.filter(call=>call.action==='configure-network').length,count);
 const second=await f.relay.pairing.action({action:'invite'});await f.exit.pairing.action({action:'connect',key:second.key});await f.relay.pairing.action({action:'approve',id:f.relay.pairing.view().pending.id,confirmed:true});f.exit.stop();await assert.rejects(f.exit.pairing.action({action:'poll'}));
});
test('真实HTTPS传输固定证书指纹；指纹错误时不发送密钥，拒绝私网目标和重定向',async t=>{
 let received=0;const server=https.createServer(tls,async(req,res)=>{received++;assert.equal(req.url,pairingPath);assert.equal(req.headers.authorization,'Bearer '+'a'.repeat(40));res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const target={url:'https://127.0.0.1:'+server.address().port+pairingPath,fingerprint:new X509Certificate(tls.cert).fingerprint256.replaceAll(':','').toLowerCase(),token:'a'.repeat(40)};
 assert.deepEqual(await pairingRequest(target,{action:'test'},{allowLocal:true}),{ok:true});
 await assert.rejects(pairingRequest({...target,fingerprint:'0'.repeat(64)},{action:'test'},{allowLocal:true}));assert.equal(received,1);
 await assert.rejects(pairingRequest(target,{action:'test'}),/公网/);assert.equal(received,1);
 assert.throws(()=>decodeInvite('ATT1.'+Buffer.from(JSON.stringify({...target,url:'http://127.0.0.1'+pairingPath})).toString('base64url')),/有效/);
});

test('解除配对撤销本地信任和旧邀请，出口仅删除指定中转，不清除其他配对',async t=>{
 const f=await fixture(t),invite=await f.relay.pairing.action({action:'invite'}),decoded=decodeInvite(invite.key);
 await f.exit.pairing.action({action:'connect',key:invite.key});await f.relay.pairing.action({action:'approve',id:f.relay.pairing.view().pending.id,confirmed:true});await f.exit.pairing.action({action:'poll'});
 const peer=f.exit.network.config.peers[0],other={...peer,name:'另一个中转',publicKey:Buffer.alloc(32,7).toString('base64'),address:'10.76.0.8'};
 const config=JSON.parse(f.exit.store.unseal(f.exit.store.get('network-config')));config.peers.push(other);f.exit.store.set('network-config',f.exit.store.seal(JSON.stringify(config)));
 await assert.rejects(f.exit.pairing.action({action:'disconnect',publicKey:peer.publicKey}),/确认/);
 await f.exit.pairing.action({action:'disconnect',publicKey:peer.publicKey,confirmed:true});assert.deepEqual(f.exit.network.config.peers.map(row=>row.name),['另一个中转']);assert.equal(f.exit.network.up,true);
 await f.relay.pairing.action({action:'disconnect',confirmed:true});assert.equal(f.relay.store.get('network-config'),null);assert.equal(f.relay.pairing.view().binding,null);assert.equal(f.relay.network.up,false);
 await assert.rejects(f.relay.pairing.machine(decoded.token,{action:'request',peer:{}}),error=>error.status===404);
});
