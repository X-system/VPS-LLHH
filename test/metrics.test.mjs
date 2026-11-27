import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync}from'node:fs';
import{tmpdir}from'node:os';
import{join,resolve,sep}from'node:path';
import{openStore}from'../src/store.mjs';
import{evaluateRules}from'../src/metrics.mjs';

test('500Mbps线路按上下行分别判断，10分钟近满载才告警；支持采样抖动及冷却',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'vps-panel-test-metrics-'));let now=1700000000000;
  const store=await openStore({directory:dir,password:'test-local-only',clock:()=>now});
  t.after(()=>{store.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));assert.ok(resolve(dir).split(sep).at(-1).startsWith('vps-panel-test-metrics-'));rmSync(dir,{recursive:true,force:true});});
  for(let i=0;i<20;i++){evaluateRules(store,{uploadMbps:460,downloadMbps:100});now+=30137;}
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n,0);
  const ids=evaluateRules(store,{uploadMbps:460,downloadMbps:100});
  assert.equal(ids.length,1);
  const event=store.db.prepare('SELECT * FROM events').get();assert.equal(event.type,'host.bandwidth');
  assert.ok(store.unseal(event.payload).includes('450.0'));
  now+=30137;assert.equal(evaluateRules(store,{uploadMbps:470,downloadMbps:100}).length,0);
  now+=120000;assert.equal(evaluateRules(store,{uploadMbps:470,downloadMbps:100}).length,0,'缺失采样后不能视为连续高负载');
});
