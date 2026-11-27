import{eventTypes}from'./bark.mjs';
import{validateAlertRules,defaultRules}from'./metrics.mjs';
import{HttpError}from'./validation.mjs';
export const templateVariables=['server','event','detail','line','status','threshold','minutes','current','user'];
const template=type=>({title:type==='update.status'?'【{server}】更新状态提醒':'【{server}】异常提醒',body:'{detail}'});
export function notificationProfiles(store){
 const saved=store.get('notification-profiles');if(saved){const result=structuredClone(saved);for(const mode of['system','custom']){result[mode].templates||={};for(const key of Object.keys(eventTypes))if(key!=='bark.test'&&!result[mode].templates[key])result[mode].templates[key]=template(key);}return result;}
 const encoded=store.get('bark'),bark=encoded?JSON.parse(store.unseal(encoded)):null;
 const rules=store.get('alert-rules')||{hostRules:defaultRules.map(r=>({...r,enabled:true})),userRules:{spikePercent:80,spikeSeconds:60,bandwidthPercent:50,bandwidthSeconds:600,cooldownSeconds:1800}};
 const events=bark?.events||Object.keys(eventTypes).filter(k=>k!=='bark.test');
 const profile={events,rules,templates:Object.fromEntries(Object.keys(eventTypes).filter(k=>k!=='bark.test').map(k=>[k,template(k)]))};
 return{active:'system',system:structuredClone(profile),custom:structuredClone(profile)};
}
export function notificationSettingsView(store){
 const profiles=notificationProfiles(store),encoded=store.get('bark'),bark=encoded?JSON.parse(store.unseal(encoded)):null,worker=store.get('worker-health'),now=store.clock();
 const state=profiles.enabled===false?'off':!bark?'unconfigured':!profiles[profiles.active].events.length?'disabled':!worker?'waiting':worker.ok&&Number.isFinite(worker.at)&&worker.at<=now&&now-worker.at<=25000?'running':'unavailable';
 const availableEvents=Object.fromEntries(Object.entries(eventTypes).filter(([type])=>store.get('settings').role==='exit'?!type.startsWith('user.'):!type.startsWith('upstream.')));
 return{...profiles,enabled:profiles.enabled!==false,availableEvents,variables:templateVariables,monitoring:{state,configured:!!encoded||!!store.get('notification-profiles'),label:({off:'报警已关闭',unconfigured:'待配置Bark',disabled:'未选择报警事件',waiting:'等待监控数据',running:'监控中',unavailable:'监控异常'})[state]}};
}
function validateTemplate(item){
 for(const[field,max]of[['title',120],['body',2000]]){const text=item?.[field];if(typeof text!=='string'||!text.trim()||text.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))throw new HttpError(400,'报警标题或正文格式不正确');for(const match of text.matchAll(/\{([^{}]+)\}/g))if(!templateVariables.includes(match[1]))throw new HttpError(400,'未知模板变量：'+match[1]);}
 return{title:item.title.trim(),body:item.body.trim()};
}
function validateProfile(value){
 if(!value||!Array.isArray(value.events)||value.events.some(k=>!Object.hasOwn(eventTypes,k)||k==='bark.test'))throw new HttpError(400,'请选择有效的报警事件');
 let rules;try{rules=validateAlertRules(value.rules);}catch(e){throw new HttpError(400,e.message);}
 const templates={};for(const key of Object.keys(eventTypes).filter(k=>k!=='bark.test')){
  const item=value.templates?.[key]||template(key);
  templates[key]=validateTemplate(item);
 }
 return{events:[...new Set(value.events)],rules,templates};
}
export function saveNotificationProfile(store,input){
 if(!input||!['system','custom'].includes(input.mode))throw new HttpError(400,'请选择系统模板或自定义模板');
 const value=validateProfile(input.profile),profiles=notificationProfiles(store);
 if(input.mode==='system')value.templates=Object.fromEntries(Object.keys(value.templates).map(k=>[k,template(k)]));
 profiles[input.mode]=value;profiles.active=input.mode;profiles.enabled=true;
 store.transaction(()=>{store.set('notification-profiles',profiles);store.set('alert-rules',value.rules);store.set('metric-samples',[]);store.set('metric-rule-states',{});store.set('user-alert-states',{});const encoded=store.get('bark');if(encoded){const bark=JSON.parse(store.unseal(encoded));bark.events=value.events;store.set('bark',store.seal(JSON.stringify(bark)));}store.audit('启用报警配置',{mode:input.mode});});
 return notificationSettingsView(store);
}
export function validateNotificationProfiles(value){
 if(!value||!['system','custom'].includes(value.active))throw new HttpError(400,'备份中的报警配置格式错误');
 if(value.enabled!==undefined&&typeof value.enabled!=='boolean')throw new HttpError(400,'报警启停设置错误');
 return{active:value.active,enabled:value.enabled!==false,system:validateProfile(value.system),custom:validateProfile(value.custom)};
}
export function setNotificationEnabled(store,input){
 if(typeof input?.enabled!=='boolean')throw new HttpError(400,'请选择开启或关闭报警');
 const profiles=notificationProfiles(store);profiles.enabled=input.enabled;
 store.transaction(()=>{store.set('notification-profiles',profiles);if(!input.enabled)store.db.prepare("UPDATE events SET status='disabled' WHERE status='pending'").run();store.audit(input.enabled?'重新开启报警':'关闭报警推送');});
 return notificationSettingsView(store);
}
export function notificationTestMessage(store,input){
 const type=input?.type;if(!Object.hasOwn(eventTypes,type)||type==='bark.test'||!['system','custom'].includes(input.mode))throw new HttpError(400,'请选择有效的通知项目和模板');
 const details={
  'entrance.rotated':'安全入口已更新。测试不会更换入口，也不会发送真实入口地址。','panel.changed':'面板管理连接已变更。测试不会修改地址或端口。','login.failures':'检测到短时间多次登录失败，请检查账户安全。','user.quota':'用户“示例用户”已使用流量额度的90%。',
  'user.spike':'用户“示例用户”持续占用较高带宽，当前约320Mbps，请立即检查。','user.bandwidth':'用户“示例用户”持续占用带宽10分钟，当前约320Mbps，请立即检查。','host.bandwidth':'当前带宽持续占用300Mbps，且已满10分钟，请立即检查。',
  'host.cpu':'CPU占用持续达到90%，且已满5分钟，请立即检查。','host.memory':'内存占用持续达到90%，且已满5分钟，请立即检查。','host.disk':'磁盘占用持续达到90%，请及时清理空间。',
  'service.failed':'Hy2 → ATT线路运行异常，请立即检查。','service.started':'Hy2直出线路已启动。','service.stopped':'Hy2直出线路已主动停止。','service.recovered':'Hy2 → ATT线路已恢复正常。','tunnel.failed':'ATT隧道连接异常，TCP及Hy2 → ATT线路不可用，请立即检查。',
  'upstream.disconnected':'中转机“示例中转”连接已断开，请立即检查。','upstream.connected':'中转机“示例中转”连接已恢复。','update.status':'发现新版本，可在面板查看更新内容；高危版本请立即更新。','certificate.failed':'证书自动续签失败，请检查域名解析和DNS授权。','repair.started':'正在自动修复Hy2 → ATT线路。','repair.succeeded':'Hy2 → ATT线路已修复。','repair.failed':'Hy2 → ATT线路自动修复失败，请检查日志。','maintenance.failed':'面板更新未完成，已尝试回退，请检查维护日志。'
 };
 const name=store.get('settings').serverName,selected=input.mode==='custom'?validateTemplate(input.template):template(type),data={server:name,event:eventTypes[type],detail:details[type],line:type.startsWith('upstream.')?'示例中转':['service.started','service.stopped'].includes(type)?'Hy2直出':'Hy2 → ATT',status:['service.started','service.recovered','upstream.connected','repair.succeeded'].includes(type)?'正常':type==='service.stopped'?'停止':'异常',threshold:type.startsWith('host.')&&type!=='host.bandwidth'?'90%':'300Mbps',minutes:type==='host.cpu'||type==='host.memory'?5:10,current:type.startsWith('host.')&&type!=='host.bandwidth'?'95%':'320Mbps',user:'示例用户'};
 const fill=text=>text.replace(/\{([^{}]+)\}/g,(_,key)=>String(data[key]??''));
 return{title:'【测试】'+fill(selected.title),body:'这是一条测试通知，不代表服务器发生真实故障。\n\n'+fill(selected.body),group:name};
}
export function renderNotification(store,type,data,fallback){
 const profiles=store.get('notification-profiles');if(!profiles||profiles.active!=='custom')return fallback;
 const selected=profiles.custom.templates[type];if(!selected)return fallback;
 const values={server:store.get('settings').serverName,event:eventTypes[type],detail:fallback.body,...Object.fromEntries(templateVariables.filter(k=>!['server','event','detail'].includes(k)).map(k=>[k,data[k]??'']))};
 const fill=text=>text.replace(/\{([^{}]+)\}/g,(_,key)=>String(values[key]??''));
 return{...fallback,title:fill(selected.title),body:fill(selected.body)};
}
