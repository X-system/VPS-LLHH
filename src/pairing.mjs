import{registerNotificationPeer,receiveNotification}from'./notification-relay.mjs';
import{X509Certificate}from'node:crypto';
import{token,digest}from'./security.mjs';
import{HttpError,text}from'./validation.mjs';
import{publicKey,port}from'./core-config.mjs';
import{networkIdentity,networkView,saveNetwork,saveRelay,serviceAction,readSecret}from'./deployment.mjs';
import{decodeInvite,pairingPath,pairingRequest}from'./pairing-transport.mjs';
import{publicProbeIPv4}from'./node-health.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function createPairing({store,request,origin,tls,transport=pairingRequest,allowLocal=false,applyServices,fetchImpl}){
 const load=key=>readSecret(store,'att-'+key),save=(key,value)=>store.set('att-'+key,value?store.seal(JSON.stringify(value)):null);
 let busy=false;
 const normalized=value=>String(value||'').normalize('NFKC').trim().toLocaleLowerCase('en-US');
 function nameConflict(name,key,peers){if(peers.some(peer=>normalized(peer.name)===normalized(name)&&peer.publicKey!==key)){const message='已有名为'+name+'的中转机，请更换命名';save('error',{message});throw new HttpError(409,message);}}
 const role=()=>store.get('settings').role;
 function view(){
  const invitation=load('invitation'),pending=load('pending'),binding=load('binding'),outgoing=load('outgoing');
  const peers=readSecret(store,'network-config')?.peers||[];
  return{role:role(),error:load('error')?.message||null,peers:peers.map(peer=>({name:peer.name||'中转机',publicKey:peer.publicKey,address:peer.address})),invitation:invitation?{expires:invitation.expires,claimed:!!invitation.requestId}:null,pending:pending&&pending.expires>store.clock()?{id:pending.id,name:pending.peer.name,publicIPv4:pending.peer.publicIPv4,state:pending.state}:null,binding:binding?{name:binding.name,publicIPv4:binding.publicIPv4,connectedAt:binding.connectedAt}:null,outgoing:outgoing?{state:outgoing.state,expires:outgoing.expires}:null};
 }
 async function local(){
  if(!request)throw new HttpError(501,'配对需要连接服务器管理器');
  const info=await request('inspect');if(!publicProbeIPv4(info.publicIPv4)&&!allowLocal)throw new HttpError(409,'尚未自动识别本机公网IPv4，请先检查面板安装结果');
  if(!info.physicalInterface)throw new HttpError(409,'没有找到本机出网网卡');
  return{...info,id:store.get('identity'),name:store.get('settings').serverName,publicKey:networkIdentity(store).publicKey};
 }
 function certificateFingerprint(){if(!origin||!tls?.cert)throw new HttpError(409,'请先通过HTTPS地址打开已安装的服务器面板');return new X509Certificate(tls.cert).fingerprint256.replaceAll(':','').toLowerCase();}
 async function invite(){
  if(role()!=='relay')throw new HttpError(409,'请在中转端生成ATT连接密钥');
  const fingerprint=certificateFingerprint(),secret=token(),expires=store.clock()+15*60000;
  save('invitation',{hash:digest(secret),expires});save('pending',null);save('error',null);
  store.audit('生成ATT连接邀请');return{key:'ATT1.'+Buffer.from(JSON.stringify({url:new URL(pairingPath,origin).href,fingerprint,token:secret})).toString('base64url'),expires};
 }
 async function connect(raw){
  if(role()!=='exit')throw new HttpError(409,'请在出口端粘贴中转端生成的ATT连接密钥');
  const previous=load('outgoing');if(previous&&previous.expires>store.clock()&&previous.state!=='bound')throw new HttpError(409,'已有配对请求，请先完成或取消');
  const target=decodeInvite(raw),info=await local(),current=networkView(store),occupied=new Set((current.peers||[]).map(peer=>peer.address));
  const number=Array.from({length:253},(_,i)=>i+2).find(value=>!occupied.has('10.76.0.'+value));if(!number)throw new HttpError(409,'出口已没有可分配的隧道地址');
  const plan=await request('plan-network'),peer={id:info.id,name:info.name,publicIPv4:info.publicIPv4,publicKey:info.publicKey,listenPort:plan.listenPort,notification:{url:new URL(pairingPath,origin).href,fingerprint:certificateFingerprint()},address:'10.76.0.'+number};
  save('error',null);
  let answer;try{answer=await transport(target,{action:'request',peer,occupied:(current.peers||[]).map(p=>({name:p.name,publicKey:p.publicKey}))},{allowLocal});}catch(error){save('error',{message:error.message});throw error;}
  if(!answer?.id||!/^[A-Za-z0-9_-]{32,128}$/.test(answer.pollToken)||!Number.isSafeInteger(answer.expires))throw new HttpError(502,'远端返回的配对信息无效');
  save('outgoing',{target:{...target,token:answer.pollToken},id:answer.id,peer,expires:answer.expires,state:'waiting',automationToken:info.stopTokens?.automation??null});store.audit('发起ATT配对请求');return view();
 }
 async function approve(id){
  if(role()!=='relay')throw new HttpError(409,'请在中转端确认绑定');
  const pending=load('pending');if(!pending||pending.id!==id||pending.expires<=store.clock()||!['pending','approved'].includes(pending.state))throw new HttpError(409,'请求已过期或已处理，请重新发起');
  nameConflict(store.get('settings').serverName,networkIdentity(store).publicKey,pending.occupied||[]);
  const info=await local(),plan=await request('plan-network'),previous=await request('status');
  await saveNetwork(store,{physicalInterface:info.physicalInterface,address:pending.peer.address,listenPort:plan.listenPort,peers:[{name:pending.peer.name,publicKey:pending.peer.publicKey,address:'10.76.0.1',endpointIPv4:pending.peer.publicIPv4,endpointPort:pending.peer.listenPort}]},request);
  save('pending',{...pending,state:'approved',resumeDesired:previous.desired||{},automationToken:info.stopTokens?.automation??null,relay:{id:info.id,name:info.name,publicIPv4:info.publicIPv4,publicKey:info.publicKey,address:pending.peer.address}});store.audit('确认ATT配对请求');return view();
 }
 async function poll(){
  const outgoing=load('outgoing');if(!outgoing||outgoing.state==='bound')return view();
  if(outgoing.expires<=store.clock())throw new HttpError(409,'ATT配对请求已过期，请重新生成密钥');
  const answer=await transport(outgoing.target,{action:'poll',id:outgoing.id},{allowLocal});
  if(answer.state==='pending')return view();
  if(!['approved','bound'].includes(answer.state)||!answer.relay||!UUID.test(answer.relay.id)||answer.relay.address!==outgoing.peer.address)throw new HttpError(409,'中转端没有批准此请求，请重新配对');
  publicKey(answer.relay.publicKey);text(answer.relay.name,'中转名称',{max:48});
  const info=await local(),current=networkView(store),peers=(current.peers||[]).filter(peer=>peer.publicKey!==answer.relay.publicKey);
  try{nameConflict(answer.relay.name,answer.relay.publicKey,peers);}catch(error){try{await transport(outgoing.target,{action:'name-conflict',id:outgoing.id,name:answer.relay.name},{allowLocal});}catch{}throw error;}
  if(peers.some(peer=>peer.address===outgoing.peer.address))throw new HttpError(409,'隧道地址已被其他配对占用，请重新生成密钥');
  peers.push({name:answer.relay.name,publicKey:answer.relay.publicKey,address:outgoing.peer.address});
  if(outgoing.state!=='applied'){
   save('outgoing',{...outgoing,state:'configuring'});
   await saveNetwork(store,{physicalInterface:info.physicalInterface,address:'10.76.0.1',listenPort:outgoing.peer.listenPort,peers},request);
   if(!(await request('status')).emergencyStop&&!store.get('runtime')?.emergencyStop)await serviceAction(store,{action:'network-up',expectedAutomationToken:outgoing.automationToken},request);save('outgoing',{...outgoing,state:'applied'});
  }
  const activated=await transport(outgoing.target,{action:'activate',id:outgoing.id},{allowLocal});if(activated.state!=='bound')throw new HttpError(502,'双方尚未完成配对检查，请稍后再试');
  registerNotificationPeer(store,{id:answer.relay.id,name:answer.relay.name,publicKey:answer.relay.publicKey,target:outgoing.target,key:outgoing.target.token});
  save('binding',{name:answer.relay.name,publicIPv4:answer.relay.publicIPv4,connectedAt:store.clock()});save('outgoing',{...outgoing,state:'bound'});store.audit('ATT配对完成');return view();
 }
 async function machine(secret,payload){
  if(payload?.action==='notification')return receiveNotification(store,secret,payload,{fetchImpl});
  if(role()!=='relay'||typeof secret!=='string'||!payload||typeof payload!=='object')throw new HttpError(404,'Not found');
  const invitation=load('invitation');let pending=load('pending');
  if(payload.action==='request'){
   if(!invitation||invitation.expires<=store.clock()||invitation.hash!==digest(secret))throw new HttpError(404,'Not found');
   const peer=payload.peer;if(!peer||!UUID.test(peer.id)||!publicProbeIPv4(peer.publicIPv4)&&!allowLocal||!/^10\.76\.0\.(?:[2-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/.test(peer.address))throw new HttpError(400,'配对节点信息错误');
   const notification=peer.notification?decodeInvite('ATT1.'+Buffer.from(JSON.stringify({...peer.notification,token:secret})).toString('base64url')):null;
   const clean={...(notification?{notification:{url:notification.url,fingerprint:notification.fingerprint}}:{}),id:peer.id,name:text(peer.name,'出口名称',{max:48}),publicIPv4:peer.publicIPv4,publicKey:publicKey(peer.publicKey),listenPort:port(peer.listenPort),address:peer.address};
   const occupied=payload.occupied||[];if(!Array.isArray(occupied)||occupied.length>253||occupied.some(p=>!p||typeof p.name!=='string'||p.name.length>48||typeof p.publicKey!=='string'))throw new HttpError(400,'已有中转机信息无效');
   nameConflict(store.get('settings').serverName,networkIdentity(store).publicKey,occupied);
   if(invitation.requestId){if(pending?.peer.id!==clean.id||JSON.stringify(pending.peer)!==JSON.stringify(clean))throw new HttpError(404,'Not found');}
   else{pending={id:token(),pollToken:token(),expires:invitation.expires,state:'pending',peer:clean,occupied};save('pending',pending);save('error',null);save('invitation',{...invitation,requestId:pending.id});store.audit('收到ATT绑定请求');}
   return{id:pending.id,pollToken:pending.pollToken,expires:pending.expires};
  }
  if(!pending||pending.expires<=store.clock()||pending.id!==payload.id||digest(pending.pollToken)!==digest(secret))throw new HttpError(404,'Not found');
  if(payload.action==='name-conflict'){const name=text(payload.name,'中转名称',{max:48});save('error',{message:'已有名为'+name+'的中转机，请更换命名'});save('pending',{...pending,state:'rejected'});return{state:'rejected'};}
  if(payload.action==='poll')return{state:pending.state,...(pending.relay?{relay:pending.relay}:{})};
  if(payload.action==='activate'&&['approved','bound'].includes(pending.state)){
   if(pending.state!=='bound'){
    if(!(await request('status')).emergencyStop&&!store.get('runtime')?.emergencyStop)await serviceAction(store,{action:'network-up',expectedAutomationToken:pending.automationToken},request);
    if(pending.peer.notification)registerNotificationPeer(store,{id:pending.peer.id,name:pending.peer.name,publicKey:pending.peer.publicKey,target:pending.peer.notification,key:pending.pollToken});
    save('binding',{name:pending.peer.name,publicIPv4:pending.peer.publicIPv4,connectedAt:store.clock()});save('pending',{...pending,state:'bound'});store.audit('ATT配对完成');
    if(store.get('onboarded')&&applyServices)try{await applyServices({resumeDesired:pending.resumeDesired,expectedAutomationToken:pending.automationToken});}catch{store.audit('配对已保存，线路配置待应用');}
   }return{state:'bound'};
  }
  throw new HttpError(404,'Not found');
 }
 async function disconnect(input){
  if(input.confirmed!==true)throw new HttpError(409,'请确认解除此配对');
  const config=readSecret(store,'network-config');if(!config)throw new HttpError(409,'当前没有配对');
  const info=await local(),before=await request('status'),expected=info.stopTokens?.automation??null;
  if(role()==='relay'){
   const prior=readSecret(store,'relay-config')||readSecret(store,'relay-pending');
   await serviceAction(store,{action:'network-down',expectedAutomationToken:expected},request);await request('forget-network',{expectedAutomationToken:expected});
   store.set('network-config',null);save('binding',null);save('pending',null);save('invitation',null);
   if(prior){
    await saveRelay(store,{domain:prior.domain,publicIPv4:info.publicIPv4,ports:prior.ports,enabledProtocols:prior.enabledProtocols||['vmess','hy2'],attEnabled:false},request);
    for(const protocol of prior.enabledProtocols||['vmess','hy2'])if(before.desired?.[protocol+'.direct'])await serviceAction(store,{action:'start',stream:protocol+'.direct',expectedAutomationToken:expected},request);
   }
  }else{
   const peers=config.peers.filter(peer=>peer.publicKey!==input.publicKey);if(peers.length===config.peers.length)throw new HttpError(404,'找不到这个中转配对');
   await saveNetwork(store,{physicalInterface:config.physicalInterface,address:config.address,listenPort:config.listenPort,peers},request);
   if(peers.length&&before.network?.up)await serviceAction(store,{action:'network-up',expectedAutomationToken:expected},request);
   save('binding',peers.length?{name:peers[0].name||'中转机',publicIPv4:null,connectedAt:store.clock()}:null);save('outgoing',null);
  }
  store.audit('解除ATT配对');return view();
 }
 async function action(input){
  if(!input||!['invite','connect','approve','reject','poll','cancel','disconnect'].includes(input.action))throw new HttpError(400,'配对操作错误');
  if(busy)throw new HttpError(409,'正在处理配对，请稍候');busy=true;
  try{
   if(input.action==='invite')return await invite();if(input.action==='connect')return await connect(input.key);if(input.action==='approve'){if(input.confirmed!==true)throw new HttpError(409,'请确认绑定这台出口机');return await approve(input.id);}if(input.action==='poll')return await poll();
   if(input.action==='disconnect')return await disconnect(input);
   if(input.action==='reject'){const pending=load('pending');if(pending?.id===input.id)save('pending',{...pending,state:'rejected'});}
   if(input.action==='cancel')save('outgoing',null);return view();
  }finally{busy=false;}
 }
 return{view,action,machine};
}
