import{hashPassword,token,digest}from'./security.mjs';
import{HttpError,text}from'./validation.mjs';
import{saveRelay,serviceAction,readSecret}from'./deployment.mjs';
import{configureBark}from'./bark.mjs';
import{lookup}from'node:dns/promises';

export function resumeSetup(store){
 const role=store.get('settings').role,certificate=readSecret(store,'certificate-settings'),previous=readSecret(store,'relay-config')||readSecret(store,'relay-pending');
 store.set('settings',{...store.get('settings'),uiVersion:2});
 store.set('onboarding',{version:2,step:role==='relay'?'protocols':'bark',completed:['account','name'],draft:{serverName:store.get('settings').serverName,protocols:previous?.enabledProtocols||['hy2'],...(certificate?.domain?{domain:certificate.domain}:{}),recovery:true}});
 for(const key of['att-binding','att-invitation','att-pending','att-outgoing'])store.set(key,null);
}

export function createOnboarding({store,request,fetchImpl=fetch,allowLocalBark=false,resolve=lookup}){
 let running=null,advancing=false,syncing=null;
 const read=()=>store.get('onboarding');
 const initial=read();if(initial?.job?.state==='running'){store.set('onboarding',{...initial,job:{...initial.job,state:'failed',message:'上次配置被中断，请重新检查并继续'}});store.set('runtime',{...store.get('runtime'),maintenance:true});}
 const steps=()=>[...(read()?.welcome?['welcome']:[]),...(store.get('settings').role==='exit'?['account','name','bark','pairing','review']:['account','name','protocols',...(read()?.draft?.protocols?.includes('hy2')?['certificate']:[]),'bark','pairing','review'])];
 function view(){const state=read();if(!state)return{active:false};return{active:state.step!=='done',step:state.step,steps:steps(),completed:state.completed,draft:state.draft,hasCertificateSettings:!!store.get('certificate-settings'),job:state.job||null,role:store.get('settings').role};}
 function move(state){const order=steps(),index=order.indexOf(state.step);store.set('onboarding',{...state,completed:[...new Set([...state.completed,state.step])],step:order[index+1]||'review',job:null});return view();}
 async function zone(domain,secret){
  if(typeof domain!=='string'||!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)||typeof secret!=='string'||!/^[A-Za-z0-9_-]{20,256}$/.test(secret))throw new HttpError(400,'请填写有效域名和Cloudflare令牌');
  const labels=domain.split('.');for(let i=0;i<labels.length-1;i++){
   const response=await fetchImpl('https://api.cloudflare.com/client/v4/zones?name='+encodeURIComponent(labels.slice(i).join('.')),{headers:{Authorization:'Bearer '+secret},redirect:'error',signal:AbortSignal.timeout(10000)});
   const data=await response.json();if(!response.ok||!data.success)throw new HttpError(400,'无法读取Cloudflare域名区域；请使用含区域读取和DNS编辑权限的令牌，或手动填写区域ID');
   if(data.result?.length===1)return data.result[0].id;
  }throw new HttpError(400,'该令牌下没有找到这个域名，请检查域名或令牌的授权范围');
 }
 async function advanceInner(input){
  const state=read();if(!state||state.step==='done')throw new HttpError(409,'初始化引导已经完成');
  if(running)throw new HttpError(409,'正在自动配置，请等待检查结果');
  if(!input||typeof input!=='object'||Array.isArray(input)||input.step!==state.step)throw new HttpError(409,'引导进度已更新，请重新获取当前步骤');
  if(input.back===true){const order=steps(),index=order.indexOf(state.step);if(index<=1)throw new HttpError(409,'账户已设置，请在完成引导后到面板设置修改');const target=order[index-1];store.set('onboarding',{...state,step:target,completed:state.completed.filter(id=>order.indexOf(id)<index-1),job:null});return view();}
  if(state.step==='welcome'){move(state);return view();}
  if(state.step==='account'){
   const username=text(input.username,'管理员名称',{max:48});if(typeof input.password!=='string'||input.password.length===0)throw new HttpError(400,'密码不能为空');
   const password=await hashPassword(input.password),raw=token(),csrf=token();
   store.transaction(()=>{store.db.prepare('UPDATE admin SET username=?,password=? WHERE id=1').run(username,password);store.db.exec('DELETE FROM sessions');store.set('bootstrap-access',null);store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(raw),csrf,store.clock()+10*3600000);move(state);store.audit('完成引导账户设置');});
   return{...view(),session:{raw,csrf}};
  }
  if(state.step==='name'){
   const serverName=text(input.serverName,'服务器名称',{max:48});store.set('settings',{...store.get('settings'),serverName});state.draft.serverName=serverName;
  }
  if(state.step==='protocols'){
   if(!Array.isArray(input.protocols)||!input.protocols.length||new Set(input.protocols).size!==input.protocols.length||input.protocols.some(id=>!['hy2','vmess'].includes(id)))throw new HttpError(400,'请至少选择一种支持的协议');
   state.draft.protocols=input.protocols;store.set('onboarding',state);
  }
  if(state.step==='certificate'){
   if(!request)throw new HttpError(501,'此实例没有连接服务器管理器');
   if(input.check===true){const cert=await request('certificate-status');if(cert.certificateStaging!==false||cert.certificateDomain!==state.draft.domain||!cert.notAfter||cert.notAfter<=store.clock())throw new HttpError(409,cert.job?'正在申请证书，请稍候再检查':'尚未取得有效证书，请检查申请结果');}
   else{
    const domain=text(input.domain,'代理域名',{max:253}).toLowerCase();if(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))throw new HttpError(400,'请填写有效域名');
    const saved=readSecret(store,'certificate-settings'),secret=(typeof input.token==='string'?input.token.trim():input.token)||saved?.token;
    if(typeof secret!=='string'||!/^[A-Za-z0-9_-]{20,256}$/.test(secret))throw new HttpError(400,'请粘贴有效的Cloudflare令牌');
    const zoneId=(typeof input.zoneId==='string'?input.zoneId.trim().toLowerCase():input.zoneId)||(saved?.domain===domain?saved.zoneId:null)||await zone(domain,secret),settings={domain,zoneId,token:secret,email:(typeof input.email==='string'?input.email.trim():input.email)||saved?.email,termsAccepted:input.termsAccepted,staging:false};
    await request('certificate-configure',settings);store.set('certificate-settings',store.seal(JSON.stringify(settings)));state.draft.domain=domain;store.set('onboarding',state);
    await request('certificate-issue');return view();
   }
  }
  if(state.step==='bark'&&input.skip!==true){if(typeof input.url!=='string'||!input.url.trim())throw new HttpError(400,'请粘贴Bark链接，或选择稍后配置');configureBark(store,{pushUrl:input.url},{allowLocalHttp:allowLocalBark});}
  if(state.step==='pairing'){
   if(store.get('settings').role==='relay'){
    if(typeof input.useAtt!=='boolean')throw new HttpError(400,'请选择是否使用ATT出口');
    if(input.useAtt&&(!readSecret(store,'network-config')||!readSecret(store,'att-binding')))throw new HttpError(409,'请先完成ATT配对，或选择仅使用直出');
    state.draft.useAtt=input.useAtt;
   }
  }
  if(state.step==='review'){
   if(input.confirmed!==true)throw new HttpError(409,'请确认完成配置并开启所选服务');
   if(state.draft.recovery&&input.releaseRecovery!==true)throw new HttpError(409,'恢复配置后，请明确确认解除恢复保护并启动服务');
   if(!request)throw new HttpError(501,'此实例没有连接服务器管理器');
   const admitted=await request('inspect'),jobId=token();store.set('onboarding',{...state,job:{id:jobId,state:'running',phase:'检查服务器环境',releaseRecovery:state.draft.recovery&&input.releaseRecovery===true,started:store.clock(),automationToken:admitted.stopTokens?.automation??null}});
   running=complete(jobId).finally(()=>{running=null;});return view();
  }
  return move(state);
 }
 async function complete(id){
  const started=[];const expected=read()?.job?.automationToken??null;
  const phase=async label=>{
   const current=read();if(current.job?.id!==id)throw new Error('配置任务已取消');
   const info=await request('inspect');if((info.stopTokens?.automation??null)!==expected)throw new Error('已收到手动停止操作，配置任务已取消');
   store.set('onboarding',{...current,job:{...current.job,phase:label}});return info;
  };
  try{
   const info=await phase('检查环境与服务保护'),state=read(),role=store.get('settings').role;
   if(state.job.releaseRecovery){await phase('解除已确认的恢复保护');await serviceAction(store,{action:'release-emergency',confirmed:true,expectedAutomationToken:expected},request);}
   if(role==='relay'){
    const protocols=state.draft.protocols;if(!protocols?.length)throw new Error('尚未选择协议');
    const plan=await request('plan-relay');if(!plan.publicIPv4)throw new Error('未能自动识别公网IPv4，请导出诊断检查');
    if(protocols.includes('hy2')){
     const cert=await request('certificate-status');if(cert.certificateStaging!==false||cert.certificateDomain!==state.draft.domain||!cert.notAfter||cert.notAfter<=store.clock())throw new Error('Hy2证书尚未就绪');
     let addresses=[];try{addresses=await resolve(state.draft.domain,{family:4,all:true});}catch{}
     if(!addresses.some(address=>address.address===plan.publicIPv4))throw new Error('域名尚未指向本机，请检查A记录使用仅DNS，并等待解析生效后重试');
    }
    await phase('自动生成线路与防护配置');
    const previous=readSecret(store,'relay-config')||readSecret(store,'relay-pending');
    await saveRelay(store,{domain:protocols.includes('hy2')?state.draft.domain:plan.publicIPv4,publicIPv4:plan.publicIPv4,ports:previous?.ports||plan.ports,enabledProtocols:protocols,attEnabled:state.draft.useAtt===true},request);
    await phase('开启自动启动与故障恢复');await serviceAction(store,{action:'policy',autoStart:true,autoRepair:true,expectedAutomationToken:expected},request);
    for(const protocol of protocols)for(const exit of state.draft.useAtt?['direct','att']:['direct']){
     if(state.job.resumeStreams&&!state.job.resumeStreams.includes(protocol+'.'+exit))continue;
     await phase('启动'+(protocol==='hy2'?'Hy2':'TCP')+' · '+(exit==='att'?'ATT出口':'本机直出'));
     const stream=protocol+'.'+exit;await serviceAction(store,{action:'start',stream,expectedAutomationToken:expected},request);started.push(stream);
    }
    await phase('检查线路和断线保护');const status=await request('status');
    if(!status.guardPresent||started.some(stream=>!status.profiles[stream]?.active)||started.some(stream=>stream.endsWith('.att'))&&(!status.network?.up||status.network.protected!==true))throw new Error('线路或保护规则未通过自检，尚未完成开通');
   }else{
    await serviceAction(store,{action:'policy',autoStart:true,autoRepair:true,expectedAutomationToken:expected},request);
    if(readSecret(store,'network-config')?.peers?.length){await phase('检查已配对出口隧道');await serviceAction(store,{action:'network-up',expectedAutomationToken:expected},request);const status=await request('status');if(!status.network?.up||status.network.protected!==true)throw new Error('出口隧道未通过本机检查');}
   }
   await phase('保存配置与检查结果');const current=read();
   store.transaction(()=>{store.set('onboarded',true);store.set('onboarding',{...current,step:'done',completed:steps(),job:{...current.job,state:'done',phase:role==='exit'?'出口端已准备好，可随时配对中转':started.length?'所选服务已通过本机检查':'配置已更新，线路保持停止',finished:store.clock()}});store.audit('自动初始化完成',{role});});
  }catch(error){
   for(const stream of started)try{await serviceAction(store,{action:'stop',stream},request);}catch{}
   store.set('runtime',{...store.get('runtime'),maintenance:true});
   const current=read();store.set('onboarding',{...current,job:{...current.job,state:'failed',message:error.code==='AGENT_ERROR'||error instanceof HttpError||typeof error.message==='string'&&/[\u4e00-\u9fff]/.test(error.message)?error.message:'自动配置未完成，请重试或导出诊断',finished:store.clock()}});
  }
 }
 async function apply(input,{resumeDesired,expectedAutomationToken}={}){
  if(!store.get('onboarded'))throw new HttpError(409,'请先完成首次引导');
  if(view().active)throw new HttpError(409,'请先完成当前设置引导');
  if(running)throw new HttpError(409,'正在应用上一项配置，请等待结果');
  if(!input||Object.keys(input).some(key=>!['protocols','startAll'].includes(key))||input.startAll!==undefined&&typeof input.startAll!=='boolean')throw new HttpError(400,'服务配置格式错误');
  const current=readSecret(store,'relay-config')||readSecret(store,'relay-pending');if(!current)throw new HttpError(409,'尚未配置代理线路');
  const protocols=input.protocols??current.enabledProtocols??['vmess','hy2'];
  if(!Array.isArray(protocols)||!protocols.length||new Set(protocols).size!==protocols.length||protocols.some(id=>!['vmess','hy2'].includes(id)))throw new HttpError(400,'请至少选择一种支持的协议');
  const admitted=await request('inspect');if(expectedAutomationToken!==undefined&&(admitted.stopTokens?.automation??null)!==expectedAutomationToken)throw new HttpError(409,'已收到人工停止，配对已保存，线路保持停止');
  const status=await request('status'),paired=!!readSecret(store,'att-binding')&&!!readSecret(store,'network-config'),resumeStreams=[];
  for(const protocol of protocols)for(const exit of paired?['direct','att']:['direct']){
   const id=protocol+'.'+exit,isNew=!(current.enabledProtocols||['vmess','hy2']).includes(protocol)||exit==='att'&&current.attEnabled===false;
   if(input.startAll||isNew||(resumeDesired||status.desired)?.[id]===true)resumeStreams.push(id);
  }
  const state=read()||{version:2,completed:[]},id=token();
  const certificate=readSecret(store,'certificate-settings');
  store.set('onboarding',{...state,step:'done',draft:{serverName:store.get('settings').serverName,protocols,domain:protocols.includes('hy2')&&certificate?.domain||current.domain,useAtt:paired},job:{id,state:'running',phase:'准备应用服务配置',resumeStreams,started:store.clock(),automationToken:admitted.stopTokens?.automation??null}});
  running=complete(id).finally(()=>{running=null;});return view();
 }
 async function syncCertificate(){
  if(syncing||running||advancing||view().active||!request||!store.get('onboarded')||store.get('settings').uiVersion!==2||store.get('settings').role!=='relay')return;
  syncing=(async()=>{
   const current=readSecret(store,'relay-config'),certificate=readSecret(store,'certificate-settings');
   if(!current||!certificate||current.domain===certificate.domain||!current.enabledProtocols?.includes('hy2'))return;
   const status=await request('certificate-status');if(status.certificateStaging!==false||status.certificateDomain!==certificate.domain||!status.notAfter||status.notAfter<=store.clock())return;
   await apply({});
  })();try{await syncing;}finally{syncing=null;}
 }
 async function advance(input){if(advancing)throw new HttpError(409,'正在保存当前步骤，请稍候');advancing=true;try{return await advanceInner(input);}finally{advancing=false;}}
 return{view,advance,apply,zone,syncCertificate,wait:async()=>{await syncing;await running;}};
}
