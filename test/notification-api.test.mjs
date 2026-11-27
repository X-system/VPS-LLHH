import test from'node:test';
import assert from'node:assert/strict';
import{mkdtempSync,rmSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{createApp}from'../src/server.mjs';
import{configureBark,eventTypes}from'../src/bark.mjs';
test('逐项测试需要登录与CSRF，只使用已存通道；暂停时可手动测试草稿，不能改动生效模板或泄露入口',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-notification-api-')),sent=[],app=await createApp({directory,password:'notification-api-test-password',fetchImpl:async(url,options)=>{sent.push({url,payload:JSON.parse(options.body)});return{ok:true,json:async()=>({code:200})};}});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{app.server.closeAllConnections();await app.close();rmSync(directory,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.server.address().port+'/'+app.store.get('entrance').value+'/',sample={type:'host.cpu',mode:'system'};
 const request=(path,data,headers={})=>fetch(base+'api/'+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
 assert.equal((await request('notification-test',sample)).status,401);const login=await request('login',{username:'admin',password:'notification-api-test-password'}),cookie=login.headers.get('set-cookie').split(';')[0],csrf=(await login.json()).csrf,headers={Cookie:cookie,'X-CSRF-Token':csrf};
 assert.equal((await request('notification-test',sample,{Cookie:cookie,'X-CSRF-Token':'bad'})).status,403);assert.equal((await request('notification-test',sample,headers)).status,409);configureBark(app.store,{pushUrl:'https://api.day.app/fakeAPIDeviceKeyOnly'});
 assert.equal((await request('notification-control',{enabled:false},{Cookie:cookie,'X-CSRF-Token':'bad'})).status,403);const closed=await request('notification-control',{enabled:false},headers);assert.equal(closed.status,200);assert.equal((await closed.json()).monitoring.state,'off');const snapshot=JSON.stringify(app.store.get('notification-profiles'));
 for(const type of Object.keys(eventTypes).filter(type=>type!=='bark.test'))assert.equal((await request('notification-test',{mode:'system',type,url:'https://untrusted.invalid/push'},headers)).status,200);
 const custom=await request('notification-test',{mode:'custom',type:'host.cpu',template:{title:'临时 {server} 标题',body:'{event} / {detail} / {current}'}},headers);assert.equal(custom.status,200);assert.match(sent.at(-1).payload.title,/^【测试】临时/);assert.match(sent.at(-1).payload.body,/CPU/);assert.match(sent.at(-1).payload.body,/95%/);assert.equal(JSON.stringify(app.store.get('notification-profiles')),snapshot);
 for(const row of sent){assert.equal(row.url,'https://api.day.app/push');assert.match(row.payload.title,/^【测试】/);assert.match(row.payload.body,/不代表服务器发生真实故障/);assert.ok(!JSON.stringify(row).includes(app.store.get('entrance').value));assert.equal(row.payload.url,undefined);}
 assert.equal((await request('notification-test',{mode:'custom',type:'host.cpu',template:{title:'{invalid}',body:'测试'}},headers)).status,400);assert.equal((await request('notification-test',{mode:'system',type:'not-an-event'},headers)).status,400);
 let limited=false;for(let i=0;i<35;i++){const response=await request('notification-test',sample,headers);if(response.status===429){limited=true;break;}assert.equal(response.status,200);}assert.equal(limited,true);
 assert.equal((await request('notification-control',{enabled:true},headers)).status,200);assert.equal(app.store.get('notification-profiles').enabled,true);
});
