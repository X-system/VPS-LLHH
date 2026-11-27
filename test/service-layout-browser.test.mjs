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
   await page.locator('#refresh-state').filter({hasText:'更新于'}).waitFor();await page.locator('.sidebar [data-page=services]').click();
   await page.locator('[data-setting="TCP加速"] summary').click();
   for(const width of[1440,390]){
    await page.setViewportSize({width,height:1000});await page.locator('#tcp-acceleration').scrollIntoViewIfNeeded();
    const measurements=await page.locator('#tcp-acceleration .check-row').evaluateAll(nodes=>nodes.map(n=>{const s=n.querySelector('span'),r=s.getBoundingClientRect();return{height:r.height,line:parseFloat(getComputedStyle(s).lineHeight),input:n.querySelector('input').getBoundingClientRect().width};}));assert.ok(measurements.every(n=>n.height<n.line*1.5&&n.input<=24),JSON.stringify(measurements));
    if(width>650){await page.locator('[data-help=tcpMode-bbrx]').hover();await page.locator('.help-popover').filter({hasText:'自研BBRX算法'}).waitFor();assert.ok(!(await page.locator('.help-popover').innerText()).includes('保留旧用户凭证'));await page.mouse.move(1,1);}
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({animations:'disabled',path:'test-results/'+role+'-tcp-'+width+'.png'});
   }
   await page.setViewportSize({width:1440,height:1000});await page.locator('[data-setting="Bark手机提醒"] summary').click();
   await page.route('**/api/bark/test',async route=>{await new Promise(r=>setTimeout(r,700));await route.fulfill({contentType:'application/json',body:'{"accepted":true}'});});
   const button=page.locator('[data-bark-test]');await button.click();await page.locator('#simple-bark .actions .action-feedback[data-kind=pending]').waitFor();await page.locator('#simple-bark .actions .action-feedback').filter({hasText:'测试通知已提交'}).waitFor();assert.equal(await button.isEnabled(),true);assert.equal(await page.locator('#task-status').count(),0);assert.equal(await page.locator('#toast:visible').count(),0);
   await page.screenshot({animations:'disabled',path:'test-results/'+role+'-bark-feedback.png'});
   if(role==='exit'){
    await page.locator('[data-setting="连接中转端"] summary').click();
    for(const width of[1440,390]){
     await page.setViewportSize({width,height:1000});const input=page.locator('[name=attKey]');await input.focus();const heading=await input.locator('..').locator('.field-label').boundingBox(),field=await input.boundingBox();assert.ok(heading.y+heading.height+6<=field.y);await page.screenshot({animations:'disabled',path:'test-results/exit-att-label-'+width+'.png'});
    }
   }
   assert.deepEqual(errors,[]);
  }finally{await page.close();await app.close();rmSync(directory,{recursive:true,force:true});}
 }
});
