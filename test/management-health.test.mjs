import test from'node:test';
import assert from'node:assert/strict';
import https from'node:https';
import{probeManagement}from'../src/management-health.mjs';
import{certificate}from'./tls-fixture.mjs';
const entrance='AaBbCcDdEe1234567_~-',tls=certificate();
async function fixture(t,{rootStatus=404,delay=0}={}){
 const paths=[],timers=new Set();let connections=0;
 const server=https.createServer(tls,(req,res)=>{paths.push(req.url);const timer=setTimeout(()=>{timers.delete(timer);if(res.destroyed)return;res.writeHead(req.url==='/'?rootStatus:200,{'Content-Type':'application/json'});res.end(JSON.stringify(req.url==='/'?{error:'Not found'}:{serverName:'测试面板',role:'relay'}));},delay);timers.add(timer);});server.on('secureConnection',()=>connections++);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{for(const timer of timers)clearTimeout(timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 return{options:{origin:'https://127.0.0.1:'+server.address().port,ca:tls.cert,entrance,attempts:1,requestTimeout:2000,totalTimeout:5000,retryDelay:0},paths,connections:()=>connections};
}
test('启动检查同时确认元数据和根路径404，复用同一条已验证TLS连接',async t=>{
 const f=await fixture(t,{delay:30});assert.equal(await probeManagement(f.options),true);assert.deepEqual(f.paths,[`/${entrance}/api/meta`,'/']);assert.equal(f.connections(),1);
});
test('根路径暴露页面或证书名称不匹配时拒绝安装成功',async t=>{
 const f=await fixture(t,{rootStatus:200});await assert.rejects(probeManagement(f.options),/自检未通过/);
 const good=await fixture(t);await assert.rejects(probeManagement({...good.options,origin:'https://11.0.0.2:'+new URL(good.options.origin).port}),/自检未通过/);assert.equal(good.paths.length,0);await assert.rejects(probeManagement({...good.options,ca:[]}),/自检未通过/);
});
test('慢启动可在请求预算内完成，整体截止时间不会被重试或持续等待无限延长',async t=>{
 const f=await fixture(t,{delay:100});assert.equal(await probeManagement({...f.options,requestTimeout:1000,totalTimeout:3000}),true);
 const stalled=await fixture(t,{delay:5000}),started=performance.now();await assert.rejects(probeManagement({...stalled.options,attempts:60,requestTimeout:10000,totalTimeout:250}),/自检未通过/);assert.ok(performance.now()-started<2500);
});
