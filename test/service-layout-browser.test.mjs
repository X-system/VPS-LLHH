import test from'node:test';
import assert from'node:assert/strict';
import{mkdtempSync,rmSync,mkdirSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{chromium}from'playwright';
import{createApp}from'../src/server.mjs';
import{setupDriver}from'./setup-fixture.mjs';
test('中转和出口：字段不遮挡、单选项不拆字、加速提示正确、操作反馈紧邻按钮',async t=>{
 const browser=await chromium.launch({args:process.platform==='win32'?['--disable-gpu','--disable-gpu-compositing']:[],headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined)});t.after(()=>browser.close());mkdirSync('test-results',{recursive:true});
 for(const role of['relay','exit']){
  const directory=mkdtempSync(join(tmpdir(),'vps-layout-')),driver=setupDriver({role}),app=await createApp({directory,password:'layout-test-password',systemRequest:driver.request,healthEnabled:false});
  app.store.set('settings',{...app.store.get('settings'),role,uiVersion:2});app.store.set('onboarded',true);app.store.set('onboarding',{version:2,step:'done',completed:[],draft:{}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
   await page.goto('http://127.0.0.1:'+app.server.address().port+'/'+app.store.get('entrance').value+'/');await page.locator('#username').fill('admin');await page.locator('#password').fill('layout-test-password');await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('.sidebar').waitFor();
   await driver.request('certificate-configure',{domain:'panel.example.com',email:'certificate@example.com'});await driver.request('certificate-issue');await page.locator('#refresh-state').filter({hasText:'更新于'}).waitFor();await page.locator('.sidebar [data-page=services]').click();
   await page.locator('[data-setting="'+(role==='exit'?'面板HTTPS证书（可选）':'域名与证书')+'"] > summary').click();await page.locator('[data-certificate-state]').filter({hasText:'有效期至：'}).waitFor();assert.match(await page.locator('[data-certificate-state]').innerText(),/剩余 \d+ 天/);assert.match(await page.locator('#simple-certificate').locator('..').locator('..').locator('.service-setting-summary-note').innerText(),/有效至/);if(role==='exit')assert.equal(await page.locator('#simple-certificate [name=domain]').inputValue(),'panel.example.com');
   await page.locator('[data-setting="TCP加速"] summary').click();
   for(const width of[1440,390]){
    await page.setViewportSize({width,height:1000});await page.locator('#tcp-acceleration').scrollIntoViewIfNeeded();
    const measurements=await page.locator('#tcp-acceleration .check-row').evaluateAll(nodes=>nodes.map(n=>{const s=n.querySelector('span'),r=s.getBoundingClientRect();return{height:r.height,line:parseFloat(getComputedStyle(s).lineHeight),input:n.querySelector('input').getBoundingClientRect().width};}));assert.ok(measurements.every(n=>n.height<n.line*1.5&&n.input<=24),JSON.stringify(measurements));
    if(width>650){await page.locator('[data-help=tcpMode-bbrx]').hover();await page.locator('.help-popover').filter({hasText:'自研BBRX算法'}).waitFor();assert.ok(!(await page.locator('.help-popover').innerText()).includes('保留旧用户凭证'));
     const position=await page.evaluate(()=>{const owner=document.querySelector('[data-help=tcpMode-bbrx]').getBoundingClientRect(),tip=document.querySelector('.help-popover').getBoundingClientRect();return{gap:Math.min(Math.abs(tip.top-owner.bottom),Math.abs(owner.top-tip.bottom)),overlap:tip.left<=owner.right&&tip.right>=owner.left,inside:tip.left>=0&&tip.right<=innerWidth&&tip.top>=0&&tip.bottom<=innerHeight};});assert.ok(position.gap<=9&&position.overlap&&position.inside,JSON.stringify(position));await page.mouse.move(1,1);}
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({animations:'disabled',path:'test-results/'+role+'-tcp-'+width+'.png'});
   }
   await page.setViewportSize({width:1440,height:1000});await page.locator('[data-setting="Bark手机提醒"] > summary').click();
   await page.route('**/api/bark/test',async route=>{await new Promise(r=>setTimeout(r,700));await route.fulfill({contentType:'application/json',body:'{"accepted":true}'});});
   const button=page.locator('[data-bark-test]');await button.click();await page.locator('[data-bark-test][data-busy]').waitFor();assert.equal(await page.getByText('正在处理，请稍候…',{exact:true}).count(),0);await page.locator('#simple-bark .actions .action-feedback').filter({hasText:'测试通知已提交'}).waitFor();assert.equal(await button.isEnabled(),true);assert.equal(await page.locator('#task-status').count(),0);assert.equal(await page.locator('#toast:visible').count(),0);
   await page.screenshot({animations:'disabled',path:'test-results/'+role+'-bark-feedback.png'});
   if(role==='exit'){
    await page.locator('[data-setting="连接中转端"] summary').click();
    for(const width of[1440,390]){
     await page.setViewportSize({width,height:1000});const input=page.locator('[name=attKey]');await input.focus();const heading=await input.locator('..').locator('.field-label').boundingBox(),field=await input.boundingBox();assert.ok(heading.y+heading.height+6<=field.y);await page.screenshot({animations:'disabled',path:'test-results/exit-att-label-'+width+'.png'});
    }
   }
   await page.setViewportSize({width:1440,height:1000});await page.locator('.sidebar [data-page=settings]').click();
   await page.locator('[data-config-tab=general]').waitFor();assert.equal(await page.locator('#account-form [name=password]').getAttribute('minlength'),null);assert.equal(await page.locator('#account-form [name=password]').getAttribute('maxlength'),null);assert.equal(await page.locator('.sidebar .action-feedback').count(),0);assert.equal(await page.getByText('操作已完成',{exact:true}).count(),0);
   for(const tab of['general','appearance','connection']){await page.locator('[data-config-tab='+tab+']').click();assert.equal(await page.getByRole('button',{name:role==='exit'?'切换为中转机':'切换为出口机',exact:true}).isVisible(),false);assert.equal(await page.getByText('备份、日志与诊断',{exact:true}).isVisible(),false);}
   assert.equal(await page.locator('[name=useDomainCertificate]').count(),0);assert.equal(await page.locator('[name=ipAccess]').isChecked(),true);await page.locator('[name=ipAccess]').uncheck();let accessPayload=null;await page.route('**/api/panel-network',async route=>{if(route.request().method()!=='PUT')return route.continue();accessPayload=route.request().postDataJSON();await route.fulfill({contentType:'application/json',body:JSON.stringify({accepted:true,url:'https://panel.example.test:18443/example/'})});});page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'保存并检查新连接',exact:true}).click();await page.getByRole('link',{name:'打开新入口',exact:true}).waitFor();assert.deepEqual(accessPayload,{port:18443,ipAccess:false});
   await page.locator('[data-config-tab=advanced]').click();await page.getByText('高级：切换服务器角色',{exact:true}).click();assert.equal(await page.getByRole('button',{name:role==='exit'?'切换为中转机':'切换为出口机',exact:true}).count(),1);
   assert.equal(await page.locator('[name=probeEnabled],[name=probeIntervalMinutes]').count(),0);assert.equal(await page.getByText('开启国内站点 TCP 连通性参考检测',{exact:true}).count(),0);
   await page.getByText('系统维护：急停、更新与卸载',{exact:true}).click();await page.locator('[data-system-maintenance] #uninstall-panel').waitFor();assert.equal(await page.locator('[name=repository],#repository-form').count(),0);assert.equal(await page.locator('[data-module=health]').count(),0);assert.equal(await page.locator('[data-system-maintenance] [data-emergency-stop]').count(),1);assert.equal(await page.locator('[data-system-maintenance] #check-updates').count(),1);
   await page.getByText('备份、日志与诊断',{exact:true}).click();await page.locator('#export-form').waitFor();assert.equal(await page.locator('.feature-list').count(),0);assert.equal(await page.getByText('开发中',{exact:true}).count(),0);
   assert.deepEqual(errors,[]);
  }finally{await page.close();await app.close();rmSync(directory,{recursive:true,force:true});}
 }
});
