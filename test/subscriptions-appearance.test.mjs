import test from'node:test';
import assert from'node:assert/strict';
import{mkdtempSync,rmSync,readdirSync}from'node:fs';
import{join}from'node:path';
import{tmpdir}from'node:os';
import{randomUUID,randomBytes}from'node:crypto';
import QRCode from'qrcode';
import{openStore}from'../src/store.mjs';
import{newCredentials,exportBackup,importBackup,rollbackImport}from'../src/backup.mjs';
import{indexSubscriptions,subscription}from'../src/subscriptions.mjs';
import{configureAppearance,appearanceAsset,pngUpload}from'../src/appearance.mjs';
import{diagnosticRedactor}from'../src/diagnostics.mjs';
import{alertRules,configureAlertRules}from'../src/metrics.mjs';

async function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'vps-sub-test-')),store=await openStore({directory,password:'test-password'});
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const id=randomUUID(),credentials=newCredentials();store.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)').run(id,'订阅用户',1,'["hy2","vmess"]','["att"]',1000,null,store.seal(JSON.stringify(credentials)),store.clock());
 const config={publicIPv4:'192.0.2.20',physicalInterface:'eth0',wireguardInterface:'vps-wg',domain:'relay.example.test',endpointIPv4:'198.51.100.25',endpointPort:51874,endpointPublicKey:randomBytes(32).toString('base64'),ports:{vmess:{att:18001,direct:18002},hy2:{att:443,direct:8443}},uids:{'vmess.att':900,'vmess.direct':901,'hy2.att':902,'hy2.direct':903},stats:{'vmess.att':{port:19001},'vmess.direct':{port:19002},'hy2.att':{port:19003,secret:'abcdefghijklmnopqrstuvwx'},'hy2.direct':{port:19004,secret:'abcdefghijklmnopqrstuvwy'}}};
 store.set('relay-config',store.seal(JSON.stringify(config)));indexSubscriptions(store);return{store,id,credentials,directory};
}
test('订阅独立于管理入口，只有授权线路；停用和额度耗尽拒绝，凭证不以明文建立索引',async t=>{
 const f=await fixture(t),first=subscription(f.store,f.credentials.subscription);assert.ok(first);
 const links=Buffer.from(first.body,'base64').toString().split('\n');assert.equal(links.length,2);assert.ok(links.some(link=>link.startsWith('vmess://')));assert.ok(links.some(link=>link.startsWith('hysteria2://')));
 f.store.rotateEntrance();assert.equal(subscription(f.store,f.credentials.subscription).body,first.body);
 assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM subscriptions').all()).includes(f.credentials.subscription));
 f.store.db.prepare('UPDATE users SET enabled=0').run();assert.equal(subscription(f.store,f.credentials.subscription),null);
 f.store.db.prepare('UPDATE users SET enabled=1').run();f.store.applyTraffic({userId:f.id,stream:'hy2.att',epoch:'a',up:1000,down:0});assert.equal(subscription(f.store,f.credentials.subscription),null);
});
test('自定义PNG外观限制格式、尺寸和文件数量；文件名不能越过外观目录',async t=>{
 const f=await fixture(t),image=await QRCode.toDataURL('local-test-only',{width:64});
 for(let index=0;index<5;index++)configureAppearance(f.store,f.directory,{loginName:'我的面板',logo:image});
 assert.equal(readdirSync(join(f.directory,'appearance')).length,3);assert.ok(appearanceAsset(f.store,f.directory,'logo'));
 assert.throws(()=>pngUpload('data:image/svg+xml;base64,PHN2Zz4=','logo'));
 const oversize=Buffer.from(image.slice(22),'base64');oversize.writeUInt32BE(8193,16);assert.throws(()=>pngUpload('data:image/png;base64,'+oversize.toString('base64'),'background'));
 f.store.set('appearance',{logo:'../../master.key'});assert.equal(appearanceAsset(f.store,f.directory,'logo'),null);
});
test('导入回退保留当前安全入口与身份，恢复原用户及累计并保持急停；诊断隐藏订阅和私钥',async t=>{
 const f=await fixture(t);f.store.applyTraffic({userId:f.id,stream:'hy2.att',epoch:'a',up:100,down:200});
 const exported=exportBackup(f.store),identity=f.store.get('identity');
 importBackup(f.store,exported,{confirmed:true});f.store.rotateEntrance();const entrance=f.store.get('entrance');
 assert.notEqual(f.store.db.prepare('SELECT id FROM users').get().id,f.id);
 rollbackImport(f.store,{confirmed:true});assert.equal(f.store.db.prepare('SELECT id FROM users').get().id,f.id);
 assert.equal(f.store.db.prepare('SELECT up+down AS used FROM totals').get().used,300);
 assert.deepEqual(f.store.get('entrance'),entrance);assert.equal(f.store.get('identity'),identity);assert.equal(f.store.get('runtime').emergencyStop,true);
 const redact=diagnosticRedactor(f.store);assert.ok(!redact(f.credentials.subscription).includes(f.credentials.subscription));
 assert.ok(!redact('vmess://secret-link').includes('secret-link'));
});

test('配置备份携带外观图片和告警阈值，跨目录恢复；异常图片先拒绝且不改本机用户',async t=>{
 const source=await fixture(t),target=await fixture(t),image=await QRCode.toDataURL('appearance-backup-test',{width:64});
 configureAppearance(source.store,source.directory,{loginName:'朋友登录',panelTitle:'自定义管理',logo:image,background:image});
 const rules=structuredClone(alertRules(source.store));rules.userRules.spikePercent=70;configureAlertRules(source.store,rules);
 const exported=exportBackup(source.store);assert.equal(exported.appearance.logo,image);
 const before=target.store.db.prepare('SELECT id FROM users').get().id;
 assert.throws(()=>importBackup(target.store,{...exported,appearance:{logo:'data:image/svg+xml;base64,PHN2Zz4='}},{confirmed:true}));
 assert.equal(target.store.db.prepare('SELECT id FROM users').get().id,before);
 importBackup(target.store,exported,{confirmed:true});
 assert.equal(target.store.get('appearance').panelTitle,'自定义管理');assert.equal(alertRules(target.store).userRules.spikePercent,70);
 assert.deepEqual(appearanceAsset(target.store,target.directory,'logo'),Buffer.from(image.slice(22),'base64'));
 assert.notEqual(target.store.get('appearance').logo,source.store.get('appearance').logo);
});

test('回退导入清除导入后新增的配置，并恢复已被图片清理淘汰的原始外观',async t=>{
 const f=await fixture(t),original=await QRCode.toDataURL('original-appearance',{width:64}),changed=await QRCode.toDataURL('changed-appearance',{width:64});
 configureAppearance(f.store,f.directory,{loginName:'原始登录',logo:original});const exported=exportBackup(f.store);
 importBackup(f.store,exported,{confirmed:true});f.store.set('added-after-import','must disappear');
 for(let index=0;index<5;index++)configureAppearance(f.store,f.directory,{loginName:'变更登录',logo:changed});
 rollbackImport(f.store,{confirmed:true});assert.equal(f.store.get('added-after-import'),undefined);
 assert.equal(f.store.get('appearance').loginName,'原始登录');assert.deepEqual(appearanceAsset(f.store,f.directory,'logo'),Buffer.from(original.slice(22),'base64'));
});
