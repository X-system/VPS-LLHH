import test from 'node:test';
import assert from 'node:assert/strict';
import{mkdtempSync,rmSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{randomUUID}from'node:crypto';
import{openStore}from'../src/store.mjs';
import{newCredentials}from'../src/backup.mjs';
import{createAccessReconciler}from'../src/access.mjs';

async function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'vps-access-test-'));let now=1700000000000;
 const store=await openStore({directory,password:'test-password',clock:()=>now});
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 store.set('runtime',{maintenance:false,emergencyStop:false});
 const ids=[randomUUID(),randomUUID()];for(const id of ids)store.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)').run(id,id,1,'["hy2","vmess"]','["att","direct"]',1000,null,store.seal(JSON.stringify(newCredentials())),now);
 const calls=[],epochs={'hy2.att':'h1','vmess.att':'v1'};
 const adapter={status:async stream=>({active:true,epoch:epochs[stream]}),onlineIds:async()=>ids,kick:async(stream,ids)=>calls.push(['kick',stream,ids]),replaceTcp:async(stream,users)=>{calls.push(['replace',stream,users.map(user=>user.id)]);epochs[stream]+='r';},stop:async stream=>calls.push(['stop',stream])};
 const reconcile=createAccessReconciler({store,profiles:{'hy2.att':{},'vmess.att':{}},adapter});
 return{store,ids,calls,adapter,reconcile,advance:value=>now+=value};
}
test('Hy2禁用/额度/到期撤销单人；TCP硬撤销只重建对应出口，未变更不重复重启',async t=>{
 const f=await fixture(t);await f.reconcile();f.calls.length=0;
 await f.reconcile();assert.deepEqual(f.calls,[]);
 f.store.db.prepare('UPDATE users SET enabled=0 WHERE id=?').run(f.ids[0]);await f.reconcile();
 assert.deepEqual(f.calls,[['replace','vmess.att',[f.ids[1]]],['kick','hy2.att',[f.ids[0]]]]);
 f.calls.length=0;f.store.applyTraffic({userId:f.ids[1],stream:'hy2.att',epoch:'h1',up:1000,down:0});await f.reconcile();
 assert.ok(f.calls.some(call=>call[0]==='kick'&&call[2].includes(f.ids[1])));
 f.store.db.prepare('UPDATE users SET enabled=1,quota=NULL,expires=?').run(f.store.clock()+1000);await f.reconcile();f.calls.length=0;
 f.advance(1001);await f.reconcile();assert.deepEqual(f.calls.find(call=>call[0]==='kick')[2].sort(),f.ids.sort());
});
test('撤销失败关闭对应线路；急停优先，过期状态不会记为同步成功',async t=>{
 const f=await fixture(t);await f.reconcile();f.calls.length=0;
 f.store.set('runtime',{maintenance:false,emergencyStop:true});
 f.adapter.kick=async()=>{throw new Error('unreachable');};
 const result=await f.reconcile();assert.equal(result.results.find(row=>row.stream==='hy2.att').status,'failed-closed');
 assert.ok(f.calls.some(call=>call[0]==='stop'&&call[1]==='hy2.att'));
 assert.notDeepEqual(f.store.get('access-applied')['hy2.att'].users,{});
});
