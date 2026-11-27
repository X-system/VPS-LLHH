import test from'node:test';
import assert from'node:assert/strict';
import{mkdtempSync,rmSync,readFileSync,existsSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{randomUUID}from'node:crypto';
import{openStore}from'../src/store.mjs';
import{ingestSnapshot}from'../src/collectors.mjs';
import{trafficPeriod}from'../src/line-usage.mjs';

test('已有数据库缺失主密钥时拒绝启动，不生成新密钥或修改数据库',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-key-recovery-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const store=await openStore({directory,password:'test-password'});store.close();
 const before=readFileSync(join(directory,'panel.sqlite'));rmSync(join(directory,'master.key'));
 await assert.rejects(openStore({directory}),/主密钥缺失/);assert.equal(existsSync(join(directory,'master.key')),false);
 assert.deepEqual(readFileSync(join(directory,'panel.sqlite')),before);
});

test('嵌套事务用保存点隔离失败，外层成功内容不会一并丢失',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-savepoint-')),store=await openStore({directory,password:'test-password'});t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 store.transaction(()=>{
  store.set('outer-first',1);
  assert.throws(()=>store.transaction(()=>{store.set('inner-failed',2);throw new Error('deliberate failure');}));
  store.set('outer-last',3);
 });
 assert.equal(store.get('outer-first'),1);assert.equal(store.get('inner-failed'),undefined);assert.equal(store.get('outer-last'),3);
});

test('整批采样中线路累计溢出时，前面用户的计数与线路累计也一起回退',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-atomic-traffic-')),store=await openStore({directory,password:'test-password'});t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const ids=[randomUUID(),randomUUID()],now=store.clock();
 for(const id of ids)store.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)').run(id,'测试',1,'["hy2"]','["att"]',null,null,'unused-test-value',now);
 const previous=Number.MAX_SAFE_INTEGER-5;store.db.prepare('INSERT INTO line_periods VALUES(?,?,?,?,?,?)').run(trafficPeriod(now).id,'hy2.att',previous,0,now,now);
 assert.throws(()=>ingestSnapshot(store,{stream:'hy2.att',epoch:'test',samples:ids.map(id=>({id,up:3,down:0,connections:1}))}),/精确计数/);
 assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM traffic').get().n,0);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM totals').get().n,0);
 assert.equal(store.db.prepare('SELECT up FROM line_periods').get().up,previous);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM user_presence').get().n,0);
});
