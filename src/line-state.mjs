import{enqueueEvent}from'./bark.mjs';
export const lineNames={'hy2.direct':'Hy2直出','hy2.att':'Hy2 → ATT','vmess.direct':'TCP直出','vmess.att':'TCP → ATT'};
export function connectionStates(store,system){
 const now=store.clock(),runtime=store.get('runtime')||{},blocked=runtime.maintenance||runtime.emergencyStop||system?.emergencyStop;
 const network=system?.network,peers=network?.peers||[];
 const handshake=p=>Number.isFinite(p.handshakeAt)&&p.handshakeAt<=now&&now-p.handshakeAt<=180000;
 const tunnelReady=!!(network?.up&&network.protected===true&&peers.length&&peers.every(handshake));
 const config=store.get('network-config');let names=[];try{names=JSON.parse(store.unseal(config)).peers||[];}catch{}
 const upstream=names.map(peer=>{const observed=peers.find(p=>p.publicKey===peer.publicKey);return{id:peer.publicKey,name:peer.name||peer.address,status:system&&network?.up&&network.protected===true&&observed&&handshake(observed)?'normal':system?'disconnected':'unknown',handshakeAt:observed?.handshakeAt||null};});
 const lines=Object.entries(lineNames).map(([id,name])=>{
  const profile=system?.profiles?.[id],wanted=system?.desired?.[id],transition=['activating','deactivating','reloading'].includes(profile?.state);
  let status=!profile?'unknown':transition?'pending':profile.active?'normal':wanted&&!blocked?'error':'stopped';
  let detail=status==='normal'?'服务运行正常':status==='error'?'已要求启动，但服务没有正常运行':status==='stopped'?'线路已停止':status==='pending'?'正在切换状态':'未取得最新状态';
  if(status==='normal'&&system.guardPresent===false){status='error';detail='线路保护规则异常';}
  if(status==='normal'&&id.endsWith('.att')&&!tunnelReady){status='error';detail='ATT隧道未就绪或超过3分钟没有握手';}
  return{id,name,status,active:!!profile?.active,wanted:!!wanted,detail};
 });
 return{lines,upstream,tunnelReady};
}
export function evaluateConnectionAlerts(store,system){
 const now=store.clock(),view=connectionStates(store,system),prior=store.get('connection-alert-state')||{},next={};
 const exit=store.get('settings').role==='exit';
 for(const row of exit?view.upstream:view.lines){
  const key=(exit?'peer:':'line:')+row.id,old=prior[key];next[key]={status:row.status,since:old?.status===row.status?old.since:now};
  if(['unknown','pending'].includes(row.status))continue;
  const failed=['error','disconnected'].includes(row.status);
  // Give newly started tunnels a handshake interval before declaring them unavailable.
  if(failed&&(exit||row.id.endsWith('.att')&&row.active)&&now-next[key].since<180000)continue;
  if(failed){enqueueEvent(store,exit?'upstream.disconnected':'service.failed',{body:exit?`上游服务器“${row.name}”连接已断开，请立即检查。`:`${row.name}线路异常：${row.detail}，请立即检查。`,line:row.name,status:exit?'断开':'异常'},{key:(exit?'upstream.disconnected.':'service.failed.')+row.id});next[key].announced=true;}
  else if(old&&old.status!==row.status){const type=exit?'upstream.connected':row.status==='stopped'?'service.stopped':old.announced||old.status==='error'?'service.recovered':'service.started';enqueueEvent(store,type,{body:exit?`上游服务器“${row.name}”连接已恢复。`:`${row.name}线路${row.status==='stopped'?'已停止':type==='service.recovered'?'已恢复正常':'已启动'}。`,line:row.name,status:row.status==='stopped'?'停止':'正常'},{key:type+'.'+row.id,cooldown:60000});}
  if(old?.announced&&failed)next[key].announced=true;
 }
 store.set('connection-alert-state',next);return view;
}
