import test from'node:test';
import assert from'node:assert/strict';
import{mkdtempSync,rmSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{DatabaseSync}from'node:sqlite';
import{digest}from'../src/security.mjs';
import{randomUUID,randomBytes}from'node:crypto';
import{openStore}from'../src/store.mjs';
import{newCredentials,exportBackup,importBackup,rollbackImport,readBackup}from'../src/backup.mjs';
import{saveLines,linePermissions}from'../src/line-permissions.mjs';
import{accessUsers,permitted}from'../src/access.mjs';
import{buildRelayConfigs,buildFailClosed}from'../src/core-config.mjs';
import{catalog,saveSubscriptionSettings}from'../src/line-catalog.mjs';
import{deleteUser,userUsage,deletedUsage,monthlyUserUsage}from'../src/user-ledger.mjs';
import{indexSubscriptions,subscription,subscriptionAddress}from'../src/subscriptions.mjs';
import{lineUsage}from'../src/line-usage.mjs';
import{saveRelay}from'../src/deployment.mjs';
import{createApp}from'../src/server.mjs';

async function fixture(t){const directory=mkdtempSync(join(tmpdir(),'vps-simple-'));let now=Date.parse('2026-11-30T15:59:00Z');const store=await openStore({directory,password:'test-only-password',clock:()=>now});t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return{store,directory,now:()=>now,setNow:value=>{now=value;}};}
function add(store,name='A1'){
 const id=randomUUID(),credentials=newCredentials();store.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)').run(id,name,1,'["vmess","hy2"]','["direct","att"]',null,null,store.seal(JSON.stringify(credentials)),store.clock());return{id,credentials};
}
function config(){return{publicIPv4:'192.0.2.20',domain:'relay.example.test',physicalInterface:'eth0',wireguardInterface:'vps-wg',endpointIPv4:'198.51.100.2',endpointPort:51874,endpointPublicKey:randomBytes(32).toString('base64'),uids:{'vmess.att':900,'vmess.direct':901,'hy2.att':902,'hy2.direct':903},ports:{vmess:{att:18001,direct:18002},hy2:{att:443,direct:8443}},stats:{'vmess.att':{port:19001},'vmess.direct':{port:19002},'hy2.att':{port:19003,secret:'test-secret-statistics-12345'},'hy2.direct':{port:19004,secret:'test-secret-statistics-12346'}}};}
test('逐条授权不产生协议与出口的额外交叉权限，核心和订阅使用相同授权',async t=>{
 const{store}=await fixture(t),account=add(store);saveLines(store,account.id,['vmess.direct','hy2.att']);const user=accessUsers(store)[0];
 for(const[id,expected]of[['vmess.direct',true],['hy2.att',true],['hy2.direct',false],['vmess.att',false]])assert.equal(permitted(user,id,store.clock(),{maintenance:false}),expected);
 const built=buildRelayConfigs(config(),[user]);assert.equal(built['vmess.att'].inbounds[0].settings.clients.length,0);assert.deepEqual(Object.keys(built['hy2.direct'].auth.userpass),[]);
 store.set('relay-config',store.seal(JSON.stringify(config())));store.set('runtime',{maintenance:false});indexSubscriptions(store);
 const links=Buffer.from(subscription(store,account.credentials.subscription).body,'base64').toString().split('\n');assert.equal(links.length,2);
 const vm=JSON.parse(Buffer.from(links.find(url=>url.startsWith('vmess:')).slice(8),'base64'));assert.equal(vm.port,'18002');
});
test('删除用户撤销旧订阅，当月流量合并，下月不显示；线路历史不倒退',async t=>{
 const f=await fixture(t),s=f.store,a=add(s),b=add(s,'B');s.set('relay-config',s.seal(JSON.stringify(config())));indexSubscriptions(s);
 for(const user of[a,b])s.applyTraffic({userId:user.id,stream:'hy2.direct',epoch:'one',up:100,down:200});
 assert.equal(userUsage(s,a.id).month.up,100);const before=monthlyUserUsage(s);deleteUser(s,a.id);deleteUser(s,b.id);assert.deepEqual(monthlyUserUsage(s),before);
 assert.equal(subscription(s,a.credentials.subscription),null);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM users').get().n,0);
 assert.deepEqual(deletedUsage(s),{period:'2026-11',up:200,down:400,visible:true});
 assert.equal(lineUsage(s).routes.find(row=>row.id==='direct').uploadBytes,200);
 f.setNow(Date.parse('2026-11-30T16:01:00Z'));assert.equal(deletedUsage(s).visible,false);
 assert.equal(s.db.prepare('SELECT SUM(up+down) AS total FROM line_periods').get().total,600);
 assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM deleted_days').all()).includes(a.id));
});
test('统一线路名和订阅名不包含用户名；停止与状态未知区分，ATT故障不影响直出',async t=>{
 const f=await fixture(t),s=f.store,a=add(s),b=add(s,'B2');s.set('relay-config',s.seal(JSON.stringify(config())));s.set('runtime',{maintenance:false});
 saveLines(s,a.id,['hy2.direct','hy2.att']);saveLines(s,b.id,['hy2.direct','hy2.att']);
 saveSubscriptionSettings(s,{title:'我的线路',names:{'hy2.direct':'香港直出','hy2.att':'香港家宽'}});indexSubscriptions(s);
 s.set('service-status',{at:s.clock(),profiles:{'hy2.direct':{active:true},'hy2.att':{active:true}}});s.set('network-status',{at:s.clock(),up:false,protected:true});
 const first=subscription(s,a.credentials.subscription),second=subscription(s,b.credentials.subscription);
 assert.equal(first.title,'我的线路');
 const labels=value=>Buffer.from(value.body,'base64').toString().split('\n').map(link=>decodeURIComponent(new URL(link).hash.slice(1)));
 assert.deepEqual(labels(first),['香港家宽 | 当前不可用','香港直出']);assert.deepEqual(labels(first),labels(second));
 f.setNow(s.clock()+21000);assert.ok(catalog(s).filter(l=>l.protocol==='hy2').every(l=>l.state==='unknown'));
 assert.ok(labels(subscription(s,a.credentials.subscription)).every(label=>label.endsWith('状态待确认')));
});
test('完整备份、搬家及回退保存精确权限、每日用量和已删除用户统计',async t=>{
 const f=await fixture(t),s=f.store,a=add(s);saveLines(s,a.id,['vmess.direct','hy2.att']);s.applyTraffic({userId:a.id,stream:'vmess.direct',epoch:'one',up:10,down:20});
 const dead=add(s,'deleted');s.applyTraffic({userId:dead.id,stream:'hy2.direct',epoch:'one',up:30,down:40});deleteUser(s,dead.id);
 saveSubscriptionSettings(s,{title:'测试订阅',names:{'hy2.att':'出口线路'}});
 const backup=exportBackup(s,{full:true,password:'test-backup-password'});
 saveLines(s,a.id,[]);importBackup(s,backup,{password:'test-backup-password',mode:'move',confirmed:true});
 assert.deepEqual(linePermissions(s,a.id),['vmess.direct','hy2.att']);assert.equal(userUsage(s,a.id).today.down,20);assert.equal(deletedUsage(s).down,40);
 rollbackImport(s,{confirmed:true});assert.deepEqual(linePermissions(s,a.id),[]);assert.equal(userUsage(s,a.id).today.up,10);assert.equal(deletedUsage(s).up,30);
});
test('仅原始TCP直出无需WG和域名，不生成出口放行；配置时仍保持停止',async t=>{
 const{store}=await fixture(t),raw=config(),calls=[];
 await saveRelay(store,{domain:raw.publicIPv4,publicIPv4:raw.publicIPv4,ports:raw.ports,enabledProtocols:['vmess'],attEnabled:false},async(action,data)=>{calls.push(action);return action==='inspect'?{uids:raw.uids,controlUid:999,physicalInterface:'eth0',panelPort:18443}:{};});
 assert.deepEqual(calls,['inspect','configure-relay']);assert.equal(store.get('runtime').maintenance,true);
 const current=JSON.parse(store.unseal(store.get('relay-config')));assert.equal(current.endpointIPv4,undefined);assert.equal(current.attEnabled,false);
 const rules=buildFailClosed(current);assert.ok(!rules.includes('undefined'));assert.ok(!rules.includes('ip daddr 198.51.100.2'));
});
test('用户详情与删除API需要会话、CSRF和删除确认，不返回用户密钥',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-simple-api-')),app=await createApp({directory,password:'test-only-password'});t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
 app.store.set('onboarded',true);await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+app.server.address().port,base=origin+'/'+app.store.get('entrance').value+'/api/';
 const login=await fetch(base+'login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'test-only-password'})}),cookie=login.headers.get('set-cookie').split(';')[0],session=await login.json();
 const headers={Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':session.csrf};
 const created=await(await fetch(base+'users',{method:'POST',headers,body:JSON.stringify({name:'A1',protocols:['vmess','hy2'],exits:['direct','att'],lines:['hy2.att','vmess.direct']})})).json(),id=created.user.id;
 const detail=await(await fetch(base+'users/'+id,{headers})).json();assert.equal(detail.lines.length,4);assert.deepEqual(detail.user.lines,['vmess.direct','hy2.att']);assert.ok(!JSON.stringify(detail).includes('credentials'));
 assert.equal((await fetch(base+'users/'+id,{method:'DELETE',headers:{...headers,'X-CSRF-Token':''},body:'{"confirmed":true}'})).status,403);
 assert.equal((await fetch(base+'users/'+id,{method:'DELETE',headers,body:'{}'})).status,409);
 assert.equal((await fetch(base+'users/'+id,{method:'DELETE',headers,body:'{"confirmed":true}'})).status,202);
 assert.equal((await fetch(base+'users/'+id,{headers})).status,404);
});

test('订阅地址为v2rayN提供统一remarks，为兼容客户端提供片段；不会使用用户名',()=>{
 const url=new URL(subscriptionAddress('https://relay.example.test:18443','a'.repeat(43),'我的线路'));
 assert.equal(url.searchParams.get('remarks'),'我的线路');assert.equal(decodeURIComponent(url.hash.slice(1)),'我的线路');assert.equal(url.pathname,'/sub/'+'a'.repeat(43));
});

test('新备份使用版本2防止旧程序丢失逐条权限；保留读取旧版本，拒绝未来格式',async t=>{
 const{store}=await fixture(t);const plain=exportBackup(store);assert.equal(plain.version,2);assert.equal(readBackup({...plain,version:1}).version,1);
 const secured=exportBackup(store,{full:true,password:'test-backup-password'});assert.equal(secured.version,2);assert.equal(readBackup(secured,{password:'test-backup-password'}).version,2);
 assert.throws(()=>readBackup({...secured,version:1},{password:'test-backup-password'}),/损坏/);assert.throws(()=>readBackup({...plain,version:3}),/版本/);
});

test('首次设置密钥只使用一次；错误和过期密钥不发会话，账户设置后旧密钥失效',async t=>{
 let now=Date.now();const directory=mkdtempSync(join(tmpdir(),'vps-bootstrap-api-')),app=await createApp({directory,password:'test-only-password',onboarding:true,clock:()=>now});t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port+'/'+app.store.get('entrance').value+'/api/',secret=randomBytes(32).toString('base64url');app.store.set('bootstrap-access',{hash:digest(secret),expires:now+60000});
 const post=(path,data,extra={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...extra},body:JSON.stringify(data)});
 const wrong=await post('bootstrap',{token:'x'.repeat(43)});assert.equal(wrong.status,401);assert.equal(wrong.headers.get('set-cookie'),null);
 const accepted=await post('bootstrap',{token:secret});assert.equal(accepted.status,200);const cookie=accepted.headers.get('set-cookie').split(';')[0],session=await accepted.json();assert.equal((await post('bootstrap',{token:secret})).status,401);
 const account=await post('onboarding',{step:'account',username:'my-admin',password:'new-test-password'},{Cookie:cookie,'X-CSRF-Token':session.csrf});assert.equal(account.status,200);assert.equal(app.store.get('bootstrap-access'),null);assert.equal((await post('bootstrap',{token:secret})).status,401);
 app.store.set('onboarding',{version:2,step:'account',completed:[],draft:{}});app.store.set('bootstrap-access',{hash:digest(secret),expires:now-1});const expired=await post('bootstrap',{token:secret});assert.equal(expired.status,401);assert.equal(expired.headers.get('set-cookie'),null);
});
test('数据库拒绝未来版本且不改写其版本号',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-schema-future-'));try{const store=await openStore({directory,password:'test-password'});assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,2);store.db.exec('PRAGMA user_version=3');store.close();await assert.rejects(openStore({directory}),/更新的版本/);const db=new DatabaseSync(join(directory,'panel.sqlite'),{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get().user_version,3);db.close();}finally{rmSync(directory,{recursive:true,force:true});}
});

test('新版角色切换保留逐条权限与统计，重新引导配对，不把旧配对误当作已连接',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-role-v2-api-')),calls=[],app=await createApp({directory,password:'test-only-password',systemRequest:async(action,data)=>{calls.push({action,data});return{};},healthEnabled:false});t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
 const s=app.store;s.set('settings',{...s.get('settings'),uiVersion:2});s.set('onboarded',true);s.set('onboarding',{version:2,step:'done',completed:[],draft:{}});s.set('relay-config',s.seal(JSON.stringify({...config(),enabledProtocols:['vmess'],attEnabled:false})));s.set('att-binding',s.seal('{"name":"旧出口"}'));
 const a=add(s);saveLines(s,a.id,['vmess.direct']);s.applyTraffic({userId:a.id,stream:'vmess.direct',epoch:'one',up:10,down:20});const b=add(s,'deleted');s.applyTraffic({userId:b.id,stream:'hy2.direct',epoch:'one',up:30,down:40});deleteUser(s,b.id);
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port+'/'+s.get('entrance').value+'/api/';const login=await fetch(base+'login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'test-only-password'})}),cookie=login.headers.get('set-cookie').split(';')[0],session=await login.json();const headers={Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':session.csrf};
 for(const role of['exit','relay']){const response=await fetch(base+'role',{method:'POST',headers,body:JSON.stringify({role,confirmed:true})});assert.equal(response.status,200);assert.equal((await response.json()).onboarding.active,true);assert.equal(s.get('network-config'),null);assert.equal(s.get('att-binding'),null);}
 assert.equal(app.onboarding.view().step,'protocols');assert.deepEqual(app.onboarding.view().draft.protocols,['vmess']);assert.deepEqual(linePermissions(s,a.id),['vmess.direct']);assert.equal(s.db.prepare('SELECT up FROM totals WHERE user_id=?').get(a.id).up,10);assert.equal(s.db.prepare('SELECT SUM(down) AS used FROM deleted_days').get().used,40);assert.equal(calls.filter(row=>row.action==='switch-role').length,2);
});
