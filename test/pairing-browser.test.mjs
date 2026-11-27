import{delegateNotification,notificationRelayStatus}from'../src/notification-relay.mjs';
import{configureBark}from'../src/bark.mjs';
import{randomUUID}from'node:crypto';
import test from'node:test';
import assert from'node:assert/strict';
import{mkdtempSync,rmSync,mkdirSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{createServer}from'node:net';
import{chromium}from'playwright';
import{createApp}from'../src/server.mjs';
import{setupDriver}from'./setup-fixture.mjs';
import{certificate}from'./tls-fixture.mjs';
import{token,digest}from'../src/security.mjs';
async function availablePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
test('双面板真实浏览器：出口首次引导、复制密钥、请求确认、自动配置和解除配对',async t=>{
 const nodes=[],deliveries=[];let browser;t.after(async()=>{await browser?.close();for(const node of nodes){await node.app.close();rmSync(node.directory,{recursive:true,force:true});}});
 for(const[role,ip]of[['relay','11.0.0.2'],['exit','11.0.0.3']]){
  const directory=mkdtempSync(join(tmpdir(),'vps-pair-browser-')),port=await availablePort(),origin='https://127.0.0.1:'+port,driver=setupDriver({publicIPv4:ip,role});
  const app=await createApp({directory,password:'test-only-bootstrap',onboarding:true,systemRequest:driver.request,healthEnabled:false,tls:certificate(),origin,allowLocalPairing:true,fetchImpl:async(url,options)=>{deliveries.push({role,url,body:JSON.parse(options.body)});return{ok:true,json:async()=>({code:200})};}});app.store.set('settings',{...app.store.get('settings'),role});await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));nodes.push({directory,app,driver,origin,role});
 }
 browser=await chromium.launch({args:process.platform==='win32'?['--disable-gpu','--disable-gpu-compositing']:[],headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined)});
 const errors=[];
 for(const node of nodes){
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});node.page=await context.newPage();node.page.on('pageerror',e=>errors.push(e.message));const setup=token();node.app.store.set('bootstrap-access',{hash:digest(setup),expires:Date.now()+60000});await node.page.goto(node.origin+'/'+node.app.store.get('entrance').value+'/#setup='+setup);
  await node.page.locator('[name=username]').fill('test-'+node.role);await node.page.locator('[name=password]').fill('new-test-password');await node.page.locator('[name=repeat]').fill('new-test-password');await node.page.getByRole('button',{name:'保存并继续',exact:true}).click();await node.page.locator('[name=serverName]').fill(node.role==='exit'?'测试出口':'测试中转');await node.page.getByRole('button',{name:'保存并继续',exact:true}).click();
  if(node.role==='relay'){await node.page.locator('[name=protocol][value=hy2]').uncheck();await node.page.locator('[name=protocol][value=vmess]').check();await node.page.getByRole('button',{name:'保存并继续',exact:true}).click();}
  await node.page.getByRole('button',{name:'稍后配置',exact:true}).click();
 }
 const[relay,exit]=nodes;
 await exit.page.getByRole('button',{name:'继续',exact:true}).click();await exit.page.getByRole('button',{name:'完成配置并开启服务',exact:true}).click();await exit.page.locator('.sidebar').waitFor();assert.equal(await exit.page.locator('.sidebar .nav [data-page]').count(),4);
 await exit.page.locator('.sidebar [data-page=services]').click();await exit.page.locator('[data-setting="连接中转端"] summary').click();
 await relay.page.locator('[name=useAtt][value=yes]').check();await relay.page.getByRole('button',{name:'生成ATT连接密钥',exact:true}).click();const key=await relay.page.getByRole('textbox',{name:'ATT连接密钥',exact:true}).inputValue();assert.ok(key.startsWith('ATT1.'));
 await exit.page.locator('[name=attKey]').fill(key);await exit.page.getByRole('button',{name:'发送绑定请求',exact:true}).click();await relay.page.getByRole('heading',{name:'收到ATT绑定请求',exact:true}).waitFor();assert.ok(!(relay.driver.calls.some(row=>row.action==='configure-network')));await relay.page.getByRole('button',{name:'确认绑定',exact:true}).click();
 await exit.page.getByText('已完成配对：测试中转。隧道和线路会在应用配置时另行检查。',{exact:true}).waitFor({timeout:15000});await relay.page.getByRole('button',{name:'保存并继续',exact:true}).click();await relay.page.getByRole('button',{name:'完成配置并开启服务',exact:true}).click();await relay.page.locator('.sidebar').waitFor();assert.equal(relay.driver.state().relay.attEnabled,true);assert.deepEqual(relay.driver.calls.filter(row=>row.action==='start').map(row=>row.data.stream),['vmess.direct','vmess.att']);
 for(const node of nodes)configureBark(node.app.store,{pushUrl:'https://api.day.app/testRecipient123'});
 for(const node of nodes){assert.equal(notificationRelayStatus(node.app.store).peers.length,1);assert.deepEqual(await delegateNotification(node.app.store,{eventId:randomUUID(),type:'tunnel.failed',request:{url:'https://api.day.app/push',body:{device_key:'testOriginalRecipient',title:'测试网络告警',body:'不发送真实推送'}}},{allowLocal:true}),{accepted:true});}
 assert.equal(deliveries.length,2);assert.ok(deliveries.every(d=>d.body.device_key==='testOriginalRecipient'));assert.deepEqual(deliveries.map(d=>d.role),['exit','relay']);
 await relay.page.locator('.sidebar [data-page=services]').click();await relay.page.locator('[data-setting="ATT出口连接"] summary').click();relay.page.once('dialog',dialog=>dialog.accept());await relay.page.getByRole('button',{name:'解除当前出口配对',exact:true}).click();await relay.page.getByText('配对已解除，可以重新生成或粘贴连接密钥',{exact:true}).waitFor();assert.equal(relay.driver.state().relay.attEnabled,false);assert.equal(relay.driver.state().profiles['vmess.direct'].active,true);assert.equal(relay.driver.state().profiles['vmess.att'].active,false);
 await exit.page.setViewportSize({width:390,height:844});await exit.page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.ok(await exit.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));mkdirSync('test-results',{recursive:true});await exit.page.waitForFunction(()=>document.querySelector('.sidebar').getBoundingClientRect().right<=1);await exit.page.screenshot({path:'test-results/simple-exit-pairing-mobile.png',animations:'disabled'});assert.deepEqual(errors,[]);
});
