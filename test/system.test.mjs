import test from'node:test';
import assert from'node:assert/strict';
import{mkdtempSync,readFileSync,writeFileSync,rmSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{createSystemDriver}from'../src/system-driver.mjs';
import{serviceUnits}from'../src/service-units.mjs';
import{createAgent}from'../src/agent.mjs';
import{retryAgentBusy}from'../src/agent-client.mjs';
import{openStore}from'../src/store.mjs';
import{saveNetwork,networkView,saveRelay,serviceAction,relayView,readSecret,liveUsers}from'../src/deployment.mjs';
import{wgKeys}from'../src/network.mjs';
import{randomUUID,createHash}from'node:crypto';
import{newCredentials}from'../src/backup.mjs';
import{nftFingerprint}from'../src/nft-integrity.mjs';
import{tripFuse}from'../src/safety-fuses.mjs';

const uids={'vmess.att':900,'vmess.direct':901,'hy2.att':902,'hy2.direct':903};
test('WG服务仍active但接口消失时重新执行启动，恢复失败不返回成功，新的停止锁仍优先',{skip:process.platform!=='linux'},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-network-recovery-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 writeFileSync(join(directory,'system.json'),JSON.stringify({role:'exit',network:{role:'exit',wireguardInterface:'vps-wg'},networkDesired:false}));
 writeFileSync(join(directory,'network-runtime.json'),JSON.stringify({bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()}));
 const rules='{"nftables":[]}',digest=nftFingerprint(rules);writeFileSync(join(directory,'forward-integrity.json'),JSON.stringify({'inet.vps_panel_forward':digest,'ip.vps_panel_nat':digest}));
 let exists=false,canRestore=true,stopDuringStart=false;const calls=[];
 const driver=createSystemDriver({directory,runner:async(binary,args)=>{
  calls.push([binary,args]);
  if(binary.endsWith('/wg')){if(!exists)throw Object.assign(new Error('missing interface'),{code:1});return{stdout:'private\tpublic\t51874\t0\n'};}
  if(binary.endsWith('/nft'))return{stdout:rules};
  if(binary.endsWith('/systemctl')&&['start','restart'].includes(args[0])){exists=canRestore;if(stopDuringStart)tripFuse(directory,'network');}
  return{stdout:''};
 }});
 assert.equal((await driver.action('network-up')).up,true);assert.equal(calls.filter(([,args])=>args[0]==='restart').length,1);
 await driver.action('network-up');assert.equal(calls.filter(([,args])=>args[0]==='restart').length,1,'健康隧道不应被重复重启');
 exists=false;canRestore=false;await assert.rejects(driver.action('network-up'),/未恢复/);
 canRestore=true;stopDuringStart=true;await assert.rejects(driver.action('network-up'),/停止/);
});
test('管理器只调用固定二进制及线路；手动停止先持久化，急停禁止启动',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-driver-test-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 writeFileSync(join(directory,'system.json'),JSON.stringify({relay:{},desired:{'vmess.att':true},emergencyStop:true}));
 const calls=[];const driver=createSystemDriver({directory,runner:async(binary,args,options)=>{
  assert.equal(options.shell,undefined);calls.push([binary,args]);
  if(args[0]==='stop')assert.equal(JSON.parse(readFileSync(join(directory,'system.json'))).desired['vmess.att'],false);
  return{stdout:'ActiveState=inactive\nSubState=dead\nInvocationID=\nMainPID=0\nResult=success\n'};
 }});
 await driver.stop('vmess.att');assert.ok(calls.some(call=>call[1][0]==='disable'));
 await assert.rejects(driver.action('start',{stream:'vmess.att'}),/急停/);
 await assert.rejects(driver.action('stop',{stream:'vmess.att; reboot'}));
 await assert.rejects(driver.action('shell',{command:'reboot'}));
 assert.ok(calls.every(call=>call[0]==='/usr/bin/systemctl'||call[0]==='/usr/sbin/ufw'&&call[1][0]==='status'));
});
test('网页保存配对和协议只停不启动，密钥不回显，输入不能指定服务身份或执行命令',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-deployment-test-'));const store=await openStore({directory,password:'test-password'});
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const calls=[],request=async(action,data)=>{calls.push([action,data]);return action==='inspect'?{uids}:{configured:true,started:false};};
 const config={physicalInterface:'eth0',address:'10.76.0.2',listenPort:51820,peers:[{publicKey:wgKeys().publicKey,address:'10.76.0.1',endpointIPv4:'198.51.100.1',endpointPort:51874}]};
 const view=await saveNetwork(store,config,request);assert.equal(view.privateKey,undefined);assert.ok(view.publicKey);
 assert.equal(JSON.stringify(networkView(store)).includes('privateKey'),false);
 const result=await saveRelay(store,{domain:'relay.example.test',publicIPv4:'192.0.2.1',ports:{vmess:{att:18001,direct:18002},hy2:{att:443,direct:8443}}},request);
 assert.equal(result.configured,true);assert.equal(result.stats,undefined);assert.equal(store.get('runtime').maintenance,true);
 assert.ok(!calls.some(call=>call[0]==='start'));
 await assert.rejects(saveNetwork(store,{...config,command:'id'},request));
 await assert.rejects(saveRelay(store,{uids,domain:'test'},request));
 store.set('runtime',{maintenance:true,emergencyStop:true});await assert.rejects(serviceAction(store,{action:'start',stream:'hy2.att'},request));
});
test('系统服务独立认证/统计、低权限核心，启动前重新检查额度；重启有退避限制',()=>{
 const units=serviceUnits();assert.equal(Object.keys(units).length,11);
 for(const stream of['vmess-att','vmess-direct','hy2-att','hy2-direct']){
  const text=units['vps-panel-'+stream+'.service'];assert.ok(text.includes('User=vps-panel-'+stream));
  assert.ok(text.includes('src/core-prestart.mjs '+stream.replace('-','.')));assert.ok(text.includes('StartLimitBurst=5'));
  assert.ok(!text.includes('CAP_NET_ADMIN'));assert.ok(!text.includes('LoadCredential=config.json'));
  assert.ok(text.includes('BindsTo=vps-panel-worker.service'));
 }
 assert.ok(units['vps-panel-worker.service'].includes('src/runtime-worker.mjs'));
 assert.ok(units['vps-panel-worker.service'].includes('WatchdogSec=120'));
 assert.ok(units['vps-panel-worker.service'].includes('Type=notify'));
 for(const name of['agent','network'])assert.ok(units['vps-panel-'+name+'.service'].includes('/run -/etc/ufw -/lib/ufw -/var/lib/ufw'));
 assert.ok(!units['vps-panel-hy2-att.service'].includes('Requires=vps-panel-web.service'));
});
test('本机系统代理拒绝任意路径/动作；错误不回显命令或密钥',async t=>{
 const agent=createAgent({driver:{action:async action=>{if(action==='status')return{ok:true};throw new Error('secret-test-key');}}});
 await new Promise(resolve=>agent.server.listen(0,'127.0.0.1',resolve));t.after(()=>agent.close());
 const url='http://127.0.0.1:'+agent.server.address().port;
 assert.equal((await fetch(url+'/arbitrary')).status,404);
 const response=await fetch(url,{method:'POST',body:JSON.stringify({action:'shell',data:{}})});assert.equal(response.status,500);assert.ok(!(await response.text()).includes('secret-test-key'));
});

test('更换出口配对先停用旧协议，保留填写内容待确认；重新保存后使用新配对',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-repair-pairing-')),store=await openStore({directory,password:'test-password'});
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 let changed=false;const request=async action=>action==='inspect'?{uids}:action==='configure-network'?{relayNeedsConfirmation:changed}:{configured:true};
 const network={physicalInterface:'eth0',address:'10.76.0.2',listenPort:51820,peers:[{publicKey:wgKeys().publicKey,address:'10.76.0.1',endpointIPv4:'198.51.100.1',endpointPort:51874}]};
 const relay={domain:'relay.example.test',publicIPv4:'192.0.2.1',ports:{vmess:{att:18001,direct:18002},hy2:{att:443,direct:8443}}};
 await saveNetwork(store,network,request);await saveRelay(store,relay,request);const before=readSecret(store,'relay-config');
 changed=true;const next={...network,peers:[{...network.peers[0],publicKey:wgKeys().publicKey}]};
 assert.equal((await saveNetwork(store,next,request)).relayNeedsConfirmation,true);
 assert.equal(relayView(store).configured,false);assert.equal(relayView(store).domain,relay.domain);
 await assert.rejects(serviceAction(store,{action:'start',stream:'vmess.direct'},request),/配置代理线路/);
 await saveRelay(store,relay,request);const after=readSecret(store,'relay-config');
 assert.equal(after.endpointPublicKey,next.peers[0].publicKey);assert.deepEqual(after.stats,before.stats);assert.equal(store.get('relay-pending'),null);
});

test('切换服务器角色保留全局管理连接与策略，协议仍全部停止',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-role-global-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const shared={panelUseAcme:true,initialOrigin:'https://192.0.2.1:18443',panelCertificateFingerprint:'test-fingerprint',autoStart:true,autoRepair:true};
 writeFileSync(join(directory,'system.json'),JSON.stringify({...shared,role:'relay',archives:{exit:{panelUseAcme:false,autoRepair:false}}}));
 const driver=createSystemDriver({directory,runner:async binary=>({stdout:binary.endsWith('ufw')?'Status: inactive\n':'ActiveState=inactive\n'})});
 await driver.action('switch-role',{role:'exit',confirmed:true});
 const state=JSON.parse(readFileSync(join(directory,'system.json')));for(const[key,value]of Object.entries(shared))assert.equal(state[key],value);
 assert.equal(state.role,'exit');assert.equal(state.emergencyStop,true);assert.ok(Object.values(state.desired).every(value=>value===false));
});

test('核心运行不等于新用户权限已生效；凭证变更后重新显示等待同步',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-user-applied-')),store=await openStore({directory,password:'test-password'});t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const id=randomUUID(),secret=newCredentials(),row={id,protocols:['vmess'],exits:['direct'],enabled:true,quota:null,expires:null,up:0,down:0};
 store.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)').run(id,'测试',1,'["vmess"]','["direct"]',null,null,store.seal(JSON.stringify(secret)),store.clock());
 store.set('service-status',{at:store.clock(),profiles:{'vmess.direct':{active:true,epoch:'test'}}});
 assert.equal(liveUsers(store,[row])[0].deployment,'等待权限同步');
 store.set('access-applied',{'vmess.direct':{epoch:'test',users:{[id]:createHash('sha256').update(secret.vmess).digest('hex')}}});
 assert.equal(liveUsers(store,[row])[0].deployment,'已部署');
 store.db.prepare('UPDATE users SET credentials=? WHERE id=?').run(store.seal(JSON.stringify(newCredentials())),id);
 assert.equal(liveUsers(store,[row])[0].deployment,'等待权限同步');
 assert.equal(liveUsers(store,[row])[0].online,null,'运行中但采集缺失不能伪装离线');
 store.set('service-status',{at:store.clock(),profiles:{'vmess.direct':{active:false}}});assert.equal(liveUsers(store,[{...row,last_online:store.clock()-60000}])[0].online,false,'全部获配线路停止后明确离线');
});

test('系统传输允许Hy2证书更新动作中的数字，非法格式不会到达执行器',async t=>{
 const calls=[],agent=createAgent({driver:{action:async(action,data)=>{calls.push({action,data});return{active:true,epoch:'renewed'};}}});
 await new Promise(resolve=>agent.server.listen(0,'127.0.0.1',resolve));t.after(()=>agent.close());
 const url='http://127.0.0.1:'+agent.server.address().port;
 const request=action=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,data:{stream:'hy2.att'}})});
 const valid=await request('reload-hy2-certificate');assert.equal(valid.status,200);assert.equal((await valid.json()).epoch,'renewed');
 for(const action of['reload-hy2-certificate;reboot','Reload-hy2-certificate','2reload','reload/hy2-certificate'])assert.equal((await request(action)).status,400);
 assert.deepEqual(calls,[{action:'reload-hy2-certificate',data:{stream:'hy2.att'}}]);
});

test('权限同步仅重试明确的管理器占用，达到上限或其他错误仍失败',async()=>{
 let calls=0;const busy=()=>Object.assign(new Error('busy'),{code:'AGENT_ERROR',statusCode:409});
 assert.equal(await retryAgentBusy(async()=>{if(++calls<3)throw busy();return'ok';},{attempts:3,delay:1}),'ok');assert.equal(calls,3);
 calls=0;await assert.rejects(retryAgentBusy(async()=>{calls++;throw busy();},{attempts:3,delay:1}));assert.equal(calls,3);
 calls=0;await assert.rejects(retryAgentBusy(async()=>{calls++;throw Object.assign(new Error('failed'),{code:'AGENT_ERROR',statusCode:500});},{attempts:3,delay:1}));assert.equal(calls,1);
});
