import test from'node:test';
import assert from'node:assert/strict';
import{mkdtempSync,rmSync,writeFileSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{createSystemDriver}from'../src/system-driver.mjs';
import{createAgent}from'../src/agent.mjs';
import{readFuse,tripFuse,clearFuse,tripped}from'../src/safety-fuses.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const inactive='ActiveState=inactive\nSubState=dead\nMainPID=0\n';
function directory(t){const path=mkdtempSync(join(tmpdir(),'vps-stop-priority-'));t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}

test('停止锁跨管理器重建持久保存，旧启动票据不能解除新的停止锁',t=>{
 const path=directory(t),first=tripFuse(path,'vmess.direct'),second=tripFuse(path,'vmess.direct');
 assert.notEqual(first,second);assert.equal(clearFuse(path,'vmess.direct',first),false);
 assert.equal(readFuse(path,'vmess.direct'),second);assert.ok(tripped(path,'vmess.direct'));
 assert.equal(clearFuse(path,'vmess.direct',second),true);assert.equal(readFuse(path,'vmess.direct'),null);
 assert.throws(()=>tripFuse(path,'../other'));
});

test('启动在防火墙操作期间收到手动停止，不再执行核心启动；重建后自修复仍跳过',async t=>{
 const path=directory(t),entered=deferred(),resume=deferred(),calls=[];let paused=false;
 writeFileSync(join(path,'system.json'),JSON.stringify({relay:{ports:{vmess:{direct:18002}}},autoRepair:true,desired:{'vmess.direct':true}}));
 const runner=async(binary,args)=>{
  calls.push([binary,args]);
  if(binary.endsWith('ufw')&&args[0]==='status'){
   if(!paused){paused=true;entered.resolve();await resume.promise;}
   return{stdout:'Status: inactive\n'};
  }
  return{stdout:inactive};
 };
 const driver=createSystemDriver({directory:path,runner});
 const starting=driver.action('start',{stream:'vmess.direct'});
 const rejection=assert.rejects(starting,/停止/);
 await entered.promise;await driver.action('stop',{stream:'vmess.direct'});resume.resolve();await rejection;
 assert.ok(!calls.some(([,args])=>args[0]==='start'&&args[1]==='vps-panel-vmess-direct.service'));
 const rebuilt=createSystemDriver({directory:path,runner});
 assert.equal((await rebuilt.action('repair-profile',{stream:'vmess.direct'})).skipped,true);
});

test('管理器慢操作不阻塞状态查询和急停，其他写操作仍被串行限制',async t=>{
 const entered=deferred(),resume=deferred(),calls=[];
 const agent=createAgent({driver:{action:async action=>{calls.push(action);if(action==='certificate-issue'){entered.resolve();await resume.promise;}return{ok:true};}}});
 await new Promise(resolve=>agent.server.listen(0,'127.0.0.1',resolve));t.after(()=>agent.close());
 const url='http://127.0.0.1:'+agent.server.address().port;
 const request=action=>fetch(url,{method:'POST',body:JSON.stringify({action,data:{}}),signal:AbortSignal.timeout(5000)});
 const slow=request('certificate-issue');await entered.promise;
 try{
  const status=await request('status');assert.equal(status.status,200);await status.json();
  const blocked=await request('start');assert.equal(blocked.status,409);await blocked.json();
  const stopped=await request('emergency-stop');assert.equal(stopped.status,200);await stopped.json();
  assert.ok(calls.includes('emergency-stop'));assert.ok(!calls.includes('start'));
 }finally{resume.resolve();await(await slow).json();}
});
