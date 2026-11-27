import{resolve}from'node:path';
import{fileURLToPath}from'node:url';
import{openStore}from'./store.mjs';
import{agentRequest,retryAgentBusy}from'./agent-client.mjs';
import{createAccessReconciler,streams,accessUsers}from'./access.mjs';
import{allowsLine}from'./line-permissions.mjs';
import{readHy2,readXray,kickHy2,ingestSnapshot}from'./collectors.mjs';
import{collectHost}from'./telemetry.mjs';
import{evaluateUserAlerts}from'./metrics.mjs';
import{ingestTunnel}from'./tunnel-stats.mjs';
import{enqueueEvent}from'./bark.mjs';
import{evaluateConnectionAlerts}from'./line-state.mjs';
import{execFile}from'node:child_process';
import{promisify}from'node:util';

export function createRuntimeWorker({store,request=agentRequest,collectHy2=readHy2,collectXray=readXray,kick=kickHy2}){
 let busy=false;
 const decode=()=>{const encoded=store.get('relay-config');return encoded?JSON.parse(store.unseal(encoded)):null;};
 async function tick(){
  if(busy)return;busy=true;
  try{
   const system=await request('status');const {profiles,desired={},certificate,emergencyStop,network:networkStatus,networkDesired,autoRepair,guardPresent,panelUseAcme,maintenance={}}=system;
   evaluateConnectionAlerts(store,system);
   store.set('service-status',{at:store.clock(),profiles});
   const observed=store.get('maintenance-observed')||{};
   for(const[kind,job]of Object.entries(maintenance))if(['update','panel'].includes(kind)&&Number.isSafeInteger(job.at)&&job.at!==observed[kind]){
    if(job.failed)enqueueEvent(store,'maintenance.failed',{body:kind==='panel'?'管理连接变更未通过自检，请检查维护状态及回退结果。':'面板更新或回滚未完成，请检查维护状态及恢复结果。'},{key:'maintenance.failed.'+kind});
    observed[kind]=job.at;store.set('maintenance-observed',observed);
   }
   if(networkStatus){store.set('network-status',{at:store.clock(),...networkStatus});ingestTunnel(store,networkStatus);}
   if(panelUseAcme&&certificate?.fingerprint&&certificate.fingerprint!==store.get('panel-certificate-applied')){
    try{await request('reload-panel-certificate');store.set('panel-certificate-applied',certificate.fingerprint);}catch{store.set('panel-certificate-health',{at:store.clock(),ok:false});}
   }
   const network=store.get('network-config');
   const hostConfig=network?JSON.parse(store.unseal(network)):{};
   try{await collectHost(store,{...hostConfig,directory:store.directory});}catch{store.set('telemetry-health',{at:store.clock(),ok:false});}
   const runtime=store.get('runtime');
   if(runtime?.maintenance||runtime?.emergencyStop){
    if(Object.values(profiles).some(item=>item.active)||runtime.emergencyStop&&!emergencyStop)await request(runtime.emergencyStop?'emergency-stop':'stop-all');
    store.set('worker-health',{at:store.clock(),ok:true});
    return;
   }
   if(emergencyStop){store.set('worker-health',{at:store.clock(),ok:true});return;}
   if(guardPresent===false&&Object.values(profiles).some(profile=>profile.active)){
    const{enqueueEvent}=await import('./bark.mjs');enqueueEvent(store,'service.failed',{body:'协议内核保护规则缺失，正在处理。'});
    let repaired=false;if(autoRepair)try{repaired=!!(await request('repair-guard')).protected;}catch{}
    if(!repaired){await request('stop-all');store.set('runtime',{...runtime,maintenance:true});store.audit('保护规则无法恢复，已停止全部线路');store.set('worker-health',{at:store.clock(),ok:true});return;}
   }
   if(networkStatus?.configured&&networkDesired&&(!networkStatus.up||networkStatus.protected===false)){
    const{enqueueEvent}=await import('./bark.mjs');enqueueEvent(store,'tunnel.failed',{body:'ATT隧道连接异常，TCP及Hy2 → ATT线路不可用，请立即检查。'});
    if(autoRepair){try{const result=await request('repair-network');if(result.repaired)enqueueEvent(store,'repair.succeeded',{body:'WG接口及断线保护已恢复。'});}catch{enqueueEvent(store,'repair.failed',{body:'WG自动恢复未完成，请检查诊断日志。'});}}
   }
   const config=decode();if(!config){store.set('worker-health',{at:store.clock(),ok:true});return;}
   for(const stream of streams){
    const profile=profiles[stream];
    if(!desired[stream]||!profile||profile.active||['activating','deactivating'].includes(profile.state))continue;
    enqueueEvent(store,'service.failed',{body:`线路 ${stream} 异常停止。`},{key:'service.failed.'+stream});
    if(!autoRepair)continue;
    enqueueEvent(store,'repair.started',{body:`正在尝试恢复线路 ${stream}。`},{key:'repair.started.'+stream});
    try{
     const repaired=await request('repair-profile',{stream});
     if(repaired.active){profiles[stream]=repaired;enqueueEvent(store,'repair.succeeded',{body:`线路 ${stream} 已恢复。`},{key:'repair.succeeded.'+stream});}
     else if(repaired.limited)enqueueEvent(store,'repair.failed',{body:`线路 ${stream} 反复异常，已暂停自动修复，请检查日志。`},{key:'repair.failed.'+stream});
    }catch{enqueueEvent(store,'repair.failed',{body:`线路 ${stream} 自动恢复失败，请检查日志。`},{key:'repair.failed.'+stream});}
   }
   // Persist counters before any permissions change can restart a core.
   for(const stream of streams){
    const status=profiles[stream];if(!status?.active||!status.epoch)continue;
    try{
     const options={...config.stats[stream],ids:accessUsers(store).filter(user=>allowsLine(user,stream)).map(user=>user.id)};
     const samples=await(stream.startsWith('hy2')?collectHy2(options):collectXray(options));
     ingestSnapshot(store,{stream,epoch:status.epoch,samples});
     store.set('collector-health.'+stream,{at:store.clock(),ok:true});
    }catch{
     store.set('collector-health.'+stream,{at:store.clock(),ok:false});
     // Stop an unmetered line if it serves users with an enforced quota.
     const quota=accessUsers(store).some(user=>user.enabled&&user.quota!==null&&allowsLine(user,stream));
     if(quota){await request('stop',{stream});profiles[stream].active=false;store.audit('额度线路统计失效，已停止受影响线路',{stream});}
    }
   }
   if(certificate?.fingerprint&&certificate.fingerprint!==store.get('certificate-applied')){
    for(const stream of['hy2.att','hy2.direct'])if(profiles[stream]?.active)profiles[stream]=await request('reload-hy2-certificate',{stream});
    store.set('certificate-applied',certificate.fingerprint);
   }
   if(certificate?.ok===false){
    const{enqueueEvent}=await import('./bark.mjs');enqueueEvent(store,'certificate.failed',{body:'证书签发或续签失败，请在面板检查证书状态。'});
   }
   const reconcile=createAccessReconciler({store,profiles:config.stats,adapter:{
    status:async stream=>profiles[stream],
    onlineIds:async stream=>(await collectHy2(config.stats[stream])).filter(item=>item.connections>0).map(item=>item.id),
    kick:(stream,ids)=>kick(config.stats[stream],ids),
    stop:stream=>request('stop',{stream}),
    replaceTcp:async(stream,users)=>{profiles[stream]=await retryAgentBusy(()=>request('replace-tcp',{stream,users}));}
   }});
   await reconcile();
   evaluateUserAlerts(store);
   const live=store.get('live-traffic')||{};
   const values=Object.values(live).flatMap(user=>Object.entries(user).filter(([stream,sample])=>profiles[stream]?.active&&store.clock()-sample.at<=20000&&store.get('collector-health.'+stream)?.ok).map(([,sample])=>sample));
   if(values.some(sample=>sample.up!==null)){
    const history=store.get('traffic-samples')||[];
    history.push({at:store.clock(),up:values.reduce((sum,sample)=>sum+(sample.up||0),0),down:values.reduce((sum,sample)=>sum+(sample.down||0),0)});
    store.set('traffic-samples',history.slice(-360));
   }
   store.set('worker-health',{at:store.clock(),ok:true});
  }catch{
   store.set('worker-health',{at:store.clock(),ok:false});
  }finally{busy=false;}
 }
 return{tick};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const store=await openStore({directory:resolve(process.env.VPS_DATA_DIR||'data')});
 const worker=createRuntimeWorker({store});let stopping=false;
 const execute=promisify(execFile),notify=async args=>{if(process.env.NOTIFY_SOCKET)await execute('/usr/bin/systemd-notify',args,{timeout:10000,windowsHide:true});};
 await notify(['--ready']);
 for(const signal of['SIGTERM','SIGINT'])process.once(signal,()=>{stopping=true;});
 while(!stopping){await worker.tick();if(store.get('worker-health')?.ok)await notify(['WATCHDOG=1']);if(!stopping)await new Promise(resolve=>setTimeout(resolve,5000));}
 store.close();
}
