import test from 'node:test';
import assert from 'node:assert/strict';
import{mkdtempSync,rmSync}from'node:fs';
import{tmpdir}from'node:os';
import{join,resolve,sep}from'node:path';
import{randomUUID}from'node:crypto';
import{openStore}from'../src/store.mjs';
import{token}from'../src/security.mjs';
import{newCredentials}from'../src/backup.mjs';
import{createAuthService}from'../src/auth-service.mjs';
import{normalizeHy2,normalizeXray,readHy2,readXray,kickHy2,ingestSnapshot}from'../src/collectors.mjs';

async function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'vps-panel-test-auth-'));let now=1700000000000;
 const store=await openStore({directory,password:'local-test-password',clock:()=>now});
 const auth=createAuthService({directory,clock:()=>now});
 await new Promise(resolve=>auth.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await auth.close();store.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));assert.ok(resolve(directory).split(sep).at(-1).startsWith('vps-panel-test-auth-'));rmSync(directory,{recursive:true,force:true});});
 const id=randomUUID(),credentials=newCredentials(),secret=token();
 store.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)').run(id,'测试用户',1,'["hy2"]','["att"]',1000,null,store.seal(JSON.stringify(credentials)),now);
 store.set('auth-services',store.seal(JSON.stringify({'hy2.att':secret,'hy2.direct':secret})));
 store.set('runtime',{maintenance:false,emergencyStop:false});
 const request=async({exit='att',password=credentials.hy2,serviceSecret=secret,authValue=id+':'+password}={})=>{
  const result=await fetch(`http://127.0.0.1:${auth.server.address().port}/hy2/${exit}/${serviceSecret}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({auth:authValue,addr:'127.0.0.1:12345',tx:0})});return result.json();
 };
 return{store,id,credentials,secret,request,advance:span=>now+=span};
}
test('独立认证服务实时读取权限：停用、过期、额度、出口与维护状态均立即拒绝',async t=>{
 const f=await fixture(t);
 assert.deepEqual(await f.request(),{ok:true,id:f.id});
 assert.equal((await f.request({password:'wrong'})).ok,false);
 assert.equal((await f.request({serviceSecret:token()})).ok,false);
 assert.equal((await f.request({exit:'direct'})).ok,false);
 f.store.db.prepare('UPDATE users SET enabled=0 WHERE id=?').run(f.id);assert.equal((await f.request()).ok,false);
 f.store.db.prepare('UPDATE users SET enabled=1,expires=? WHERE id=?').run(f.store.clock()-1,f.id);assert.equal((await f.request()).ok,false);
 f.store.db.prepare('UPDATE users SET expires=NULL WHERE id=?').run(f.id);
 f.store.applyTraffic({userId:f.id,stream:'hy2.att',epoch:'a',up:500,down:500});assert.equal((await f.request()).ok,false);
 f.store.db.prepare('UPDATE users SET quota=NULL WHERE id=?').run(f.id);assert.equal((await f.request()).ok,true);
 f.store.set('runtime',{maintenance:true,emergencyStop:false});assert.equal((await f.request()).ok,false);
 f.store.set('runtime',{maintenance:false,emergencyStop:true});assert.equal((await f.request()).ok,false);
});
test('旧单密码仅用于明确导入用户，仍受出口、停用、额度与维护约束且重复密码拒绝',async t=>{
 const f=await fixture(t),raw={authValue:f.credentials.hy2};
 assert.equal((await f.request(raw)).ok,false);
 const legacy={...f.credentials,hy2LegacyAuth:true};
 f.store.db.prepare('UPDATE users SET credentials=? WHERE id=?').run(f.store.seal(JSON.stringify(legacy)),f.id);
 assert.deepEqual(await f.request(raw),{ok:true,id:f.id});
 assert.equal((await f.request({authValue:token()})).ok,false);
 assert.equal((await f.request({...raw,exit:'direct'})).ok,false);
 f.store.db.prepare('UPDATE users SET enabled=0 WHERE id=?').run(f.id);assert.equal((await f.request(raw)).ok,false);
 f.store.db.prepare('UPDATE users SET enabled=1 WHERE id=?').run(f.id);
 f.store.applyTraffic({userId:f.id,stream:'hy2.att',epoch:'legacy',up:1000,down:0});assert.equal((await f.request(raw)).ok,false);
 f.store.db.prepare('UPDATE users SET quota=NULL WHERE id=?').run(f.id);
 f.store.set('runtime',{maintenance:true,emergencyStop:false});assert.equal((await f.request(raw)).ok,false);
 f.store.set('runtime',{maintenance:false,emergencyStop:false});
 const other=randomUUID();f.store.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)').run(other,'重复凭证',1,'["hy2"]','["att"]',null,null,f.store.seal(JSON.stringify(legacy)),f.store.clock());
 assert.equal((await f.request(raw)).ok,false);
 f.store.db.prepare('DELETE FROM users WHERE id=?').run(other);
 f.store.db.prepare('UPDATE users SET credentials=? WHERE id=?').run(f.store.seal(JSON.stringify(newCredentials())),f.id);
 assert.equal((await f.request(raw)).ok,false);
});

test('统计方向采用用户视角，允许已连接但尚未传输用户；拒绝溢出或负计数',()=>{
 const id=randomUUID();
 assert.deepEqual(normalizeHy2({[id]:{tx:200,rx:100}},{[id]:1}),[{id,up:100,down:200,connections:1}]);
 assert.deepEqual(normalizeHy2({},{[id]:1}),[{id,up:null,down:null,connections:1}]);
 assert.throws(()=>normalizeHy2({[id]:{rx:-1,tx:0}}));
 assert.throws(()=>normalizeHy2({[id]:{rx:'9999999999999999999',tx:0}}));
 const data={stat:[{name:`user>>>${id}>>>traffic>>>uplink`,value:'123'},{name:`user>>>${id}>>>traffic>>>downlink`,value:'456'}]};
 assert.deepEqual(normalizeXray(data),[{id,up:123,down:456,connections:null}]);
 assert.throws(()=>normalizeXray({stat:[...data.stat,data.stat[0]]}));
 assert.equal(normalizeXray(data,{users:[`user>>>${id}>>>online`]},[id])[0].connections,1);
 assert.equal(normalizeXray({}, {},[id])[0].connections,0);
 assert.equal(normalizeXray({}, {},[id])[0].up,null);
 assert.throws(()=>normalizeXray({}, {users:['unexpected']}));
});
test('核心请求固定回环地址，CLI不使用shell，撤销只发送指定用户ID',async()=>{
 const id=randomUUID(),requests=[];
 const fetchImpl=async(url,options)=>{requests.push({url,options});return{ok:true,json:async()=>url.endsWith('/online')?{[id]:1}:{[id]:{rx:10,tx:20}}};};
 const data=await readHy2({port:19001,secret:'test-statistics-secret-string'},{fetchImpl});assert.equal(data[0].up,10);
 await kickHy2({port:19001,secret:'test-statistics-secret-string'},[id],{fetchImpl});
 assert.ok(requests.every(item=>item.url.startsWith('http://127.0.0.1:19001/')));
 assert.equal(requests.at(-1).options.body,JSON.stringify([id]));
 await assert.rejects(readHy2({port:'19001;id',secret:'test-statistics-secret-string'},{fetchImpl}));
 const commands=[];
 await readXray({port:19002},{runner:async(binary,args,options)=>{assert.equal(binary,'/usr/local/lib/vps-panel/xray');commands.push(args);assert.equal(options.shell,undefined);return{stdout:'{}'};}});
 assert.deepEqual(commands,[['api','statsquery','--server=127.0.0.1:19002','-pattern','user>>>'],['api','statsgetallonlineusers','--server=127.0.0.1:19002']]);
});
test('采集周期持久化去重，核心重启不把旧累计清零，速度只使用有效时间增量',async t=>{
 const f=await fixture(t);
 ingestSnapshot(f.store,{stream:'hy2.att',epoch:'boot-a',samples:[{id:f.id,up:100,down:200,connections:1}]});
 assert.equal(f.store.get('live-traffic')[f.id]['hy2.att'].up,null);
 f.advance(2000);
 ingestSnapshot(f.store,{stream:'hy2.att',epoch:'boot-a',samples:[{id:f.id,up:140,down:300,connections:1}]});
 assert.equal(f.store.get('live-traffic')[f.id]['hy2.att'].up,20);
 f.advance(2000);
 ingestSnapshot(f.store,{stream:'hy2.att',epoch:'boot-b',samples:[{id:f.id,up:10,down:20,connections:1}]});
 assert.equal(f.store.db.prepare('SELECT up FROM totals WHERE user_id=?').get(f.id).up,150);
 assert.equal(f.store.get('live-traffic')[f.id]['hy2.att'].up,null);
});

test('在线快照缺少计数不清零；异常整批不计费，长时间采样中断不伪造实时速度',async t=>{
 const f=await fixture(t),snapshot=samples=>ingestSnapshot(f.store,{stream:'hy2.att',epoch:'a',samples});
 snapshot([{id:f.id,up:100,down:200,connections:1}]);
 f.advance(2000);snapshot(normalizeHy2({},{[f.id]:1}));
 assert.equal(f.store.db.prepare('SELECT up FROM traffic WHERE user_id=?').get(f.id).up,100);
 assert.equal(f.store.get('live-traffic')[f.id]['hy2.att'].connections,1);
 assert.equal(f.store.get('live-traffic')[f.id]['hy2.att'].up,null);
 const sample={id:f.id,up:150,down:200,connections:1};
 assert.throws(()=>snapshot([sample,sample]));
 assert.throws(()=>snapshot([sample,{id:randomUUID(),up:-1,down:0,connections:0}]));
 assert.equal(f.store.db.prepare('SELECT up FROM totals WHERE user_id=?').get(f.id).up,100);
 f.advance(61000);snapshot([sample]);
 assert.equal(f.store.db.prepare('SELECT up FROM totals WHERE user_id=?').get(f.id).up,150);
 assert.equal(f.store.get('live-traffic')[f.id]['hy2.att'].up,null);
});
