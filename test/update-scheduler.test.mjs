import test from'node:test';
import assert from'node:assert/strict';
import{mkdtempSync,rmSync,writeFileSync,readFileSync}from'node:fs';
import{join}from'node:path';
import{tmpdir}from'node:os';
import{createUpdateManager,dailyCheckDue,beijingDay}from'../src/updates.mjs';
function fixture(t){const directory=mkdtempSync(join(tmpdir(),'vps-update-schedule-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));let now=Date.UTC(2026,10,26,23,59),requests=0,running=false,role='relay';const launches=[];
 const release={tag_name:'relay-v0.4.0',prerelease:false,assets:[{name:'vps-panel-v0.4.0.tar.gz',size:100,digest:'sha256:'+'a'.repeat(64),browser_download_url:'https://github.com/example/panel/releases/download/relay-v0.4.0/vps-panel-v0.4.0.tar.gz'}]};
 const create=()=>createUpdateManager({directory,sourceRepository:'example/panel',clock:()=>now,getRole:async()=>role,isRunning:async()=>running,fetchImpl:async()=>{requests++;return{ok:true,json:async()=>[release]};},schedule:async(...args)=>launches.push(args)});
 return{directory,create,launches,get requests(){return requests;},get now(){return now;},advance(ms){now+=ms;},setRunning(value){running=value;},setRole(value){role=value;}};
}
test('北京时间08:00持久化每日检查；重启不重复，跨天重新检查，不自动安装',async t=>{
 const f=fixture(t),manager=f.create();assert.equal(beijingDay(f.now),'2026-11-27');assert.equal(dailyCheckDue(f.now,null),false);await manager.tick();assert.equal(f.requests,0);
 f.advance(60000);await Promise.all([manager.tick(),manager.tick()]);assert.equal(f.requests,1);await f.create().tick();assert.equal(f.requests,1);assert.equal(f.launches.length,0);
 const status=await manager.status();assert.equal(status.hasUpdate,true);assert.equal(status.timeZone,'Asia/Shanghai');assert.equal(status.repository,undefined);assert.equal(status.available.url,undefined);
 f.advance(86400000);await f.create().tick();assert.equal(f.requests,2);
});
test('预约跨管理器重启，到时只提交一次，取消预约和变更角色不误启动',async t=>{
 const f=fixture(t),manager=f.create();await assert.rejects(manager.reserve({confirmed:false,at:f.now+120000}));await assert.rejects(manager.reserve({confirmed:true,at:f.now}));
 await manager.reserve({confirmed:true,at:f.now+120000});assert.equal((await manager.status()).plan.asset,undefined);f.advance(60000);await f.create().tick();assert.equal(f.launches.length,0);
 f.advance(60000);await f.create().tick();assert.equal(f.launches.length,1);f.setRunning(true);await f.create().tick();assert.equal(f.launches.length,1);
 writeFileSync(join(f.directory,'update-state.json'),JSON.stringify({step:'complete',at:f.now}));await f.create().tick();assert.equal((await manager.status()).plan.state,'finished');
 f.setRunning(false);await manager.reserve({confirmed:true,at:f.now+120000});await manager.cancel();f.advance(120000);await f.create().tick();assert.equal(f.launches.length,1);
 await manager.reserve({confirmed:true,at:f.now+120000});f.setRole('exit');f.advance(120000);await f.create().tick();assert.equal(f.launches.length,1);assert.equal((await manager.status()).plan.state,'cancelled');
});
test('重启丢失尚未执行的临时任务时重建已确认预约，运行中任务不重复',async t=>{
 const f=fixture(t),manager=f.create();await manager.start({confirmed:true});assert.equal(f.launches.length,1);f.advance(61000);f.setRunning(true);await f.create().tick();assert.equal(f.launches.length,1);
 f.setRunning(false);await f.create().tick();assert.equal(f.launches.length,2);const request=JSON.parse(readFileSync(join(f.directory,'update-request.json')));assert.equal(request.role,'relay');assert.equal(request.version,'0.4.0');
});
