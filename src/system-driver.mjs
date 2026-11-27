import{execFile}from'node:child_process';
import{promisify}from'node:util';
import{mkdir,readFile,writeFile,rename,lstat,unlink}from'node:fs/promises';
import{randomBytes}from'node:crypto';
import{join}from'node:path';
import{networkInterfaces}from'node:os';
import{isIP}from'node:net';
import{publicProbeIPv4}from'./node-health.mjs';
import{buildRelayConfigs,buildFailClosed,validateRelay}from'./core-config.mjs';
import{validateNetwork,wgConfig,exitRules,routePlan,wgPublic,ownsRouteRule}from'./network.mjs';
import{streams}from'./access.mjs';
import{user as validateUser}from'./validation.mjs';
import{createCertificateManager}from'./certificates.mjs';
import{createFirewall}from'./firewall.mjs';
import{probeBindings}from'./bindings.mjs';
import{createUpdateManager}from'./updates.mjs';
import{createPanelNetwork,parseWebEnvironment}from'./panel-network.mjs';
import{createTcpAcceleration}from'./tcp-acceleration.mjs';
import{readFuse,tripFuse,tripped,clearFuse}from'./safety-fuses.mjs';

const execute=promisify(execFile);
const unitFor=stream=>{if(!streams.includes(stream))throw new Error('线路标识错误');return'vps-panel-'+stream.replace('.','-')+'.service';};
const binaries={systemctl:'/usr/bin/systemctl',systemdRun:'/usr/bin/systemd-run',flock:'/usr/bin/flock',ip:'/usr/sbin/ip',wg:'/usr/bin/wg',nft:'/usr/sbin/nft',sysctl:'/usr/sbin/sysctl',journalctl:'/usr/bin/journalctl'};
export async function atomicWrite(path,content,mode=0o600){
 const temporary=path+'.'+randomBytes(12).toString('hex')+'.tmp';
 try{await writeFile(temporary,content,{mode,flag:'wx'});await rename(temporary,path);}finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
export function createSystemDriver({directory='/etc/vps-panel',coreDirectory='/usr/local/lib/vps-panel',unitDirectory='/etc/systemd/system',readInterfaces=networkInterfaces,runner=execute}={}){
 const certificates=createCertificateManager({directory:join(directory,'certs')});
 const firewall=createFirewall({runner});
 const tcpAcceleration=createTcpAcceleration({directory,coreDirectory,runner});
 const call=async(command,args,options={})=>{
  const binary=binaries[command];if(!binary)throw new Error('不允许的系统操作');
  try{return await runner(binary,args,{timeout:20000,maxBuffer:1024*1024,windowsHide:true,...options});}
  catch(error){error.operation=command+'.'+String(args[0]||'').replace(/[^A-Za-z0-9_-]/g,'').slice(0,32);throw error;}
 };
 const statePath=join(directory,'system.json');
 async function assertMaintenanceIdle(){
  const path=join(directory,'maintenance.lock');
  try{await readFile(path);let active=false;try{await call('systemctl',['is-active','--quiet','vps-panel-update.service','vps-panel-update.timer','vps-panel-uninstall.service','vps-panel-uninstall.timer','vps-panel-rebind.service','vps-panel-rebind.timer']);active=true;}catch(error){if(![3,4].includes(error.code))throw error;}
   if(active)throw new Error('正在执行另一项维护任务');await unlink(path);
  }catch(error){if(error.code!=='ENOENT')throw error;}
 }
 async function maintenanceLock(kind){
  await assertMaintenanceIdle();await writeFile(join(directory,'maintenance.lock'),JSON.stringify({kind,at:Date.now()}),{mode:0o600,flag:'wx'});
 }
 const updates=createUpdateManager({directory,coreDirectory,getRole:async()=> (await state()).role||'relay',schedule:async(script,mode)=>{
  await maintenanceLock('update');
  try{await call('systemdRun',['--unit=vps-panel-update','--on-active=4s','--collect','--timer-property=RemainAfterElapse=no','--',join(coreDirectory,'runtime/bin/node'),script,mode]);}
  catch(error){await unlink(join(directory,'maintenance.lock'));throw error;}
 }});
 async function trustedDirectory(){
  await mkdir(directory,{mode:0o700,recursive:true});const stat=await lstat(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('系统配置目录不安全');
  if(process.platform==='linux'&&process.getuid?.()===0&&(stat.uid!==0||(stat.mode&0o022)))throw new Error('系统目录必须由root独占写入');
 }
 async function state(){try{return JSON.parse(await readFile(statePath,'utf8'));}catch(error){if(error.code==='ENOENT')return{};throw error;}}
 async function save(value){await atomicWrite(statePath,JSON.stringify(value));}
 const panel=createPanelNetwork({directory,getState:state,saveState:save,certificates,firewall,begin:()=>maintenanceLock('panel'),release:()=>unlink(join(directory,'maintenance.lock')),schedule:()=>call('systemdRun',['--unit=vps-panel-rebind','--on-active=3s','--collect','--timer-property=RemainAfterElapse=no','--',join(coreDirectory,'runtime/bin/node'),join(coreDirectory,'app/src/rebind-panel.mjs')])});
 async function networkRuntime(){try{return JSON.parse(await readFile(join(directory,'network-runtime.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return{};throw error;}}
 const saveNetworkRuntime=value=>atomicWrite(join(directory,'network-runtime.json'),JSON.stringify(value));
 async function maintenanceState(){
  const result={};
  for(const[kind,file]of[['update','update-state.json'],['panel','panel-rebind-state.json']])try{
   const value=JSON.parse(await readFile(join(directory,file),'utf8'));
   if(Number.isSafeInteger(value.at)&&value.at>=0)result[kind]={at:value.at,failed:kind==='panel'?value.ok===false:['failed','failed-rolled-back','failed-needs-ssh','rollback-failed-restored-current'].includes(value.step)};
  }catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  return result;
 }
 async function matchesInterface(network,key){
  if(key===wgPublic(network.privateKey))return true;
  if(key!=='(none)')return false;
  const links=JSON.parse((await call('ip',['-j','-d','link','show','dev',network.wireguardInterface])).stdout);
  return links[0]?.ifalias==='vps-panel-managed'&&links[0]?.linkinfo?.info_kind==='wireguard';
 }
 async function removeOwnedNetwork(current){
  if(!current.network)return;
  const network=current.network;if(network.wireguardInterface!=='vps-wg')throw new Error('拒绝删除非本程序接口');
  try{await call('ip',['link','show','dev',network.wireguardInterface]);}catch(error){if(error.code===1)return;throw error;}
  const key=(await call('wg',['show',network.wireguardInterface,'public-key'])).stdout.trim();
  if(!await matchesInterface(network,key))throw new Error('vps-wg接口不属于当前配置，拒绝删除');
  await call('ip',['link','delete',network.wireguardInterface]);
 }
 async function status(stream){
  const unit=unitFor(stream);
  const output=(await call('systemctl',['show',unit,'--property=ActiveState,SubState,InvocationID,MainPID,Result,NRestarts','--no-pager'])).stdout;
  const properties=Object.fromEntries(output.trim().split('\n').map(line=>{const offset=line.indexOf('=');return[line.slice(0,offset),line.slice(offset+1)];}));
  return{active:properties.ActiveState==='active',state:properties.ActiveState||'unknown',substate:properties.SubState||'unknown',epoch:properties.InvocationID||null,pid:Number(properties.MainPID)||0,restartCount:Number(properties.NRestarts)||0,result:properties.Result||null};
 }
 async function stop(stream){
  unitFor(stream);const stopToken=tripFuse(directory,stream);
  await call('systemctl',['kill','--kill-whom=all','--signal=SIGKILL',unitFor(stream)]).catch(()=>{});
  const unit=unitFor(stream),current=await state();
  await save({...current,desired:{...current.desired,[stream]:false}});
  await call('systemctl',['disable',unit]);await call('systemctl',['stop',unit]);
  await firewall.removeOwned(['vps-panel-'+stream.replace('.','-')]);return{...await status(stream),stopToken};
 }
 async function applyRules(name,rules,tables){
  if(!['guard','forward'].includes(name))throw new Error('规则集标识错误');
  await atomicWrite(join(directory,name+'-source.nft'),rules);
  await call('flock',['--exclusive','--timeout','15',join(directory,'nft.lock'),join(coreDirectory,'runtime/bin/node'),join(coreDirectory,'app/src/nft-cli.mjs'),name,directory],{timeout:30000});
 }
 async function guardRules(relay){
  const env=parseWebEnvironment(await readFile(join(directory,'web.env'),'utf8'));
  return buildFailClosed(relay,env.VPS_HOST==='0.0.0.0'?{panelPort:Number(env.VPS_PORT)}:{});
 }
 async function guardUp(){const current=await state();if(!current.relay)throw new Error('尚未配置协议内核保护');await applyRules('guard',await guardRules(current.relay));return{protected:true};}
 async function syncPanelGuard(){if((await state()).relay)await guardUp();}
 async function rulesIntact(name){
  try{
   // Read under the same lock as apply: never mistake the brief fingerprint update
   // after an atomic rules replacement for missing protection and stop live traffic.
   await call('flock',['--shared','--timeout','15',join(directory,'nft.lock'),join(coreDirectory,'runtime/bin/node'),join(coreDirectory,'app/src/nft-cli.mjs'),'check-'+name,directory],{timeout:30000});
   return true;
  }catch(error){if(error.code===1||error.code==='ENOENT'||error instanceof SyntaxError)return false;throw error;}
 }
 const guardStatus=()=>rulesIntact('guard');
 async function configureRelay(raw,users){
  await trustedDirectory();const current=await state();
  if(current.role==='exit'||current.network?.role==='exit')throw new Error('当前角色是出口机，请先通过维护流程切换');
  // Fixed identities allocated by the installer, not arbitrary system users from a request.
  const identity=JSON.parse(await readFile(join(directory,'identities.json'),'utf8'));
  const accounts=JSON.parse(await readFile(join(directory,'accounts.json'),'utf8'));
  const config=validateRelay({...raw,uids:identity,controlUid:accounts['vps-panel'].uid});
  if(current.network&&Object.values(config.ports.hy2).includes(current.network.listenPort))throw new Error('Hy2与WireGuard不能使用相同UDP端口');
  if(current.network&&config.attEnabled!==false){
   const network=current.network,peer=network.peers[0];
   if(network.wireguardInterface!==config.wireguardInterface||network.physicalInterface!==config.physicalInterface||peer.endpointIPv4!==config.endpointIPv4||peer.endpointPort!==config.endpointPort||peer.publicKey!==config.endpointPublicKey)throw new Error('线路与已保存的WG配对不一致');
  }
  if(!Array.isArray(users)||users.length>10000)throw new Error('用户列表错误');
  const clean=users.map(row=>({...validateUser({name:row.name,enabled:!!row.enabled,protocols:row.protocols,exits:row.exits,quota:row.quota,expires:row.expires,lines:row.lines}),id:row.id,credentials:row.credentials,up:row.up||0,down:row.down||0}));
  const generated=buildRelayConfigs(config,clean);
  // Stop before changing routes/guards; no partially configured public proxy becomes usable.
  for(const stream of streams)await stop(stream);
  await actionNetworkDown(false);
  await call('systemctl',['stop','vps-panel-guard.service']);
  await probeBindings([...streams.map(stream=>({port:config.ports[stream.split('.')[0]][stream.split('.')[1]],protocol:stream.startsWith('hy2')?'udp':'tcp'})),...Object.values(config.stats).map(stats=>({port:stats.port,protocol:'tcp',host:'127.0.0.1'}))]);
  await applyRules('guard',await guardRules(config),[['inet','vps_panel_guard']]);
  for(const[stream,content]of Object.entries(generated)){
   if(stream.startsWith('hy2.'))content.tls={...content.tls,cert:`/run/credentials/${unitFor(stream)}/fullchain.pem`,key:`/run/credentials/${unitFor(stream)}/privkey.pem`};
   await atomicWrite(join(directory,stream+'.json'),JSON.stringify(content));
  }
  await save({...current,role:'relay',relay:config,networkDesired:false,desired:{...Object.fromEntries(streams.map(stream=>[stream,false]))},configured:true});
  return{configured:true,started:false};
 }
 async function configureNetwork(raw){
  await trustedDirectory();const current=await state();
  const identity=JSON.parse(await readFile(join(directory,'identities.json'),'utf8'));
  const config=validateNetwork({...raw,uids:[identity['vmess.att'],identity['hy2.att']]});
  if(current.relay&&Object.values(current.relay.ports.hy2).includes(config.listenPort))throw new Error('WireGuard与Hy2不能使用相同UDP端口');
  if(config.wireguardInterface!=='vps-wg')throw new Error('只允许管理本程序的vps-wg接口');
  if(current.role&&current.role!==config.role||current.network&&current.network.role!==config.role)throw new Error('角色切换必须先停机并确认');
  let relayNeedsConfirmation=false;
  if(config.role==='relay'&&current.relay){
   const relay=current.relay,peer=config.peers[0];
   relayNeedsConfirmation=relay.wireguardInterface!==config.wireguardInterface||relay.physicalInterface!==config.physicalInterface||relay.endpointIPv4!==peer.endpointIPv4||relay.endpointPort!==peer.endpointPort||relay.endpointPublicKey!==peer.publicKey;
  }
  for(const stream of streams)await stop(stream);
  await actionNetworkDown(false);
  await atomicWrite(join(directory,'wireguard.conf'),wgConfig(config));
  await save({...current,role:config.role,network:config,relay:relayNeedsConfirmation?null:current.relay,networkDesired:false,desired:Object.fromEntries(streams.map(stream=>[stream,false]))});
  return{configured:true,started:false,relayNeedsConfirmation};
 }
 async function networkUp(){
  const current=await state(),config=validateNetwork(current.network);
  if(current.emergencyStop||tripped(directory,'emergency')||tripped(directory,'network'))throw new Error('急停或手动停止状态禁止恢复隧道');
  let runtime=await networkRuntime();await saveNetworkRuntime({...runtime,updating:true});
  if(config.role==='relay'){
   // First-use pairing may bring up WG before any proxy profile exists.
   // Proxy startup still requires a relay configuration and the full guard.
   let routes=[];try{routes=JSON.parse((await call('ip',['-j','route','show','table','51820'])).stdout);}catch(error){if(error.code!==2)throw error;}
   if(routes.some(route=>route.dev!==config.wireguardInterface))throw new Error('路由表51820已被其他程序占用');
   if(current.relay)await applyRules('guard',await guardRules(current.relay),[['inet','vps_panel_guard']]);
  }else{
   await applyRules('forward',exitRules(config),[['inet','vps_panel_forward'],['ip','vps_panel_nat']]);
   if(runtime.forwardPrior===undefined){const prior=(await call('sysctl',['-n','net.ipv4.ip_forward'])).stdout.trim();if(!['0','1'].includes(prior))throw new Error('IP转发状态错误');runtime={...runtime,forwardPrior:Number(prior)};await saveNetworkRuntime({...runtime,updating:true});}
   await call('sysctl',['-w','net.ipv4.ip_forward=1']);
  }
  let existing=false;try{await call('ip',['link','show','dev',config.wireguardInterface]);existing=true;}catch{await call('ip',['link','add',config.wireguardInterface,'type','wireguard']);await call('ip',['link','set','dev',config.wireguardInterface,'alias','vps-panel-managed']);}
  if(existing){const key=(await call('wg',['show',config.wireguardInterface,'public-key'])).stdout.trim();if(!await matchesInterface(config,key))throw new Error('vps-wg接口已被其他配置占用');}
  await call('wg',['setconf',config.wireguardInterface,join(directory,'wireguard.conf')]);
  await firewall.allowPort(config.listenPort,'udp','vps-panel-wireguard');
  if(config.role==='exit')await firewall.allowForward(config.wireguardInterface,config.physicalInterface);
  // Delete only our reserved rule priorities before re-adding; never flush host rules.
  if(config.role==='relay')for(const priority of[11000,11100,11101,11102,11103]){
   const rules=JSON.parse((await call('ip',['-j','rule','show'])).stdout);
   if(rules.some(rule=>rule.priority===priority&&!ownsRouteRule(rule,config.uids)))throw new Error(`路由优先级${priority}被其他程序占用`);
   try{await call('ip',['rule','delete','pref',String(priority),'protocol','196']);}catch(error){if(error.code!==2&&error.code!==undefined)throw error;}
  }
  for(const[command,args]of routePlan(config))await call(command,args);
  if(tripped(directory,'emergency')||tripped(directory,'network')){await removeOwnedNetwork(current);throw new Error('隧道启动被停止操作取消');}
  await saveNetworkRuntime({...runtime,updating:false,bootId:(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),epoch:randomBytes(16).toString('hex'),changed:Date.now()});
  return{up:true};
 }
 async function networkStatus(){
  const current=await state();if(!current.network)return{configured:false,up:false,peers:[]};
  const config=current.network;
  const runtime=await networkRuntime();
  if(runtime.updating||runtime.bootId!==(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim())return{configured:true,up:false,role:config.role,peers:[]};
  let dump;try{dump=(await call('wg',['show',config.wireguardInterface,'dump'])).stdout;}catch(error){if(error.code===1)return{configured:true,up:false,role:config.role,peers:[]};throw error;}
  const rows=dump.trim().split('\n').slice(1),peers=[];
  for(const row of rows){
   const fields=row.split('\t');if(fields.length<8)throw new Error('WG状态格式错误');
   const up=Number(fields[6]),down=Number(fields[5]),handshakeAt=Number(fields[4])*1000;
   if(![up,down,handshakeAt].every(value=>Number.isSafeInteger(value)&&value>=0))throw new Error('WG流量计数错误');
   peers.push({publicKey:fields[0],up,down,handshakeAt:handshakeAt||null});
  }
  let protectedRoute=config.role==='relay'&&!current.relay?true:await rulesIntact(config.role==='relay'?'guard':'forward');
  if(config.role==='relay'){
   const rules=JSON.parse((await call('ip',['-j','rule','show'])).stdout);
   if([11000,11100,11101,11102,11103].some(priority=>!rules.some(rule=>rule.priority===priority&&ownsRouteRule(rule,config.uids))))protectedRoute=false;
  }
  return{configured:true,up:true,protected:protectedRoute,role:config.role,epoch:runtime.epoch||null,changed:runtime.changed||null,peers};
 }
 async function ensureNetworkService(){
  const before=await networkStatus();if(!before.configured)throw new Error('请先配置WG配对');
  await call('systemctl',[before.up&&before.protected!==false?'start':'restart','vps-panel-network.service']);
  const after=await networkStatus();if(!after.up||after.protected===false)throw new Error('WG接口或断线保护未恢复，线路保持停止');
  if(tripped(directory,'emergency')||tripped(directory,'network'))throw new Error('隧道启动被新的停止操作取消');
  return after;
 }
 async function start(stream,{repair=false,expectedStopToken,expectedNetworkToken}={}){
  unitFor(stream);const observed=expectedStopToken===undefined?readFuse(directory,stream):expectedStopToken,networkToken=expectedNetworkToken===undefined?readFuse(directory,'network'):expectedNetworkToken;
  const current=await state();if(!current.relay)throw new Error('线路尚未配置');
  if(current.relay.enabledProtocols&&!current.relay.enabledProtocols.includes(stream.split('.')[0])||stream.endsWith('.att')&&current.relay.attEnabled===false)throw new Error('该协议或ATT出口尚未开通');
  if(current.emergencyStop||tripped(directory,'emergency'))throw new Error('急停已锁定，请先明确解除急停');
  if(stream.startsWith('hy2.')){
   const cert=await certificates.status();
   if(cert.certificateStaging!==false||cert.certificateDomain!==current.relay.domain||!cert.notAfter||cert.notAfter<=Date.now())throw new Error('Hy2需要匹配域名的有效正式证书');
  }
  if(stream.endsWith('.att')&&!current.network)throw new Error('隧道尚未配对');
  if(repair&&tripped(directory,stream)||!clearFuse(directory,stream,observed))throw new Error('该线路有较新的停止操作，已取消启动');
  if(stream.endsWith('.att')&&!clearFuse(directory,'network',networkToken))throw new Error('隧道有较新的停止操作，已取消启动');
  if(stream.endsWith('.att'))await ensureNetworkService();
  if(tripped(directory,'emergency')||tripped(directory,stream))throw new Error('启动已被急停或手动停止取消');
  const unit=unitFor(stream);
  await firewall.allowPort(current.relay.ports[stream.split('.')[0]][stream.split('.')[1]],stream.startsWith('hy2')?'udp':'tcp','vps-panel-'+stream.replace('.','-'));
  const latest=await state();await save({...latest,networkDesired:stream.endsWith('.att')||!!latest.networkDesired,desired:{...latest.desired,[stream]:true}});
  if(current.autoStart)await call('systemctl',['enable',unit]);
  try{if(tripped(directory,'emergency')||tripped(directory,stream))throw new Error('启动已被新的停止操作取消');await call('systemctl',['start',unit]);return status(stream);}catch(error){if(repair)await call('systemctl',['stop',unit]);else await stop(stream);throw error;}
 }
 async function replaceTcp(stream,users,{expectedOriginalToken}={}){
  const original=expectedOriginalToken===undefined?readFuse(directory,stream):expectedOriginalToken;
  if(!stream.startsWith('vmess.'))throw new Error('仅支持TCP配置替换');
  const current=await state();if(!current.relay)throw new Error('线路尚未配置');
  if(!current.desired?.[stream]||original!==null||tripped(directory,'emergency'))return{...await status(stream),skipped:true};
  const config=buildRelayConfigs(current.relay,users)[stream];
  const staged=join(directory,stream+'.next.json');await atomicWrite(staged,JSON.stringify(config));
  await runner(join(coreDirectory,'xray'),['run','-test','-config',staged],{timeout:15000,maxBuffer:1024*1024,windowsHide:true});
  if(readFuse(directory,stream)!==original||tripped(directory,'emergency'))return{...await status(stream),skipped:true};
  const stopped=await stop(stream);await rename(staged,join(directory,stream+'.json'));
  return start(stream,{expectedStopToken:stopped.stopToken});
 }
 async function actionNetworkDown(stopAtt=true){
  tripFuse(directory,'network');if(stopAtt)for(const stream of streams.filter(stream=>stream.endsWith('.att')))tripFuse(directory,stream);
  const current=await state();await save({...current,networkDesired:false});
  if(stopAtt)for(const stream of streams.filter(stream=>stream.endsWith('.att')))await stop(stream);
  await call('systemctl',['disable','vps-panel-network.service']);await call('systemctl',['stop','vps-panel-network.service']);
  await removeOwnedNetwork(current);
  await firewall.removeOwned(['vps-panel-wireguard','vps-panel-forward']);
  return{up:false};
 }
 async function actionInspect(){
   const uids=JSON.parse(await readFile(join(directory,'identities.json'),'utf8'));
   const accounts=JSON.parse(await readFile(join(directory,'accounts.json'),'utf8'));
   const routes=JSON.parse((await call('ip',['-j','-4','route','show','default'])).stdout);
   const env=parseWebEnvironment(await readFile(join(directory,'web.env'),'utf8'));
   const iface=routes[0]?.dev,assigned=(readInterfaces()[iface]||[]).find(address=>address.family==='IPv4'&&publicProbeIPv4(address.address))?.address;
   const fallback=new URL(env.VPS_ORIGIN).hostname,publicIPv4=assigned||(isIP(fallback)===4?fallback:null);
   return{uids,controlUid:accounts['vps-panel'].uid,panelPort:Number(env.VPS_PORT),publicIPv4,physicalInterface:iface||null,systemChangesEnabled:true,stopTokens:Object.fromEntries(['emergency','network','automation',...streams].map(name=>[name,readFuse(directory,name)]))};
 }
 async function action(action,data={}){
  if(action==='tcp-acceleration-status')return tcpAcceleration.status();
  if(action==='tcp-acceleration-set'){if(!data||Object.keys(data).some(key=>key!=='mode'))throw new Error('TCP加速参数错误');await assertMaintenanceIdle();return tcpAcceleration.configure(data.mode);}
  const ticket=Object.fromEntries(['emergency','network','automation',...streams].map(name=>[name,readFuse(directory,name)]));
  if(['stop','stop-all','network-down','emergency-stop'].includes(action)&&!Object.hasOwn(data,'expectedAutomationToken'))tripFuse(directory,'automation');
  if(Object.hasOwn(data,'expectedAutomationToken')&&readFuse(directory,'automation')!==data.expectedAutomationToken)throw new Error('已收到新的手动停止操作，自动配置已取消');
  if(['start','restart','configure-relay','configure-network','switch-role','release-emergency','policy','certificate-configure','certificate-issue','update-source','update-start','update-rollback','network-up','panel-configure','reload-panel-certificate','reload-hy2-certificate','repair-profile','repair-network','repair-guard','forget-network'].includes(action))await assertMaintenanceIdle();
  if(action==='inspect')return actionInspect();
  if(action==='plan-relay'){
   const current=await state(),info=await actionInspect();
   if(current.relay)return{...info,ports:current.relay.ports};
   const ports={vmess:{att:18001,direct:18002},hy2:{att:443,direct:8443}},used=new Set([info.panelPort,18444,19001,19002,19003,19004,current.network?.listenPort].filter(Boolean));
   for(const protocol of['vmess','hy2'])for(const exit of['att','direct']){
    let selected=null;
    for(let attempt=0;attempt<16;attempt++){
     const candidate=attempt?49152+randomBytes(2).readUInt16BE()%16384:ports[protocol][exit];if(used.has(candidate))continue;
     try{await probeBindings([{host:'0.0.0.0',port:candidate,protocol:protocol==='hy2'?'udp':'tcp'}]);selected=candidate;break;}catch{}
    }
    if(selected===null)throw new Error('无法自动分配线路端口，请检查服务器是否有其他服务占用');
    ports[protocol][exit]=selected;used.add(selected);
   }
   return{...info,ports};
  }
  if(action==='plan-network'){
   const current=await state();if(current.network)return{listenPort:current.network.listenPort};
   const info=await actionInspect(),reserved=new Set([info.panelPort,...Object.values(current.relay?.ports||{}).flatMap(value=>Object.values(value)),...Object.values(current.relay?.stats||{}).map(value=>value.port),current.relay?.authServices?.port].filter(Number.isInteger));
   for(let attempt=0;attempt<16;attempt++){
    const candidate=attempt?49152+randomBytes(2).readUInt16BE()%16384:current.role==='exit'?51874:51820;if(reserved.has(candidate))continue;
    try{await probeBindings([{host:'0.0.0.0',port:candidate,protocol:'udp'}]);return{listenPort:candidate};}catch{}
   }throw new Error('无法自动分配隧道端口，请检查是否被其他程序占用');
  }
  if(action==='forget-network'){
   const current=await state();if(current.role!=='relay'||current.networkDesired)throw new Error('请先停止中转隧道，再删除配对');
   if(current.network){
    const rules=JSON.parse((await call('ip',['-j','rule','show'])).stdout);
    for(const rule of rules)if(ownsRouteRule(rule,current.network.uids))await call('ip',['rule','delete','pref',String(rule.priority),'protocol','196']);
   }
   await save({...current,network:null,networkDesired:false});await unlink(join(directory,'wireguard.conf')).catch(error=>{if(error.code!=='ENOENT')throw error;});return{forgotten:true};
  }
  if(action==='status'){
   const result={};for(const stream of streams)result[stream]=await status(stream);const current=await state();
   let certificate;try{certificate=await certificates.status();}catch{certificate={ok:false,error:'证书状态无法读取，请检查本机证书配置'};}
   return{profiles:result,desired:Object.fromEntries(streams.map(stream=>[stream,!!current.desired?.[stream]&&!tripped(directory,stream)])),guardPresent:await guardStatus(),panelUseAcme:!!current.panelUseAcme,certificate,network:await networkStatus(),networkDesired:!!current.networkDesired&&!tripped(directory,'network'),autoRepair:!!current.autoRepair,emergencyStop:!!current.emergencyStop||tripped(directory,'emergency'),maintenance:await maintenanceState()};
  }
  if(action==='repair-guard'){
   const current=await state();if(!current.autoRepair||current.emergencyStop||tripped(directory,'emergency'))return{skipped:true};
   const now=Date.now(),previous=current.guardRepairs||{},count=now-(previous.windowStart||0)<300000?previous.count||0:0;
   if(count>=3||now<(previous.next||0))return{skipped:true,limited:true};
   await save({...current,guardRepairs:{windowStart:count?previous.windowStart:now,count:count+1,next:now+[5000,15000,45000][count]}});
   return guardUp();
  }
  if(action==='repair-profile'){
   if(!streams.includes(data.stream))throw new Error('线路标识错误');
   const current=await state();if(current.emergencyStop||tripped(directory,'emergency')||tripped(directory,data.stream)||!current.autoRepair||!current.desired?.[data.stream])return{skipped:true};
   const statusNow=await status(data.stream);if(statusNow.active||['activating','deactivating'].includes(statusNow.state))return{skipped:true};
   const now=Date.now(),all=current.profileRepairs||{},prior=all[data.stream]||{},count=now-(prior.windowStart||0)<300000?prior.count||0:0;
   if(count>=3||now<(prior.next||0))return{skipped:true,limited:true};
   all[data.stream]={windowStart:count?prior.windowStart:now,count:count+1,next:now+[5000,15000,45000][count]};await save({...current,profileRepairs:all});
   await call('systemctl',['reset-failed',unitFor(data.stream)]);return start(data.stream,{repair:true});
  }
  if(action==='repair-network'){
   const current=await state(),now=Date.now();if(current.emergencyStop||tripped(directory,'emergency')||tripped(directory,'network')||!current.autoRepair||!current.networkDesired)return{skipped:true};
   const prior=current.networkRepairs||{};const count=now-(prior.windowStart||0)<300000?prior.count||0:0;
   if(count>=3||now<(prior.next||0))return{skipped:true,limited:true};
   await save({...current,networkRepairs:{windowStart:count?prior.windowStart:now,count:count+1,next:now+[5000,15000,45000][count]}});
   await call('systemctl',['restart','vps-panel-network.service']);const checked=await networkStatus();return{repaired:checked.up&&checked.protected!==false};
  }
  if(action==='certificate-status')return certificates.status();
  if(action==='certificate-configure'){
   const current=await state();if(current.relay&&typeof data.domain==='string'&&data.domain.trim().toLowerCase()!==current.relay.domain)throw new Error('证书域名必须与当前代理域名一致，请先更改线路配置');
   return certificates.configure(data);
  }
  if(action==='certificate-issue')return certificates.start();
  if(action==='panel-status')return panel.status();
  if(action==='panel-configure')return panel.configure(data);
  if(action==='reload-panel-certificate'){
   const current=await state();if(!current.panelUseAcme)return{skipped:true};
   await call('systemctl',['restart','vps-panel-web.service']);return{reloaded:true};
  }
  if(action==='update-status')return updates.status({check:data.check===true});
  if(action==='update-source')return updates.configure(data);
  if(action==='update-start')return updates.start(data);
  if(action==='update-rollback')return updates.rollback(data);
  if(action==='uninstall'){
   if(data.confirmed!==true||typeof data.purgeData!=='boolean')throw new Error('必须确认卸载及数据保留方式');
   await maintenanceLock('uninstall');
   const current=await state();await save({...current,emergencyStop:true,desired:Object.fromEntries(streams.map(stream=>[stream,false]))});
   try{await call('systemdRun',['--unit=vps-panel-uninstall','--on-active=4s','--collect','--timer-property=RemainAfterElapse=no','--',join(coreDirectory,'runtime/bin/node'),join(coreDirectory,'app/src/uninstall.mjs'),data.purgeData?'--purge-data':'--keep-data']);}
   catch(error){await unlink(join(directory,'maintenance.lock'));throw error;}
   return{accepted:true,disconnecting:true,purgeData:data.purgeData};
  }
  if(action==='logs'){
   const names=['web','agent','worker','auth','network','guard','tcp-apply','tcp-acceleration',...streams.map(stream=>stream.replace('.','-'))];
   if(!['all',...names].includes(data.target))throw new Error('日志目标错误');
   const selected=data.target==='all'?names:[data.target];
   const args=['--no-pager','--output=short-iso','--lines=300'];for(const name of selected)args.push('--unit','vps-panel-'+name+'.service');
   return{text:(await call('journalctl',args)).stdout};
  }
  if(action==='configure-relay')return configureRelay(data.config,data.users);
  if(action==='configure-network')return configureNetwork(data.config);
  if(action==='network-up'){
   const token=ticket.network,current=await state();if(current.emergencyStop||tripped(directory,'emergency'))throw new Error('急停禁止启动网络');
   if(!clearFuse(directory,'network',token))throw new Error('隧道有较新的停止操作，已取消启动');
   await ensureNetworkService();
   const latest=await state();await save({...latest,networkDesired:true});if(latest.autoStart)await call('systemctl',['enable','vps-panel-network.service']);return{up:true};
  }
  if(action==='network-down')return actionNetworkDown();
  if(action==='switch-role'){
   if(!['relay','exit'].includes(data.role)||data.confirmed!==true)throw new Error('必须确认目标角色');
   let current=await state();const oldRole=current.role||current.network?.role||'relay';
   if(oldRole===data.role)return{role:data.role,started:false};
   for(const stream of streams)await stop(stream);
   await call('systemctl',['disable','vps-panel-network.service']);await call('systemctl',['stop','vps-panel-network.service']);
   await call('systemctl',['stop','vps-panel-guard.service']);
   await removeOwnedNetwork(current);
   current=await state();const{archives={},...snapshot}=current;
   archives[oldRole]=snapshot;
   const previous=archives[data.role]||{};
   const shared=Object.fromEntries(['panelUseAcme','initialOrigin','panelCertificateFingerprint','autoStart','autoRepair'].filter(key=>key in current).map(key=>[key,current[key]]));
   await save({...previous,...shared,role:data.role,archives,emergencyStop:true,networkDesired:false,desired:Object.fromEntries(streams.map(stream=>[stream,false]))});
   return{role:data.role,started:false,emergencyStop:true};
  }
  if(action==='policy'){
   const current=await state();
   if(typeof data.autoStart!=='boolean'||typeof data.autoRepair!=='boolean')throw new Error('自启动和自修复设置错误');
   await save({...current,autoStart:data.autoStart,autoRepair:data.autoRepair});
   await call('systemctl',[data.autoStart&&current.networkDesired&&!current.emergencyStop&&!tripped(directory,'emergency')&&!tripped(directory,'network')?'enable':'disable','vps-panel-network.service']);
   for(const stream of streams){
    const unit=unitFor(stream);await call('systemctl',[data.autoStart&&current.desired?.[stream]&&!current.emergencyStop&&!tripped(directory,'emergency')&&!tripped(directory,stream)?'enable':'disable',unit]);
    const dropin=join(unitDirectory,unit+'.d');
    // The path comes only from a fixed stream allowlist.
    await mkdir(dropin,{recursive:true,mode:0o755});
    await atomicWrite(join(dropin,'repair.conf'),`[Service]\nRestart=${data.autoRepair?'on-failure':'no'}\n`,0o644);
   }
   await call('systemctl',['daemon-reload']);return{autoStart:data.autoStart,autoRepair:data.autoRepair};
  }
  if(action==='emergency-stop'){
   tripFuse(directory,'emergency');tripFuse(directory,'network');for(const stream of streams)tripFuse(directory,stream);
   await call('systemctl',['kill','--kill-whom=all','--signal=SIGKILL',...streams.map(unitFor)]).catch(()=>{});
   const current=await state();await save({...current,emergencyStop:true,desired:Object.fromEntries(streams.map(stream=>[stream,false]))});
   await call('systemctl',['--no-block','stop','vps-panel-network.service']);await removeOwnedNetwork(current);
   for(const stream of streams)await stop(stream);
   await actionNetworkDown(false);return{emergencyStop:true};
  }
  if(action==='release-emergency'){
   if(data.confirmed!==true)throw new Error('必须确认解除急停');
   const observed=ticket.emergency,current=await state();await save({...current,emergencyStop:false});clearFuse(directory,'emergency',observed);return{emergencyStop:tripped(directory,'emergency'),started:false};
  }
  if(action==='start')return start(data.stream,{expectedStopToken:ticket[data.stream],expectedNetworkToken:ticket.network});
  if(action==='stop')return stop(data.stream);
  if(action==='restart'){
   if(!streams.includes(data.stream))throw new Error('线路标识错误');
   if(readFuse(directory,data.stream)!==ticket[data.stream]||tripped(directory,'emergency'))throw new Error('已有更新的停止操作，已取消重启');
   const stopped=await stop(data.stream);return start(data.stream,{expectedStopToken:stopped.stopToken,expectedNetworkToken:ticket.network});
  }
  if(action==='reload-hy2-certificate'){
   if(!['hy2.att','hy2.direct'].includes(data.stream))throw new Error('线路标识错误');
   const current=await state();if(!current.desired?.[data.stream]||readFuse(directory,data.stream)!==ticket[data.stream]||ticket[data.stream]!==null||tripped(directory,'emergency'))return{...await status(data.stream),skipped:true};
   const stopped=await stop(data.stream);return start(data.stream,{expectedStopToken:stopped.stopToken,expectedNetworkToken:ticket.network});
  }
  if(action==='replace-tcp')return replaceTcp(data.stream,data.users,{expectedOriginalToken:ticket[data.stream]});
  if(action==='stop-all'){for(const stream of streams)tripFuse(directory,stream);tripFuse(directory,'network');const result={};for(const stream of streams)result[stream]=await stop(stream);await actionNetworkDown(false);return{profiles:result};}
  throw new Error('不支持的系统操作');
 }
 return{action,status,stop,start,replaceTcp,networkUp,guardUp,syncPanelGuard,renewCertificates:async()=>{await assertMaintenanceIdle();return certificates.renew();}};
}
