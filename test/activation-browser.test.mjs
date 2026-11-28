import test from'node:test';
import assert from'node:assert/strict';
import{mkdtempSync,rmSync,mkdirSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{chromium}from'playwright';
import{createApp}from'../src/server.mjs';
import{setupDriver}from'./setup-fixture.mjs';
import{token,digest,verifyPassword}from'../src/security.mjs';
for(const role of['relay','exit'])test(role+'：首次欢迎激活、网页创建账户、刷新保留进度和按钮对齐',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'llhh-activation-')),driver=setupDriver(),app=await createApp({directory,password:'fixture-internal',systemRequest:driver.request,onboarding:true,healthEnabled:false});let browser;
 t.after(async()=>{await browser?.close();await app.close();rmSync(directory,{recursive:true,force:true});});
 app.store.set('settings',{...app.store.get('settings'),role});app.store.set('onboarding',{version:2,welcome:true,step:'welcome',completed:[],draft:{}});const setup=token();app.store.set('bootstrap-access',{hash:digest(setup),expires:Date.now()+60000});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,args:process.platform==='win32'?['--disable-gpu','--disable-gpu-compositing']:[],executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined)});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+app.server.address().port+'/'+app.store.get('entrance').value+'/#setup='+setup);
 await page.getByRole('heading',{name:'欢迎使用 LLHH'}).waitFor();assert.equal(await page.locator('input').count(),0);assert.ok(!page.url().includes(setup));mkdirSync('test-results',{recursive:true});assert.equal(await page.locator('.activation-hello').evaluate(e=>getComputedStyle(e).animationDuration),'2.4s');assert.ok(await page.locator('.activation-hello').evaluate(e=>Number(getComputedStyle(e).opacity)<1));await page.waitForTimeout(2800);assert.equal(await page.locator('.activation-hello').evaluate(e=>getComputedStyle(e).opacity),'1');await page.screenshot({path:'test-results/activation-welcome.png'});
 const activate=page.getByRole('button',{name:'激活面板'});await activate.hover();await page.waitForTimeout(200);assert.deepEqual(await activate.evaluate(b=>({background:getComputedStyle(b).backgroundColor,color:getComputedStyle(b).color})),{background:'rgb(32, 93, 221)',color:'rgb(255, 255, 255)'});
 await page.getByRole('button',{name:'激活面板'}).click();await page.locator('[name=username]').fill('我的账户');await page.locator('[name=password]').fill('自定密码');await page.locator('[name=repeat]').fill('自定密码');await page.getByRole('button',{name:'保存并继续',exact:true}).click();await page.locator('[name=serverName]').waitFor();const account=app.store.db.prepare('SELECT username,password FROM admin').get();assert.equal(account.username,'我的账户');assert.equal(await verifyPassword('自定密码',account.password),true);await page.reload();await page.locator('[name=serverName]').waitFor();await page.locator('[name=serverName]').fill('测试面板');await page.getByRole('button',{name:'保存并继续',exact:true}).click();if(role==='exit'){await page.getByRole('heading',{name:'手机提醒',exact:true}).waitFor();await page.getByRole('button',{name:'稍后配置',exact:true}).click();await page.locator('[data-next]').waitFor();}else await page.getByRole('heading',{name:'选择协议',exact:true}).waitFor();
 for(const width of[1440,390]){await page.setViewportSize({width,height:900});const row=page.locator('.onboarding-actions');const back=await row.getByRole('button',{name:'上一步'}).boundingBox(),next=await row.getByRole('button',{name:role==='exit'?'继续':'保存并继续',exact:true}).boundingBox();assert.ok(Math.abs(back.y-next.y)<2);assert.ok(back.height>=44&&next.height>=44);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:`test-results/activation-account-footer-${width}.png`});}
 if(role==='relay'){
  await page.getByRole('button',{name:'保存并继续',exact:true}).click();await page.getByRole('heading',{name:'域名与证书',exact:true}).waitFor();
  for(const width of[1440,390]){await page.setViewportSize({width,height:900});const footer=page.locator('.onboarding-actions');const back=await footer.getByRole('button',{name:'上一步'}).boundingBox(),next=await footer.getByRole('button',{name:'检查并申请证书'}).boundingBox();assert.ok(Math.abs(back.y-next.y)<2);assert.ok(back.height>=44);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
  await page.getByRole('button',{name:'上一步'}).click();await page.getByRole('heading',{name:'选择协议',exact:true}).waitFor();assert.ok(await page.locator('[name=protocol][value=hy2]').isChecked());await page.locator('[name=protocol][value=hy2]').uncheck();await page.locator('[name=protocol][value=vmess]').check();await page.getByRole('button',{name:'保存并继续',exact:true}).click();await page.getByRole('heading',{name:'手机提醒',exact:true}).waitFor();assert.equal(driver.calls.filter(c=>c.action==='certificate-issue').length,0);
 }
 assert.deepEqual(errors,[]);
});
