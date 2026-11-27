import{token}from'./security.mjs';
import{wgKeys,wgPublic,validateNetwork}from'./network.mjs';
import{validateRelay}from'./core-config.mjs';
import{accessUsers,streams}from'./access.mjs';
import{HttpError}from'./validation.mjs';
import{createHash}from'node:crypto';

export function readSecret(store,key){const encoded=store.get(key);return encoded?JSON.parse(store.unseal(encoded)):null;}
export function networkIdentity(store){
 let keys=readSecret(store,'wg-identity');if(!keys){keys=wgKeys();store.set('wg-identity',store.seal(JSON.stringify(keys)));}
 return{publicKey:keys.publicKey};
}
export function networkView(store){
 const config=readSecret(store,'network-config');
 if(!config)return{configured:false,...networkIdentity(store),role:store.get('settings').role};
 const{privateKey,...safe}=config;return{...safe,publicKey:wgPublic(privateKey),configured:true};
}
export async function saveNetwork(store,data,request){
 if(!data||typeof data!=='object'||Object.keys(data).some(key=>!['physicalInterface','address','listenPort','peers'].includes(key)))throw new HttpError(400,'存在不支持的隧道字段');
 networkIdentity(store);const keys=readSecret(store,'wg-identity');
 const info=await request('inspect');
 const config=validateNetwork({...data,role:store.get('settings').role,privateKey:keys.privateKey,wireguardInterface:'vps-wg',uids:[info.uids['vmess.att'],info.uids['hy2.att']]});
 store.set('runtime',{...store.get('runtime'),maintenance:true});
 const result=await request('configure-network',{config});
 if(result.relayNeedsConfirmation){store.set('relay-pending',store.get('relay-config'));store.set('relay-config',null);store.set('auth-services',null);store.set('access-applied',{});}
 store.set('network-config',store.seal(JSON.stringify(config)));store.audit('保存WG配对并保持停止');
 return{...networkView(store),relayNeedsConfirmation:!!result.relayNeedsConfirmation};
}
export function relayView(store){
 const active=readSecret(store,'relay-config'),config=active||readSecret(store,'relay-pending');if(!config)return{configured:false};
 return{configured:!!active,needsConfirmation:!active,domain:config.domain,publicIPv4:config.publicIPv4,physicalInterface:config.physicalInterface,ports:config.ports};
}
export async function saveRelay(store,data,request){
 if(store.get('settings').role!=='relay')throw new HttpError(409,'出口机没有代理协议入口');
 if(!data||typeof data!=='object'||Object.keys(data).some(key=>!['domain','publicIPv4','ports'].includes(key)))throw new HttpError(400,'存在不支持的线路字段');
 const network=readSecret(store,'network-config');if(!network)throw new HttpError(409,'请先完成WG配对配置');
 const info=await request('inspect'),previous=readSecret(store,'relay-config')||readSecret(store,'relay-pending');
 const authServices=previous?.authServices||{port:18444,secrets:{'hy2.att':token(),'hy2.direct':token()}};
 const stats=previous?.stats||{'vmess.att':{port:19001},'vmess.direct':{port:19002},'hy2.att':{port:19003,secret:token()},'hy2.direct':{port:19004,secret:token()}};
 const peer=network.peers[0];
 const config=validateRelay({...data,physicalInterface:network.physicalInterface,wireguardInterface:network.wireguardInterface,endpointIPv4:peer.endpointIPv4,endpointPort:peer.endpointPort,endpointPublicKey:peer.publicKey,uids:info.uids,controlUid:info.controlUid,stats,authServices});
 if(Object.values(config.ports).some(group=>Object.values(group).some(value=>[network.listenPort,info.panelPort||18443].includes(value))))throw new HttpError(400,'协议入口不能占用管理或WG端口');
 store.set('runtime',{...store.get('runtime'),maintenance:true});
 await request('configure-relay',{config,users:accessUsers(store)});
 store.transaction(()=>{store.set('relay-config',store.seal(JSON.stringify(config)));store.set('relay-pending',null);store.set('auth-services',store.seal(JSON.stringify(authServices.secrets)));store.set('access-applied',{});store.audit('保存代理线路并保持停止');});
 return relayView(store);
}
export async function serviceAction(store,input,request){
 if(!input||!['start','stop','restart','stop-all','emergency-stop','release-emergency','policy','network-up','network-down'].includes(input.action))throw new HttpError(400,'服务操作不正确');
 const{action}=input;
 if(['start','stop','restart'].includes(action)&&!streams.includes(input.stream))throw new HttpError(400,'线路标识错误');
 if(['start','restart'].includes(action)){
  if(store.get('runtime')?.emergencyStop)throw new HttpError(409,'请先解除急停');
  if(!readSecret(store,'relay-config'))throw new HttpError(409,'请先配置代理线路');
  store.set('runtime',{...store.get('runtime'),maintenance:false});
 }
 if(['stop-all','emergency-stop'].includes(action))store.set('runtime',{...store.get('runtime'),maintenance:true,emergencyStop:action==='emergency-stop'||!!store.get('runtime')?.emergencyStop});
 if(action==='release-emergency'&&input.confirmed!==true)throw new HttpError(409,'必须确认解除急停');
 if(action==='network-up'&&!readSecret(store,'network-config'))throw new HttpError(409,'请先重新确认WG配对配置');
 if(action==='network-up'){
  if(store.get('runtime')?.emergencyStop)throw new HttpError(409,'请先解除急停');
  store.set('runtime',{...store.get('runtime'),maintenance:false});
 }
 if(action==='policy'&&(typeof input.autoStart!=='boolean'||typeof input.autoRepair!=='boolean'))throw new HttpError(400,'自启动和修复设置错误');
 let result;
 try{result=await request(action,{stream:input.stream,confirmed:input.confirmed,autoStart:input.autoStart,autoRepair:input.autoRepair});}
 catch(error){throw new HttpError(502,error.code==='AGENT_ERROR'?error.message:'系统操作未完成，请查看诊断；停止及急停意图已保留');}
 if(action==='release-emergency')store.set('runtime',{...store.get('runtime'),emergencyStop:!!result.emergencyStop,maintenance:true});
 if(action==='policy')store.set('settings',{...store.get('settings'),autoStart:input.autoStart,autoRepair:input.autoRepair});
 store.audit('执行服务操作',{action,stream:input.stream});return result;
}
export function liveUsers(store,rows){
 const now=store.clock(),live=store.get('live-traffic')||{},statuses=store.get('service-status');
 const applied=store.get('access-applied')||{},credentials=store.db.prepare('SELECT credentials FROM users WHERE id=?');
 const fresh=statuses&&now-statuses.at<=20000&&now>=statuses.at;
 return rows.map(user=>{
  const values=streams.map(stream=>{
   const record=live[user.id]?.[stream],health=store.get('collector-health.'+stream);
   return fresh&&statuses.profiles[stream]?.active&&health?.ok&&now-health.at<=20000&&record&&now-record.at<=20000?record:null;
  }).filter(Boolean);
  const known=values.filter(item=>item.connections!==null);
  const relevant=streams.filter(stream=>user.protocols.includes(stream.split('.')[0])&&user.exits.includes(stream.split('.')[1]));
  const active=fresh?relevant.filter(stream=>statuses.profiles[stream]?.active):[];
  let synchronized=false;
  if(active.length){const encoded=credentials.get(user.id)?.credentials;if(encoded){const secret=JSON.parse(store.unseal(encoded));synchronized=active.every(stream=>applied[stream]?.epoch===statuses.profiles[stream].epoch&&applied[stream].users?.[user.id]===createHash('sha256').update(secret[stream.split('.')[0]]).digest('hex'));}}
  const deployment=fresh?(active.length?(synchronized?'已部署':'等待权限同步'):'已停止'):'未部署';
  const accountStatus=!user.enabled?'已停用':user.expires!==null&&user.expires<=now?'已过期':user.quota!==null&&user.up+user.down>=user.quota?'额度已用尽':deployment;
  return{...user,deployment,accountStatus,online:known.length?known.some(item=>item.connections>0):null,speedUp:values.some(item=>item.up!==null)?values.reduce((sum,item)=>sum+(item.up||0),0):null,speedDown:values.some(item=>item.down!==null)?values.reduce((sum,item)=>sum+(item.down||0),0):null};
 });
}
