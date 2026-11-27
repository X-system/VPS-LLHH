import{lineIds}from'./line-permissions.mjs';
import{HttpError,text}from'./validation.mjs';

export function subscriptionSettings(store){
 const saved=store.get('subscription-settings')||{},server=store.get('settings').serverName;
 return{title:saved.title||server,names:Object.fromEntries(lineIds.map(id=>[id,saved.names?.[id]||`${server} · ${id.startsWith('hy2')?'Hy2':'TCP'} · ${id.endsWith('att')?'ATT':'直出'}`]))};
}
export function saveSubscriptionSettings(store,input){
 if(!input||Object.keys(input).some(k=>!['title','names'].includes(k))||!input.names||Array.isArray(input.names)||Object.keys(input.names).some(k=>!lineIds.includes(k)))throw new HttpError(400,'订阅名称或线路名称格式错误');
 const current=subscriptionSettings(store),next={title:text(input.title,'订阅名称',{max:64}),names:{...current.names}};
 for(const[id,name]of Object.entries(input.names))next.names[id]=text(name,'线路名称',{max:64});
 store.set('subscription-settings',next);store.audit('修改订阅和线路名称');return next;
}
export function catalog(store){
 const settings=subscriptionSettings(store),now=store.clock(),status=store.get('service-status'),runtime=store.get('runtime'),network=store.get('network-status');
 const fresh=status&&now>=status.at&&now-status.at<=20000;
 const encoded=store.get('relay-config'),config=encoded?JSON.parse(store.unseal(encoded)):null;
 return lineIds.map(id=>{
  const[protocol,exit]=id.split('.');let state='unknown',reason='暂未取得最新状态';
  if(!config||config.enabledProtocols&&!config.enabledProtocols.includes(protocol)||exit==='att'&&config.attEnabled===false){state='unavailable';reason='尚未开通';}
  else if(runtime?.maintenance||runtime?.emergencyStop){state='unavailable';reason=runtime.emergencyStop?'已急停':'已停止服务';}
  else if(fresh&&!status.profiles[id]?.active){state='unavailable';reason='线路未启动';}
  else if(fresh){
   state='available';reason='服务运行中';
   if(exit==='att'){
    if(!network||now<network.at||now-network.at>20000){state='unknown';reason='尚未确认隧道状态';}
    else if(!network.up||network.protected===false){state='unavailable';reason='出口隧道不可用';}
   }
  }
  return{id,protocol,exit,name:settings.names[id],state,reason};
 });
}
export function linkPresentation(store){const cfg=subscriptionSettings(store);return{...cfg,serverName:store.get('settings').serverName,states:Object.fromEntries(catalog(store).map(line=>[line.id,line.state]))};}
