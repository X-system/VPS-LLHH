import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve,sep } from 'node:path';
import { createDecipheriv,randomUUID } from 'node:crypto';
import { openStore } from '../src/store.mjs';
import { configureBark,barkStatus,barkPayload,enqueueEvent,dispatchEvents,validateBark } from '../src/bark.mjs';
import { exportBackup,previewBackup,importBackup,newCredentials } from '../src/backup.mjs';

async function fixture(t,clock=Date.now) {
  const directory=mkdtempSync(join(tmpdir(),'vps-panel-test-backup-'));
  const store=await openStore({directory,password:'local-backup-test-password',clock});
  t.after(()=>{store.close();const path=resolve(directory);assert.ok(path.startsWith(resolve(tmpdir())+sep));assert.ok(path.split(sep).at(-1).startsWith('vps-panel-test-backup-'));rmSync(path,{recursive:true,force:true});});
  return store;
}
function addUser(store) {
  const id=randomUUID(),credentials=newCredentials();
  store.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)').run(id,'测试用户',1,'["hy2","vmess"]','["att"]',1073741824,null,store.seal(JSON.stringify(credentials)),store.clock());
  return {id,credentials};
}
test('Bark配置加密保存，不回显Key；URL和加密密钥检查',async t=>{
  const store=await fixture(t);
  const config={server:'https://bark.example.invalid',deviceKey:'test-device-key',encryptionKey:'12345678901234567890123456789012'};
  const status=configureBark(store,config);
  assert.equal(status.deviceKey,undefined);assert.equal(status.encryptionKey,undefined);
  assert.ok(!store.get('bark').includes(config.deviceKey));
  assert.equal(barkStatus(store).encrypted,true);
  for(const server of ['http://example.invalid','https://user:pass@example.invalid','https://example.invalid?secret=key'])assert.throws(()=>validateBark({...config,server}));
  assert.throws(()=>validateBark({...config,encryptionKey:'wrong'}));
});
test('Bark加密载荷与官方CBC协议兼容，入口只在密文中',()=>{
  const config={server:'https://bark.example.invalid',deviceKey:'test-device-key',encryptionKey:'1234567890123456'};
  const message={title:'入口更新',body:'打开新入口',url:'https://panel.example.invalid/private-entrance/',sensitive:true};
  const payload=barkPayload(config,message);
  assert.ok(!JSON.stringify(payload.body).includes('private-entrance'));
  const decipher=createDecipheriv('aes-128-cbc',Buffer.from(config.encryptionKey),Buffer.from(payload.body.iv));
  const data=JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.body.ciphertext,'base64')),decipher.final()]).toString());
  assert.equal(data.url,message.url);
  assert.throws(()=>barkPayload({...config,encryptionKey:''},message));
});
test('推送去重、冷却、退避与最多5次重试；不发送真实通知',async t=>{
  let now=1700000000000;const store=await fixture(t,()=>now);
  configureBark(store,{server:'https://bark.example.invalid',deviceKey:'test-device-key'});
  const id=enqueueEvent(store,'service.failed',{body:'测试异常'});
  assert.ok(id);assert.equal(enqueueEvent(store,'service.failed',{body:'重复'}),null);
  let requests=0;
  const fetchImpl=async()=>{requests++;throw new Error('mock failure');};
  await dispatchEvents(store,{fetchImpl});
  assert.equal(requests,1);
  await dispatchEvents(store,{fetchImpl});assert.equal(requests,1);
  for(let count=0;count<5;count++){now+=2*3600000;await dispatchEvents(store,{fetchImpl});}
  assert.equal(requests,5);
  assert.equal(store.db.prepare('SELECT status FROM events WHERE id=?').get(id).status,'failed');
});
test('完整Bark链接自动提取Key及服务地址，示例消息和参数不进入配置；留空保留已保存链接',async t=>{
 const store=await fixture(t),key='test-device-key-only';
 const status=configureBark(store,{pushUrl:'  https://bark.example.invalid/'+key+'/示例标题/示例内容?group=demo#ignored  '});
 assert.equal(status.server,'https://bark.example.invalid');assert.ok(!JSON.stringify(status).includes(key));
 const saved=JSON.parse(store.unseal(store.get('bark')));assert.equal(saved.deviceKey,key);assert.equal(saved.pushUrl,undefined);assert.ok(!JSON.stringify(saved).includes('示例'));
 configureBark(store,{pushUrl:'',events:['service.failed']});assert.equal(JSON.parse(store.unseal(store.get('bark'))).deviceKey,key);
 configureBark(store,{pushUrl:'https://other.example.invalid/new-device-key'});assert.equal(JSON.parse(store.unseal(store.get('bark'))).deviceKey,'new-device-key');
 for(const pushUrl of['https://bark.example.invalid','https://bark.example.invalid/short','https://user:pass@bark.example.invalid/'+key,'http://bark.example.invalid/'+key,'https://bark.example.invalid/bad%2Fkey-here'])assert.throws(()=>configureBark(store,{pushUrl}));
 assert.equal(JSON.parse(store.unseal(store.get('bark'))).deviceKey,'new-device-key','错误输入不覆盖已有通道');
});

test('未配置加密只提醒入口变化且不泄露地址；配置后发送加密入口并标记服务受理',async t=>{
  const store=await fixture(t);
  configureBark(store,{server:'https://bark.example.invalid',deviceKey:'test-device-key'});
  store.rotateEntrance();let requests=0;const payloads=[];
  const fetchImpl=async(url,options)=>{requests++;payloads.push(JSON.parse(options.body));assert.ok(!options.body.includes(store.get('entrance').value));return {ok:true,json:async()=>({code:200})};};
  await dispatchEvents(store,{fetchImpl,origin:'https://panel.example.invalid'});assert.equal(requests,1);
  assert.equal(payloads[0].url,undefined);assert.ok(!JSON.stringify(payloads[0]).includes('panel.example.invalid'));
  assert.equal(store.db.prepare('SELECT status FROM events').get().status,'accepted');
  configureBark(store,{encryptionKey:'1234567890123456'});
  store.rotateEntrance();await dispatchEvents(store,{fetchImpl,origin:'https://panel.example.invalid'});assert.equal(requests,2);
  assert.equal(typeof payloads[1].ciphertext,'string');assert.equal(payloads[1].url,undefined);
  assert.ok(store.db.prepare('SELECT status FROM events').all().every(row=>row.status==='accepted'));
});
test('普通配置不含凭证；完整备份加密、错误密码与篡改拒绝',async t=>{
  const store=await fixture(t),user=addUser(store);
  configureBark(store,{server:'https://bark.example.invalid',deviceKey:'test-device-key'});
  const ordinary=exportBackup(store);
  assert.equal(ordinary.users[0].credentials,undefined);assert.equal(ordinary.bark,undefined);
  assert.ok(!JSON.stringify(ordinary).includes(user.credentials.hy2));
  const full=exportBackup(store,{full:true,password:'separate-backup-password'});
  assert.ok(!JSON.stringify(full).includes(user.credentials.hy2));
  assert.throws(()=>previewBackup(full,{password:'wrong-long-password'}));
  const preview=previewBackup(full,{password:'separate-backup-password'});assert.equal(preview.users,1);assert.equal(preview.hasCredentials,true);
  const damaged={...full,tag:Buffer.alloc(16).toString('base64')};assert.throws(()=>previewBackup(damaged,{password:'separate-backup-password'}));
});
test('导入先校验再原子应用，保持停机；搬家保留用户凭证，复制重新生成',async t=>{
  const source=await fixture(t),destination=await fixture(t);
  const user=addUser(source);
  source.applyTraffic({userId:user.id,stream:'hy2.att',epoch:'a',up:100,down:200});
  const backup=exportBackup(source,{full:true,password:'separate-backup-password'});
  const originalEntrance=destination.get('entrance').value,identity=destination.get('identity');
  assert.throws(()=>importBackup(destination,backup,{password:'separate-backup-password'}));
  importBackup(destination,backup,{password:'separate-backup-password',mode:'move',confirmed:true});
  let row=destination.db.prepare('SELECT * FROM users').get();
  assert.equal(row.id,user.id);assert.equal(JSON.parse(destination.unseal(row.credentials)).hy2,user.credentials.hy2);
  assert.equal(destination.get('runtime').maintenance,true);
  assert.equal(destination.get('entrance').value,originalEntrance);assert.equal(destination.get('identity'),identity);
  assert.equal(destination.db.prepare('SELECT down FROM totals').get().down,200);
  importBackup(destination,backup,{password:'separate-backup-password',mode:'clone',confirmed:true});
  row=destination.db.prepare('SELECT * FROM users').get();
  assert.notEqual(row.id,user.id);assert.notEqual(JSON.parse(destination.unseal(row.credentials)).hy2,user.credentials.hy2);
  const bad=exportBackup(source);bad.users[0].protocols=['anytls'];
  assert.throws(()=>importBackup(destination,bad,{confirmed:true}));
  assert.equal(destination.db.prepare('SELECT id FROM users').get().id,row.id);
});
