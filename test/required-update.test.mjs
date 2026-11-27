import test from'node:test';
import assert from'node:assert/strict';
import{mkdtempSync,rmSync,readFileSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{createUpdateManager,releaseAsset}from'../src/updates.mjs';
import{releasePolicy}from'../src/update-policy.mjs';
import{openStore}from'../src/store.mjs';
import{configureBark,dispatchEvents}from'../src/bark.mjs';
import{observeUpdateNotices,emitUpdateNotice}from'../src/update-notices.mjs';
import{notificationSettingsView,setNotificationEnabled}from'../src/alert-settings.mjs';
const release=(version,required=false)=>({tag_name:'relay-v'+version,body:'新增线路管理，修复手机提示。'+(required?'\n<!-- llhh:update-policy {"required":true} -->':''),assets:[{name:`vps-panel-v${version}.tar.gz`,size:100,digest:'sha256:'+'a'.repeat(64),browser_download_url:`https://github.com/example/panel/releases/download/relay-v${version}/vps-panel-v${version}.tar.gz`}]});
test('更新说明和紧急策略只从通过角色、地址和摘要验证的发布读取，旧预约不能绕过安全版本',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'llhh-policy-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));let now=1800000000000,offline=false,list=[release('0.4.0')],runs=0;
 const manager=createUpdateManager({directory,clock:()=>now,sourceRepository:'example/panel',schedule:async()=>runs++,fetchImpl:async()=>{if(offline)throw Error('offline');return{ok:true,json:async()=>list};}});
 await manager.reserve({confirmed:true,at:now+60000});list=[release('0.5.0'),release('0.4.1',true)];await manager.status({check:true});let view=await manager.status();assert.equal(view.available.version,'0.5.0');assert.equal(view.required,true);assert.equal(view.available.requiredVersion,'0.4.1');assert.match(view.available.notes,/修复手机提示/);assert.doesNotMatch(view.available.notes,/llhh:update-policy/);
 await assert.rejects(manager.reserve({confirmed:true,at:now+60000}),/安全更新/);await assert.rejects(manager.cancel(),/安全更新/);await assert.rejects(manager.rollback({confirmed:true}),/安全更新/);
 offline=true;await assert.rejects(manager.status({check:true}));assert.equal((await manager.status()).required,true);now+=60000;await manager.tick();assert.equal(runs,0);assert.equal((await manager.status()).plan.state,'cancelled');offline=false;await manager.start({confirmed:true});assert.equal(runs,1);assert.equal(JSON.parse(readFileSync(join(directory,'update-request.json'))).version,'0.5.0');
 assert.throws(()=>releaseAsset('example/panel',{...release('0.6.0',true),assets:[]}));assert.equal(releasePolicy('普通文字 required=true').required,false);assert.equal(releasePolicy('<!-- llhh:update-policy {"required":"true"} -->').required,false);
});
test('更新状态统一标题，按版本或任务去重，关闭报警不补发旧消息，角色不显示无关事件',async t=>{
 let now=1800000000000;const directory=mkdtempSync(join(tmpdir(),'llhh-update-notices-')),store=await openStore({directory,password:'fixture',clock:()=>now});t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});configureBark(store,{pushUrl:'https://api.day.app/fixtureUpdateOnlyKey'});
 observeUpdateNotices(store,{history:[{at:now-1000,step:'complete'}]});assert.equal(store.db.prepare('SELECT count(*) n FROM events').get().n,0);
 const view={required:true,hasUpdate:true,available:{version:'0.5.0'},history:[]};observeUpdateNotices(store,view);observeUpdateNotices(store,view);for(const phase of['upcoming','started','completed','failed']){emitUpdateNotice(store,phase,'task-one',{version:'0.5.0'});emitUpdateNotice(store,phase,'task-one',{version:'0.5.0'});}
 const sent=[];await dispatchEvents(store,{max:10,fetchImpl:async(_url,options)=>{sent.push(JSON.parse(options.body));return{ok:true,json:async()=>({code:200})};}});assert.equal(sent.length,5);assert.ok(sent.every(m=>m.title.endsWith('更新状态提醒')));assert.ok(sent.some(m=>m.body.includes('高危版本')));
 setNotificationEnabled(store,{enabled:false});emitUpdateNotice(store,'available','0.6.0',{version:'0.6.0'});setNotificationEnabled(store,{enabled:true});emitUpdateNotice(store,'available','0.6.0',{version:'0.6.0'});assert.equal(store.db.prepare("SELECT count(*) n FROM events WHERE status='pending'").get().n,0);
 assert.equal(notificationSettingsView(store).availableEvents['upstream.connected'],undefined);store.set('settings',{...store.get('settings'),role:'exit'});assert.equal(notificationSettingsView(store).availableEvents['upstream.connected'],'中转机恢复连接');assert.equal(notificationSettingsView(store).availableEvents['user.quota'],undefined);
});
