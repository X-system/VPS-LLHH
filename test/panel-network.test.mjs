import test from'node:test';
import assert from'node:assert/strict';
import{mkdtemp,mkdir,writeFile,readFile,rm,access}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{executeRebind}from'../src/rebind-panel.mjs';
import{createPanelNetwork}from'../src/panel-network.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'vps-panel-network-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'certs'));for(const name of['panel-fullchain.pem','panel-privkey.pem'])await writeFile(join(root,'certs',name),'original-'+name);
 await writeFile(join(root,'web.env'),'VPS_HOST=0.0.0.0\nVPS_PORT=18443\nVPS_ORIGIN=https://192.0.2.1:18443\n');
 let state={role:'relay',emergencyStop:true};await writeFile(join(root,'system.json'),JSON.stringify(state));
 const calls=[],firewall={allowPort:async(...args)=>calls.push(['allow',...args]),removeOwned:async(...args)=>calls.push(['remove',...args])};
 const options={directory:root,getState:async()=>state,saveState:async value=>{state=value;await writeFile(join(root,'system.json'),JSON.stringify(value));},certificates:{status:async()=>({})},firewall,
  begin:()=>writeFile(join(root,'maintenance.lock'),'test'),release:()=>rm(join(root,'maintenance.lock'))};
 return{root,calls,firewall,options};
}

test('新管理连接通过自检后保留新端口；通知失败不回退健康连接',async t=>{
 const f=await fixture(t);const panel=createPanelNetwork({...f.options,schedule:async()=>{}});
 const result=await panel.configure({port:18445,useDomainCertificate:false});assert.equal(result.port,18445);
 assert.deepEqual(f.calls[0],['allow',18445,'tcp','vps-panel-web']);
 let restarted=0;
 assert.deepEqual(await executeRebind({root:f.root,firewall:f.firewall,restart:async()=>restarted++,health:async()=>true,notify:async()=>{throw new Error('offline');}}),{ok:true});
 assert.equal(restarted,1);assert.match(await readFile(join(f.root,'web.env'),'utf8'),/VPS_PORT=18445/);
 const record=JSON.parse(await readFile(join(f.root,'panel-rebind-state.json')));assert.equal(record.notificationFailed,true);
 assert.deepEqual(f.calls.at(-1),['remove',['vps-panel-web'],{keepPorts:[18445]}]);
 await assert.rejects(access(join(f.root,'maintenance.lock')));
});

test('新管理连接自检失败，恢复原端口和证书；急停状态保留',async t=>{
 const f=await fixture(t);await createPanelNetwork({...f.options,schedule:async()=>{}}).configure({port:18445,useDomainCertificate:false});
 let checks=0,restarts=0;
 const result=await executeRebind({root:f.root,firewall:f.firewall,restart:async()=>restarts++,health:async()=>{if(++checks===1)throw new Error('unhealthy');}});
 assert.deepEqual(result,{ok:false,rolledBack:true});assert.equal(restarts,2);
 assert.match(await readFile(join(f.root,'web.env'),'utf8'),/VPS_PORT=18443/);
 assert.equal(JSON.parse(await readFile(join(f.root,'system.json'))).emergencyStop,true);
 assert.deepEqual(f.calls.at(-1),['remove',['vps-panel-web'],{keepPorts:[18443]}]);
});

test('管理端口变更在重启后同步节点防护，防护失败回退并恢复旧端口规则',async t=>{
 const f=await fixture(t);await createPanelNetwork({...f.options,schedule:async()=>{}}).configure({port:18445,useDomainCertificate:false});
 const seen=[];let first=true;
 const result=await executeRebind({root:f.root,firewall:f.firewall,
  restart:async()=>seen.push('restart'),
  syncGuard:async()=>{seen.push((await readFile(join(f.root,'web.env'),'utf8')).match(/VPS_PORT=(\d+)/)[1]);if(first){first=false;throw new Error('guard update failed');}},
  health:async()=>seen.push('health')});
 assert.deepEqual(result,{ok:false,rolledBack:true});
 assert.deepEqual(seen,['restart','18445','restart','18443','health']);
});

test('正常改端口先同步防护再自检，不触碰用户或线路启停状态',async t=>{
 const f=await fixture(t);await createPanelNetwork({...f.options,schedule:async()=>{}}).configure({port:18445,useDomainCertificate:false});
 const order=[];
 assert.deepEqual(await executeRebind({root:f.root,firewall:f.firewall,restart:async()=>order.push('restart'),syncGuard:async()=>order.push('guard'),health:async()=>order.push('health')}),{ok:true});
 assert.deepEqual(order,['restart','guard','health']);assert.equal(JSON.parse(await readFile(join(f.root,'system.json'))).emergencyStop,true);
});

test('调度失败立即撤销连接设置并释放维护锁；回退失败明确标记需SSH恢复',async t=>{
 const f=await fixture(t);
 await assert.rejects(createPanelNetwork({...f.options,schedule:async()=>{throw new Error('schedule failed');}}).configure({port:18445,useDomainCertificate:false}),/schedule failed/);
 assert.match(await readFile(join(f.root,'web.env'),'utf8'),/VPS_PORT=18443/);
 await assert.rejects(access(join(f.root,'maintenance.lock')));
 await createPanelNetwork({...f.options,schedule:async()=>{}}).configure({port:18445,useDomainCertificate:false});
 await assert.rejects(executeRebind({root:f.root,firewall:f.firewall,restart:async()=>{throw new Error('failed');}}),/SSH/);
 assert.equal(JSON.parse(await readFile(join(f.root,'panel-rebind-state.json'))).needsRecovery,true);
 await assert.rejects(access(join(f.root,'maintenance.lock')));
});

test('启用正式域名证书保留原IP入口，改端口同步两个地址，关闭域名证书恢复IP地址',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t);f.options.certificates.status=async()=>({certificateStaging:false,certificateDomain:'panel.example.test',notAfter:Date.now()+86400000,fingerprint:'test-only'});
 await mkdir(join(f.root,'certs/current'));for(const name of['fullchain.pem','privkey.pem'])await writeFile(join(f.root,'certs/current',name),'issued-fixture-'+name);
 const panel=createPanelNetwork({...f.options,schedule:async()=>{}});
 await panel.configure({port:18445,ipAccess:true});
 const current=await panel.status();assert.equal(current.origin,'https://panel.example.test:18445');
 assert.deepEqual(current.allowedOrigins,['https://panel.example.test:18445','https://192.0.2.1:18445']);
 await f.options.release();await panel.configure({port:18446,useDomainCertificate:false});
 const restored=await panel.status();assert.equal(restored.origin,'https://192.0.2.1:18446');assert.deepEqual(restored.allowedOrigins,['https://192.0.2.1:18446']);
 assert.equal(await readFile(join(f.root,'certs/panel-fullchain.pem'),'utf8'),'original-panel-fullchain.pem');
});

test('没有有效域名或解析不指向本机时，关闭IP访问不修改现有设置',async t=>{
 const f=await fixture(t),before=await readFile(join(f.root,'web.env'),'utf8');let scheduled=false;
 const panel=createPanelNetwork({...f.options,schedule:async()=>{scheduled=true;},resolveDomain:async()=>['192.0.2.99']});
 assert.equal((await panel.status()).ipAccess,true);await assert.rejects(panel.configure({port:18443,ipAccess:false}),/证书/);
 f.options.certificates.status=async()=>({certificateStaging:false,certificateDomain:'panel.example.test',notAfter:Date.now()+86400000});
 await assert.rejects(panel.configure({port:18443,ipAccess:false}),/指向本机/);assert.equal(await readFile(join(f.root,'web.env'),'utf8'),before);assert.equal(scheduled,false);
});

test('关闭IP仅保留域名，跨实例持久化；失败回退恢复IP开关，重新勾选不切掉域名证书',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t);f.options.certificates.status=async()=>({certificateStaging:false,certificateDomain:'panel.example.test',notAfter:Date.now()+86400000,fingerprint:'test-only'});
 await mkdir(join(f.root,'certs/current'));for(const name of['fullchain.pem','privkey.pem'])await writeFile(join(f.root,'certs/current',name),'issued-fixture-'+name);
 const options={...f.options,schedule:async()=>{},resolveDomain:async()=>['192.0.2.1']},panel=createPanelNetwork(options);
 await panel.configure({port:18443,ipAccess:false});let current=await createPanelNetwork(options).status();assert.equal(current.ipAccess,false);assert.deepEqual(current.allowedOrigins,['https://panel.example.test:18443']);assert.equal(current.useDomainCertificate,true);
 let checks=0;await executeRebind({root:f.root,firewall:f.firewall,restart:async()=>{},syncGuard:async()=>{},health:async()=>{if(++checks===1)throw Error('unhealthy');}});assert.equal((await panel.status()).ipAccess,true);
 await panel.configure({port:18443,ipAccess:false});await f.options.release();await panel.configure({port:18443,ipAccess:true});current=await panel.status();assert.equal(current.ipAccess,true);assert.equal(current.useDomainCertificate,true);assert.deepEqual(current.allowedOrigins,['https://panel.example.test:18443','https://192.0.2.1:18443']);
});
