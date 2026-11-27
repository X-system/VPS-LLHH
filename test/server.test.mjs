import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve,sep } from 'node:path';
import { createApp } from '../src/server.mjs';
import{request as httpRequest}from'node:http';

async function fixture(t,{clock,...appOptions}={}) {
  const directory=mkdtempSync(join(tmpdir(),'vps-panel-test-'));
  const app=await createApp({directory,password:'test-password-for-local-only',clock,...appOptions});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${app.server.address().port}`;
  const prefix=`/${app.store.get('entrance').value}/`;
  const request=(path,options={})=>fetch(origin+prefix+path,options);
  let cookie,csrf;
  async function login() {
    const response=await request('api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'test-password-for-local-only'})});
    assert.equal(response.status,200);
    cookie=response.headers.get('set-cookie').split(';')[0];csrf=(await response.json()).csrf;
    return {cookie,csrf};
  }
  const auth=(path,{method='GET',data,headers={}}={})=>request(path,{method,headers:{Cookie:cookie,'X-CSRF-Token':csrf,...(data?{'Content-Type':'application/json'}:{}),...headers},body:data?JSON.stringify(data):undefined});
  t.after(async()=>{await app.close();const absolute=resolve(directory);assert.ok(absolute.startsWith(resolve(tmpdir())+sep));assert.ok(absolute.split(sep).at(-1).startsWith('vps-panel-test-'));rmSync(absolute,{recursive:true,force:true});});
  return {app,directory,origin,prefix,request,login,auth};
}

test('密码允许短密码、Unicode、空格及超过256字符，仅拒绝空值；更改后可用原文登录',async t=>{
 const f=await fixture(t);await f.login();assert.equal((await f.auth('api/account',{method:'POST',data:{currentPassword:'test-password-for-local-only',username:'owner',password:''}})).status,400);assert.equal((await f.auth('api/account',{method:'POST',data:{currentPassword:'test-password-for-local-only',username:'owner',password:'1'}})).status,200);
 const login=password=>f.request('api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'owner',password})});let response=await login('1');assert.equal(response.status,200);let cookie=response.headers.get('set-cookie').split(';')[0],csrf=(await response.json()).csrf;
 const change=(currentPassword,password)=>f.request('api/account',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},body:JSON.stringify({currentPassword,username:'owner',password})});const longPassword=' 空格密码🙂 '.repeat(80);assert.equal((await change('1',longPassword)).status,200);response=await login(longPassword);assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];csrf=(await response.json()).csrf;assert.equal((await change(longPassword,'2')).status,200);assert.equal((await login('2')).status,200);
});

test('裸端口、猜测入口、旧入口404且不跳转；静态资源也受入口限制',async t=>{
  const f=await fixture(t);
  for(const path of ['/','/login','/api/meta','/app.js','/ui-style.css','/ui-kit.mjs','/ui-help.mjs','/ui-pages.mjs','/ui-config.mjs','/wrong/']){
    const response=await fetch(f.origin+path,{redirect:'manual'});
    assert.equal(response.status,404);assert.equal(response.headers.get('location'),null);
    assert.ok(!(await response.text()).includes(f.app.store.get('entrance').value));
  }
  assert.equal((await f.request('')).status,200);
  assert.equal((await f.request('app.js')).status,200);
  assert.equal(Object.hasOwn(await(await f.request('api/meta')).json(),'username'),false);
  for(const asset of ['ui-style.css','ui-kit.mjs','ui-help.mjs','ui-pages.mjs','ui-config.mjs','ui-mobile.mjs','ui-mobile.css','ui-monitor.mjs','ui-monitor.css','ui-feedback.css','ui-feedback.mjs','ui-health.mjs','ui-health.css'])assert.equal((await f.request(asset)).status,200);
  assert.equal((await f.request('%2e%2e/secrets')).status,404);
  await f.login();
  f.app.store.rotateEntrance();
  assert.equal((await f.auth('api/settings')).status,404);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
  const rows=f.app.store.db.prepare('SELECT * FROM audit').all();
  assert.ok(!JSON.stringify(rows).includes(f.app.store.get('entrance').value));
});
test('认证、CSRF和Origin检查；不信任伪造代理头',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('api/settings')).status,401);
  assert.equal((await f.request('api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.invalid'},body:'{}'})).status,403);
  const session=await f.login();
  assert.equal((await(await f.auth('api/session')).json()).username,'admin');
  assert.equal((await f.request('api/settings',{method:'PATCH',headers:{Cookie:session.cookie,'Content-Type':'application/json'},body:'{"serverName":"changed"}'})).status,403);
  assert.equal((await f.auth('api/settings',{method:'PATCH',data:{serverName:'changed'},headers:{Origin:'https://evil.invalid'}})).status,403);
  assert.equal((await f.auth('api/logout',{method:'POST'})).status,200);
  assert.equal((await f.auth('api/settings')).status,401);
});

test('首次选择出口角色同步系统管理器；同步失败不标记初始化完成',async t=>{
 const calls=[];let fail=true;
 const f=await fixture(t,{systemRequest:async(action,data)=>{calls.push([action,data]);if(fail)throw new Error('fixture unavailable');return{role:'exit',started:false};}});
 await f.login();
 assert.equal((await f.auth('api/setup',{method:'POST',data:{role:'exit',serverName:'初始出口'}})).status,500);
 assert.ok(!f.app.store.get('onboarded'));assert.equal(f.app.store.get('settings').role,'relay');
 fail=false;assert.equal((await f.auth('api/setup',{method:'POST',data:{role:'exit',serverName:'初始出口'}})).status,200);
 assert.equal(calls.at(-1)[0],'switch-role');assert.deepEqual(calls.at(-1)[1],{role:'exit',confirmed:true});assert.equal(f.app.store.get('settings').role,'exit');assert.equal(f.app.store.get('runtime').emergencyStop,true);
});

test('预留总控数据接口只读且需要管理员会话，未实现远程控制不开放写入',async t=>{
 const f=await fixture(t);assert.equal((await f.request('api/integration')).status,401);
 await f.login();const response=await f.auth('api/integration');assert.equal(response.status,200);
 const value=await response.json();assert.equal(value.contractVersion,1);assert.equal(value.management.mode,'standalone');assert.equal(value.management.controllerImplemented,false);
 assert.equal(value.remoteConfiguration,false);assert.ok(!JSON.stringify(value).includes(f.app.store.get('entrance').value));
 assert.equal((await f.auth('api/integration',{method:'POST',data:{mode:'managed'}})).status,404);
 assert.equal((await f.auth('api/line-usage')).status,200);
});

test('域名与明确配置的IP均可访问，但不放开任意Host或跨地址Origin',async t=>{
 const domain='http://panel.example.test:18443',ip='http://192.0.2.1:18443';
 const f=await fixture(t,{origin:domain,allowedOrigins:[ip]});
 const request=(host,path='api/meta',options={})=>new Promise((resolve,reject)=>{
  const req=httpRequest(f.origin+f.prefix+path,{method:options.method||'GET',headers:{Host:new URL(host).host,...options.headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).map(([key,value])=>[key,Array.isArray(value)?value.join(','):value]))})));});
  req.on('error',reject);req.end(options.body);
 });
 assert.equal((await request(domain)).status,200);assert.equal((await request(ip)).status,200);
 assert.equal((await request('http://evil.invalid:18443')).status,421);
 assert.equal((await request(ip,'api/meta',{headers:{Origin:domain}})).status,403);
 const response=await request(ip,'api/login',{method:'POST',headers:{Origin:ip,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'test-password-for-local-only'})});assert.equal(response.status,200);
 const cookie=response.headers.get('set-cookie').split(';')[0],csrf=(await response.json()).csrf;
 const options={method:'PATCH',headers:{Origin:ip,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:'{"serverName":"IP登录测试"}'};
 assert.equal((await request(ip,'api/settings',options)).status,200);
 assert.equal((await request(domain,'api/settings',options)).status,403);
 assert.equal((await request(ip,'api/settings',{...options,headers:{...options.headers,Host:'evil.invalid:18443','X-Forwarded-Host':new URL(ip).host}})).status,421);
 assert.equal((await fetch(f.origin+'/',{headers:{Host:new URL(ip).host}})).status,404);
});
test('本机公网IP变更立即允许新地址和实际监听端口，拒绝旧地址、内网、伪造Host和跨地址Origin',async t=>{
 let addresses=[{family:'IPv4',internal:false,address:'11.0.0.2'},{family:'IPv4',internal:false,address:'10.0.0.1'}];
 const f=await fixture(t,{origin:'http://panel.example.test:18443',networkInterfaces:()=>({eth0:addresses})});
 const port=f.app.server.address().port;
 const request=(host,headers={})=>new Promise((resolve,reject)=>{
  const req=httpRequest(f.origin+f.prefix+'api/meta',{headers:{Host:host,...headers}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();
 });
 assert.equal(await request('11.0.0.2:'+port),200);
 addresses=[{family:'IPv4',internal:false,address:'11.0.0.22'}];
 assert.equal(await request('11.0.0.22:'+port),200);
 assert.equal(await request('11.0.0.2:'+port),421);
 for(const host of['11.0.0.22:18443','10.0.0.1:'+port,'127.0.0.1:'+port,'evil.invalid:'+port])assert.equal(await request(host,{'X-Forwarded-Host':'11.0.0.22:'+port}),421);
 assert.equal(await request('11.0.0.22:'+port,{Origin:'http://evil.invalid'}),403);
 assert.equal(await request('11.0.0.22:'+port,{Origin:'http://11.0.0.22:'+port}),200);
});

test('关闭IP访问同时拒绝明确IP别名、本机动态IPv4、IPv6和伪造转发头，域名与本机域名自检仍可用',async t=>{
 const domain='http://panel.example.test:18443',f=await fixture(t,{origin:domain,allowIpAccess:false,allowedOrigins:['http://192.0.2.1:18443','http://[2001:db8::1]:18443'],networkInterfaces:()=>({eth0:[{family:'IPv4',internal:false,address:'11.0.0.2'}]})});
 const request=(host,path='api/meta')=>new Promise((resolve,reject)=>{const req=httpRequest(f.origin+f.prefix+path,{headers:{Host:host,'X-Forwarded-Host':new URL(domain).host}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});
 assert.equal(await request(new URL(domain).host),200);
 for(const host of['192.0.2.1:18443','11.0.0.2:'+f.app.server.address().port,'[2001:db8::1]:18443','127.0.0.1:'+f.app.server.address().port])for(const path of['api/meta','app.js','api/settings',''])assert.equal(await request(host,path),421);
});

test('安全入口更新周期不可关闭、不可永久、自定义入口不可写；设置持久化',async t=>{
  const f=await fixture(t);await f.login();
  for(const value of [0,-1,181,null,'永久'])assert.equal((await f.auth('api/settings',{method:'PATCH',data:{rotationDays:value}})).status,400);
  assert.equal((await f.auth('api/settings',{method:'PATCH',data:{entrance:'chosen-by-user'}})).status,400);
  assert.equal((await f.auth('api/settings',{method:'PATCH',data:{role:'exit'}})).status,400);
  const response=await f.auth('api/settings',{method:'PATCH',data:{serverName:'洛杉矶中转一号',rotationDays:180}});
  assert.equal(response.status,200);
  assert.equal(f.app.store.get('settings').serverName,'洛杉矶中转一号');
  assert.equal(f.app.store.get('settings').rotationDays,180);
});
test('自动轮换按持久化周期触发，废除会话并将通知加密入队',async t=>{
  let now=1700000000000;
  const f=await fixture(t,{clock:()=>now});await f.login();
  const before=f.app.store.get('entrance').value;
  now+=31*86400000;f.app.maintenance();
  assert.notEqual(f.app.store.get('entrance').value,before);
  const event=f.app.store.db.prepare('SELECT * FROM events').get();
  assert.equal(event.type,'entrance.rotated');assert.ok(!event.payload.includes(f.app.store.get('entrance').value));
  assert.equal(JSON.parse(f.app.store.unseal(event.payload)).entrance,f.app.store.get('entrance').value);
});
test('初始化角色只可一次；出口角色拒绝创建代理用户',async t=>{
  const f=await fixture(t);await f.login();
  const data={role:'exit',serverName:'家宽出口'};
  assert.equal((await f.auth('api/setup',{method:'POST',data})).status,200);
  assert.equal((await f.auth('api/setup',{method:'POST',data})).status,409);
  assert.equal((await f.auth('api/users',{method:'POST',data:{name:'用户'}})).status,409);
});
test('用户独立身份加密存储，不回显密码；统计重启周期和重复采样不会重复计数',async t=>{
  const f=await fixture(t);await f.login();
  await f.auth('api/setup',{method:'POST',data:{role:'relay',serverName:'中转一号'}});
  const response=await f.auth('api/users',{method:'POST',data:{name:'朋友甲',protocols:['hy2','vmess'],exits:['att'],quota:1024}});
  assert.equal(response.status,201);
  const created=await response.json();
  assert.equal(created.user.online,null);assert.equal(created.user.deployment,'未部署');
  assert.equal(created.user.credentials,undefined);
  const id=created.user.id;
  const sealed=f.app.store.db.prepare('SELECT credentials FROM users WHERE id=?').get(id).credentials;
  const secrets=JSON.parse(f.app.store.unseal(sealed));
  assert.notEqual(secrets.hy2,secrets.subscription);
  assert.ok(!readFileSync(join(f.directory,'panel.sqlite')).includes(Buffer.from(secrets.hy2)));
  assert.deepEqual(f.app.store.applyTraffic({userId:id,stream:'hy2.att',epoch:'boot-a',up:100,down:200}),{up:100,down:200});
  f.app.store.applyTraffic({userId:id,stream:'hy2.att',epoch:'boot-a',up:100,down:200});
  f.app.store.applyTraffic({userId:id,stream:'hy2.att',epoch:'boot-b',up:10,down:30});
  assert.throws(()=>f.app.store.applyTraffic({userId:id,stream:'hy2.att',epoch:'boot-b',up:1,down:1}));
  const row=f.app.store.db.prepare('SELECT * FROM totals WHERE user_id=?').get(id);
  assert.equal(row.up,110);assert.equal(row.down,230);
  assert.equal((await f.auth(`api/users/${id}`,{method:'PATCH',data:{enabled:false}})).status,200);
  assert.equal((await f.auth('api/users',{method:'POST',data:{name:'非法协议',protocols:['anytls']}})).status,400);
});
test('密码更改必须验证旧密码且注销全部会话',async t=>{
  const f=await fixture(t);await f.login();
  assert.equal((await f.auth('api/account',{method:'POST',data:{currentPassword:'wrong',username:'owner',password:'new-long-password'}})).status,403);
  assert.equal((await f.auth('api/account',{method:'POST',data:{currentPassword:'test-password-for-local-only',username:'owner',password:'new-long-password'}})).status,200);
  assert.equal((await f.auth('api/settings')).status,401);
});
test('Bark和备份API不回显敏感字段，普通导入需要确认且保持维护',async t=>{
  const f=await fixture(t);await f.login();
  await f.auth('api/setup',{method:'POST',data:{role:'relay',serverName:'配置验收'}});
  const bark=await f.auth('api/bark',{method:'PUT',data:{server:'https://bark.example.invalid',deviceKey:'test-device-key',encryptionKey:'1234567890123456'}});
  assert.equal(bark.status,200);
  const text=JSON.stringify(await bark.json());assert.ok(!text.includes('test-device-key'));assert.ok(!text.includes('1234567890123456'));
  const exported=await f.auth('api/backup/export',{method:'POST',data:{}});assert.equal(exported.status,200);
  const backup=await exported.json();assert.equal(backup.bark,undefined);
  assert.equal((await f.auth('api/backup/preview',{method:'POST',data:{backup}})).status,200);
  assert.equal((await f.auth('api/backup/import',{method:'POST',data:{backup}})).status,409);
  const imported=await f.auth('api/backup/import',{method:'POST',data:{backup,confirmed:true,mode:'clone'}});
  assert.equal(imported.status,200);assert.equal((await imported.json()).maintenance,true);
});
test('生产HTTPS缺失时拒绝启动；系统功能不返回成功占位',async t=>{
  const f=await fixture(t);await f.login();
  for(const path of ['api/services','api/role','api/pairing'])assert.equal((await f.auth(path,{method:'POST',data:{}})).status,501);
  await assert.rejects(createApp({directory:f.directory,production:true}),/HTTPS/);
});

 test('历史监控接口需要登录、校验范围且不制造空白时段记录',async t=>{const f=await fixture(t);assert.equal((await f.request('api/history')).status,401);await f.login();const response=await f.auth('api/history?range=24h');assert.equal(response.status,200);const data=await response.json();assert.deepEqual(data.points,[]);assert.equal(data.range,'24h');assert.equal(data.fresh,false);assert.equal((await f.auth('api/history?range=7d')).status,400);});

test('健康接口只读且需认证，已移除TCP检测设置接口，通知对端不泄露密钥',async t=>{const f=await fixture(t);assert.equal((await f.request('api/health')).status,401);await f.login();const response=await f.auth('api/health');assert.equal(response.status,200);const health=await response.json();assert.equal(health.state,'grey');assert.equal(health.readOnly,true);assert.ok(!health.rows.some(r=>r.id.startsWith('probe-')));assert.equal((await f.auth('api/health/settings')).status,404);const status=await(await f.auth('api/notification-relay')).json();assert.deepEqual(status.peers,[]);});

test('TCP加速管理需要登录与CSRF，三选一校验，不接收任意命令',async t=>{
 const calls=[],f=await fixture(t,{systemRequest:async(action,data)=>{calls.push({action,data});return{mode:data?.mode||'off',effective:'cubic',bbrxSupported:true};}});
 assert.equal((await f.request('api/tcp-acceleration')).status,401);await f.login();
 assert.equal((await f.auth('api/tcp-acceleration')).status,200);
 assert.equal((await f.auth('api/tcp-acceleration',{method:'PUT',data:{mode:'bbrx'},headers:{'X-CSRF-Token':'wrong'}})).status,403);
 for(const data of[{mode:'bbr;reboot'},{mode:'bbr',command:'reboot'}])assert.equal((await f.auth('api/tcp-acceleration',{method:'PUT',data})).status,400);
 for(const mode of['off','bbr','bbrx'])assert.equal((await f.auth('api/tcp-acceleration',{method:'PUT',data:{mode}})).status,202);
 assert.deepEqual(calls.filter(v=>v.action==='tcp-acceleration-set').map(v=>v.data.mode),['off','bbr','bbrx']);
});

test('立即更换入口需登录与确认，生成随机新入口并注销旧会话',async t=>{const f=await fixture(t);assert.equal((await f.request('api/entrance/rotate',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"confirmed":true}'})).status,401);await f.login();const before=f.app.store.get('entrance').value;assert.equal((await f.auth('api/entrance/rotate',{method:'POST',data:{confirmed:false}})).status,409);assert.equal(f.app.store.get('entrance').value,before);const response=await f.auth('api/entrance/rotate',{method:'POST',data:{confirmed:true}});assert.equal(response.status,200);const result=await response.json(),after=f.app.store.get('entrance').value;assert.notEqual(after,before);assert.equal(after.length,20);assert.ok(result.url.endsWith('/'+after+'/'));assert.equal(f.app.store.db.prepare('SELECT COUNT(*)AS n FROM sessions').get().n,0);assert.equal((await f.request('api/meta')).status,404);});
