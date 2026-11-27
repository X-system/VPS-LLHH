import test from'node:test';
import assert from'node:assert/strict';
import{mkdtempSync,rmSync}from'node:fs';
import{join}from'node:path';
import{tmpdir}from'node:os';
import{randomUUID}from'node:crypto';
import{openStore}from'../src/store.mjs';
import{newCredentials}from'../src/backup.mjs';
import{createRuntimeWorker}from'../src/runtime-worker.mjs';
import{counterRate,parseNetDev}from'../src/telemetry.mjs';

async function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'vps-worker-test-'));const store=await openStore({directory,password:'test-password'});
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const id=randomUUID();store.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)').run(id,'测试',1,'["hy2"]','["att"]',100,null,store.seal(JSON.stringify(newCredentials())),store.clock());
 store.set('runtime',{maintenance:false,emergencyStop:false});store.set('relay-config',store.seal(JSON.stringify({stats:{'hy2.att':{port:19003,secret:'test-statistics-secret'}}})));
 const calls=[],profiles={'hy2.att':{active:true,epoch:'a'}};
 const request=async(action,data)=>{calls.push([action,data]);if(action==='status')return{profiles};return{active:false,epoch:null};};
 return{store,id,calls,profiles,request};
}
test('独立后台先累计流量，再撤销额度耗尽用户，网页进程不参与',async t=>{
 const f=await fixture(t),kicked=[];
 const worker=createRuntimeWorker({...f,collectHy2:async()=>[{id:f.id,up:70,down:40,connections:1}],kick:async(profile,ids)=>kicked.push(ids)});
 await worker.tick();assert.equal(f.store.db.prepare('SELECT up+down AS used FROM totals').get().used,110);
 assert.deepEqual(kicked,[[f.id]]);assert.equal(f.store.get('worker-health').ok,true);
});
test('有限额线路统计故障时停止；急停不被后台恢复',async t=>{
 const f=await fixture(t);const worker=createRuntimeWorker({...f,collectHy2:async()=>{throw new Error('unavailable');}});
 await worker.tick();assert.ok(f.calls.some(call=>call[0]==='stop'&&call[1].stream==='hy2.att'));
 f.profiles['hy2.att'].active=true;f.store.set('runtime',{maintenance:true,emergencyStop:true});f.calls.length=0;
 await worker.tick();assert.ok(f.calls.some(call=>call[0]==='emergency-stop'));assert.ok(!f.calls.some(call=>call[0]==='start'));
});
test('物理网卡与隧道速率分开；长间隔或计数倒退不推算速度',()=>{
 const text='eth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\nvps-wg: 10 0 0 0 0 0 0 0 20 0 0 0 0 0 0 0';
 assert.deepEqual(parseNetDev(text,'eth0'),{down:100,up:200});assert.equal(parseNetDev(text,'eth1'),null);
 assert.deepEqual(counterRate({up:100,down:200},{up:200,down:400},2000),{up:50,down:100});
 assert.equal(counterRate({up:100,down:200},{up:200,down:400},61000).up,null);
 assert.equal(counterRate({up:100,down:200},{up:50,down:400},1000).up,null);
});

test('仅恢复明确期望运行且允许自修复的异常线路，手动停止和急停不恢复',async t=>{
 const f=await fixture(t);f.profiles['hy2.att']={active:false,state:'failed',epoch:null};
 let desired={'hy2.att':true},emergencyStop=false,autoRepair=true;
 const request=async(action,data)=>{
  f.calls.push([action,data]);
  if(action==='status')return{profiles:f.profiles,desired,autoRepair,emergencyStop};
  if(action==='repair-profile')return{active:true,state:'active',epoch:'repaired'};
  return{active:false};
 };
 const worker=createRuntimeWorker({...f,request,collectHy2:async()=>[],kick:async()=>{}});
 await worker.tick();assert.equal(f.calls.filter(([action])=>action==='repair-profile').length,1);
 for(const mode of['manual','policy','emergency']){
  f.calls.length=0;f.profiles['hy2.att']={active:false,state:'failed',epoch:null};
  desired={'hy2.att':mode!=='manual'};autoRepair=mode!=='policy';emergencyStop=mode==='emergency';
  await worker.tick();assert.ok(!f.calls.some(([action])=>action==='repair-profile'),mode);
 }
});

test('维护失败在代理停用时仍可入队，同一次状态重复上报不重复通知',async t=>{
 const f=await fixture(t),at=f.store.clock();f.store.set('runtime',{maintenance:true,emergencyStop:true});
 const worker=createRuntimeWorker({...f,request:async action=>action==='status'?{profiles:{},emergencyStop:true,maintenance:{update:{at,failed:true}}}:{}});
 await worker.tick();await worker.tick();assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='maintenance.failed'").get().n,1);
 assert.equal(f.store.get('worker-health').ok,true);
});
