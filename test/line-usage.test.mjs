import test from'node:test';
import assert from'node:assert/strict';
import{mkdtempSync,rmSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{randomUUID}from'node:crypto';
import{openStore}from'../src/store.mjs';
import{lineUsage,trafficPeriod}from'../src/line-usage.mjs';
import{nodeSnapshot}from'../src/controller-contract.mjs';

test('线路累计跨核心和面板重启持久保存，重复样本不累计；用户记录变动不抹掉线路历史',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-line-usage-'));let now=Date.parse('2026-11-24T08:24:00Z'),store=await openStore({directory,password:'test-password',clock:()=>now});
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const id=randomUUID();store.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)').run(id,'测试',1,'["hy2"]','["att"]',null,null,'unused-test-value',now);
 const sample={userId:id,stream:'hy2.att',epoch:'first',up:100,down:200};
 store.applyTraffic(sample);store.applyTraffic(sample);store.close();store=await openStore({directory,clock:()=>now});
 store.applyTraffic({...sample,up:120,down:250});store.applyTraffic({...sample,epoch:'second',up:10,down:20});
 store.db.prepare('DELETE FROM users').run();const route=lineUsage(store).routes.find(item=>item.id==='att');
 assert.equal(route.uploadBytes,130);assert.equal(route.downloadBytes,270);assert.equal(route.state,'unknown');assert.equal(route.uploadBytesPerSecond,null);
 const snapshot=nodeSnapshot(store);assert.equal(snapshot.management.controllerImplemented,false);assert.equal(snapshot.remoteConfiguration,false);
 assert.ok(!JSON.stringify(snapshot).includes('unused-test-value'));assert.equal(snapshot.nodeId,store.get('identity'));
});

test('北京时间跨月开启新周期，保留旧周期；计数异常时用户与线路均不提前累计',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-line-period-'));let now=Date.parse('2026-11-30T15:59:00Z');const store=await openStore({directory,password:'test-password',clock:()=>now});
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const id=randomUUID();store.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)').run(id,'测试',1,'["hy2"]','["direct"]',null,null,'unused-test-value',now);
 const sample={userId:id,stream:'hy2.direct',epoch:'same',up:100,down:200};store.applyTraffic(sample);
 now+=60000;assert.equal(trafficPeriod(now).id,'2026-12');store.applyTraffic({...sample,up:150,down:250});
 assert.equal(lineUsage(store).routes.find(item=>item.id==='direct').uploadBytes,50);
 assert.equal(store.db.prepare("SELECT up FROM line_periods WHERE period='2026-11'").get().up,100);
 assert.throws(()=>store.applyTraffic({...sample,up:140,down:250}));
 assert.equal(lineUsage(store).routes.find(item=>item.id==='direct').uploadBytes,50);
 assert.equal(store.db.prepare('SELECT up FROM totals').get().up,150);
});
