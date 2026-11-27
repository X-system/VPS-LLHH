import test from'node:test';
import assert from'node:assert/strict';
import{mkdtempSync,rmSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{openStore}from'../src/store.mjs';
import{createOnboarding,resumeSetup}from'../src/onboarding.mjs';
import{setupDriver}from'./setup-fixture.mjs';
import{verifyPassword}from'../src/security.mjs';
import{firstLoginAddress}from'../src/first-login.mjs';

async function fixture(t,driver=setupDriver()){
 const directory=mkdtempSync(join(tmpdir(),'vps-onboarding-')),store=await openStore({directory,password:'test-password'});store.set('onboarding',{version:2,step:'account',completed:[],draft:{}});
 const flow=createOnboarding({store,request:driver.request});t.after(async()=>{await flow.wait();store.close();rmSync(directory,{recursive:true,force:true});});return{store,flow,driver};
}
async function untilReview(f){
 await f.flow.advance({step:'account',username:'我的管理员',password:'new-test-password'});await f.flow.advance({step:'name',serverName:'测试中转'});await f.flow.advance({step:'protocols',protocols:['vmess']});await f.flow.advance({step:'bark',skip:true});await f.flow.advance({step:'pairing',useAtt:false});
}
test('首次引导逐步保存；TCP直出不出现证书要求，不要求WG，最后自动生成并检查',async t=>{
 const f=await fixture(t);await assert.rejects(f.flow.advance({step:'protocols',protocols:['vmess']}),/进度/);
 await untilReview(f);assert.equal(f.flow.view().step,'review');assert.ok(!f.flow.view().steps.includes('certificate'));
 const admin=f.store.db.prepare('SELECT * FROM admin').get();assert.equal(admin.username,'我的管理员');assert.equal(await verifyPassword('new-test-password',admin.password),true);assert.ok(!JSON.stringify(f.flow.view()).includes('new-test-password'));
 const result=await f.flow.advance({step:'review',confirmed:true});assert.equal(result.job.state,'running');await f.flow.wait();
 assert.equal(f.flow.view().active,false);assert.equal(f.store.get('onboarded'),true);assert.equal(f.driver.state().relay.attEnabled,false);
 assert.deepEqual(f.driver.calls.filter(call=>call.action==='start').map(call=>call.data.stream),['vmess.direct']);
 assert.ok(!f.driver.calls.some(call=>call.action==='configure-network'));assert.equal(f.store.get('settings').autoRepair,true);
});
test('保存步骤可恢复，证书令牌不出现在进度中；未配对不能继续开启ATT',async t=>{
 const f=await fixture(t);await f.flow.advance({step:'account',username:'admin-new',password:'new-test-password'});await f.flow.advance({step:'name',serverName:'Hy2测试'});await f.flow.advance({step:'protocols',protocols:['hy2']});
 const token='isolated-cloudflare-token-12345';await f.flow.advance({step:'certificate',domain:'relay.example.test',token,zoneId:'a'.repeat(32),email:'test@example.test',termsAccepted:true});
 assert.ok(!JSON.stringify(f.flow.view()).includes(token));assert.ok(!JSON.stringify(f.store.get('onboarding')).includes(token));assert.equal(f.flow.view().step,'certificate');
 await f.flow.advance({step:'certificate',check:true});await f.flow.advance({step:'bark',skip:true});
 await assert.rejects(f.flow.advance({step:'pairing',useAtt:true}),/配对/);assert.equal(f.flow.view().step,'pairing');
 const rebuilt=createOnboarding({store:f.store,request:f.driver.request});assert.equal(rebuilt.view().step,'pairing');assert.equal(rebuilt.view().draft.domain,'relay.example.test');
});
test('引导自动配置途中收到人工停止，不再开启任何线路，也不标记完成',async t=>{
 const f=await fixture(t,setupDriver({onConfigure:()=> 'manual'}));await untilReview(f);await f.flow.advance({step:'review',confirmed:true});await f.flow.wait();
 assert.equal(f.flow.view().job.state,'failed');assert.match(f.flow.view().job.message,/手动停止/);assert.equal(f.store.get('onboarded'),undefined);
 assert.equal(f.driver.calls.filter(call=>call.action==='start').length,0);assert.equal(f.store.get('runtime').maintenance,true);
});
test('账户并发提交只处理一次；旧引导不能覆盖已设置的账户',async t=>{
 const f=await fixture(t);const first=f.flow.advance({step:'account',username:'first',password:'first-test-password'});
 await assert.rejects(f.flow.advance({step:'account',username:'second',password:'second-test-password'}),/保存/);await first;
 await assert.rejects(f.flow.advance({step:'account',username:'second',password:'second-test-password'}),/进度/);assert.equal(f.store.db.prepare('SELECT username FROM admin').get().username,'first');
});
test('出口端引导不要求协议或证书，不伪造已连接中转；保留自动启动策略',async t=>{
 const f=await fixture(t);f.store.set('settings',{...f.store.get('settings'),role:'exit'});
 await f.flow.advance({step:'account',username:'exit-admin',password:'exit-test-password'});await f.flow.advance({step:'name',serverName:'测试出口'});assert.equal(f.flow.view().step,'bark');
 await f.flow.advance({step:'bark',skip:true});await f.flow.advance({step:'pairing'});await f.flow.advance({step:'review',confirmed:true});await f.flow.wait();
 assert.equal(f.flow.view().active,false);assert.ok(!f.driver.calls.some(call=>call.action==='configure-network'||call.action==='start'));
 assert.equal(f.store.get('settings').autoStart,true);
});

test('首次设置链接将临时登录密钥放在浏览器片段，不放入服务器请求路径或查询',()=>{
 const secret='a'.repeat(43),url=new URL(firstLoginAddress('https://192.0.2.1:18443','AaBbCcDdEe1234567_~-',secret));
 assert.equal(url.hash,'#setup='+secret);assert.equal(url.search,'');assert.ok(!url.pathname.includes(secret));
 assert.throws(()=>firstLoginAddress('http://192.0.2.1:18443','AaBbCcDdEe1234567_~-',secret));
});

test('恢复导入保留账户与名称，清除旧绑定；确认解除恢复保护后才能继续开通',async t=>{
 const f=await fixture(t);await untilReview(f);f.store.set('runtime',{maintenance:true,emergencyStop:true});f.store.set('att-binding',f.store.seal('{"name":"旧出口"}'));f.store.set('certificate-settings',f.store.seal('{"domain":"old.example.test"}'));resumeSetup(f.store);
 assert.equal(f.flow.view().step,'protocols');assert.equal(f.store.get('att-binding'),null);assert.equal(f.store.db.prepare('SELECT username FROM admin').get().username,'我的管理员');
 await f.flow.advance({step:'protocols',protocols:['vmess']});await f.flow.advance({step:'bark',skip:true});await f.flow.advance({step:'pairing',useAtt:false});
 await assert.rejects(f.flow.advance({step:'review',confirmed:true}),/解除恢复保护/);await f.flow.advance({step:'review',confirmed:true,releaseRecovery:true});await f.flow.wait();assert.equal(f.flow.view().job.state,'done');
 assert.ok(f.driver.calls.some(call=>call.action==='release-emergency'));assert.equal(f.driver.state().relay.domain,'11.0.0.2');
});
test('Hy2域名未指向本机时不启动，不伪装完成；修改解析后可以重试',async t=>{
 const f=await fixture(t);await f.flow.advance({step:'account',username:'admin-test',password:'new-test-password'});await f.flow.advance({step:'name',serverName:'测试'});await f.flow.advance({step:'protocols',protocols:['hy2']});
 await f.flow.advance({step:'certificate',domain:'not-resolving.example.test',zoneId:'a'.repeat(32),token:'isolated-cloudflare-token-12345',email:'test@example.test',termsAccepted:true});await f.flow.advance({step:'certificate',check:true});await f.flow.advance({step:'bark',skip:true});await f.flow.advance({step:'pairing',useAtt:false});
 await f.flow.advance({step:'review',confirmed:true});await f.flow.wait();assert.equal(f.flow.view().job.state,'failed');assert.match(f.flow.view().job.message,/A记录/);assert.ok(!f.driver.calls.some(call=>call.action==='start'));
 const retry=createOnboarding({store:f.store,request:f.driver.request,resolve:async()=>[{address:'11.0.0.2'}]});await retry.advance({step:'review',confirmed:true});await retry.wait();assert.equal(retry.view().active,false);
});

test('证书域名变更自动应用新域名，保留已手动停止的协议状态',async t=>{
 const f=await fixture(t);await untilReview(f);await f.flow.advance({step:'review',confirmed:true});await f.flow.wait();f.store.set('settings',{...f.store.get('settings'),uiVersion:2});
 const current=JSON.parse(f.store.unseal(f.store.get('relay-config')));current.enabledProtocols=['hy2','vmess'];f.store.set('relay-config',f.store.seal(JSON.stringify(current)));await f.driver.request('stop',{stream:'vmess.direct'});
 const certificate={domain:'new.example.test',zoneId:'a'.repeat(32),token:'test-cloudflare-token-123456',email:'test@example.test',termsAccepted:true};f.store.set('certificate-settings',f.store.seal(JSON.stringify(certificate)));await f.driver.request('certificate-configure',certificate);await f.driver.request('certificate-issue');
 const resumed=createOnboarding({store:f.store,request:f.driver.request,resolve:async()=>[{address:'11.0.0.2'}]});const before=f.driver.calls.filter(row=>row.action==='start').length;await resumed.syncCertificate();await resumed.wait();
 assert.equal(resumed.view().job.state,'done');assert.equal(f.driver.state().relay.domain,'new.example.test');assert.equal(f.driver.calls.filter(row=>row.action==='start').length,before);assert.equal(f.driver.state().profiles['vmess.direct'].active,false);assert.equal(f.driver.state().profiles['hy2.direct'].active,false);
});

test('配置任务中途重启标记失败并进入维护，不自动重试或伪装完成',async t=>{
 const f=await fixture(t);f.store.set('onboarding',{version:2,step:'review',completed:['account','name'],draft:{protocols:['vmess']},job:{id:'interrupted',state:'running',phase:'启动线路'}});f.store.set('runtime',{maintenance:false,emergencyStop:false});
 const reopened=createOnboarding({store:f.store,request:f.driver.request});assert.equal(reopened.view().job.state,'failed');assert.match(reopened.view().job.message,/中断/);assert.equal(f.store.get('runtime').maintenance,true);assert.equal(f.driver.calls.length,0);assert.equal(f.store.get('onboarded'),undefined);
});
