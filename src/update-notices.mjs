import{enqueueEvent}from'./bark.mjs';
const labels={available:'发现新版本',required:'有高危版本，请立即更新！',upcoming:'即将更新',started:'开始更新',completed:'更新完成',failed:'更新失败'};
export function emitUpdateNotice(store,phase,key,{version='',at,detail=''}={}){
 if(!labels[phase])return null;
 return store.transaction(()=>{const seen=store.get('update-notice-seen')||{},id=phase+':'+key;if(seen[id])return seen[id].eventId||null;
  const body=labels[phase]+(version?'：'+version:'')+(at?'，预约时间 '+new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'')+(detail?'。'+detail:'。');
  const eventId=enqueueEvent(store,'update.status',{body,status:labels[phase],version},{key:'update.status.'+id,cooldown:0});seen[id]={at:store.clock(),eventId};store.set('update-notice-seen',Object.fromEntries(Object.entries(seen).slice(-512)));return eventId;
 });
}
export function observeUpdateNotices(store,view){
 if(!view)return;
 const baseline=store.get('update-notice-baseline')??store.clock();if(store.get('update-notice-baseline')===undefined)store.set('update-notice-baseline',baseline);
 if(view.hasUpdate&&view.available){emitUpdateNotice(store,view.required?'required':'available',view.available.version,{version:view.available.version,detail:view.required?'当前版本存在紧急安全更新，请登录面板立即更新。':'可在面板查看更新内容，选择立即更新或预约。'});}
 if(view.plan?.state==='scheduled'&&view.plan.at-store.clock()<=300000)emitUpdateNotice(store,'upcoming',view.plan.at+':'+view.plan.version,{version:view.plan.version,at:view.plan.at});
 if(view.job?.step==='queued')emitUpdateNotice(store,'upcoming',view.job.at,{version:view.job.version,detail:'更新即将开始，线路会短暂暂停。'});
 for(const row of view.history||[]){if(!Number.isFinite(row.at)||row.at<baseline||store.clock()-row.at>86400000)continue;const phase=row.step==='downloading'?'started':row.step==='complete'?'completed':/^(failed|rollback-failed)/.test(row.step)?'failed':null;if(phase)emitUpdateNotice(store,phase,row.runId||row.at,{version:row.version||'',detail:phase==='completed'?'更新检查已通过，已按原先启停设置恢复。':phase==='failed'?'请查看更新结果并导出日志；自动恢复未完成时使用SSH应急菜单。':''});}
}
