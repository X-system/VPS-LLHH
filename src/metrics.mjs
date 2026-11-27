import { enqueueEvent } from './bark.mjs';

export const defaultRules=[
  {id:'host.cpu',metric:'cpuPercent',threshold:90,windowSeconds:300,cooldownSeconds:1800},
  {id:'host.memory',metric:'memoryPercent',threshold:90,windowSeconds:300,cooldownSeconds:1800},
  {id:'host.disk',metric:'diskPercent',threshold:90,windowSeconds:60,cooldownSeconds:3600},
  {id:'host.bandwidth.up',type:'host.bandwidth',metric:'uploadMbps',capacity:true,threshold:90,windowSeconds:600,cooldownSeconds:1800},
  {id:'host.bandwidth.down',type:'host.bandwidth',metric:'downloadMbps',capacity:true,threshold:90,windowSeconds:600,cooldownSeconds:1800}
];
const defaultUserRules={spikePercent:80,spikeSeconds:60,bandwidthPercent:50,bandwidthSeconds:600,cooldownSeconds:1800};
export function alertRules(store){return store.get('alert-rules')||{hostRules:defaultRules.map(rule=>({...rule,enabled:true})),userRules:defaultUserRules};}
export function validateAlertRules(input){
 if(!input||!Array.isArray(input.hostRules)||input.hostRules.length!==defaultRules.length||!input.userRules)throw new Error('告警规则格式错误');
 const seen=new Set();
 const hostRules=input.hostRules.map(value=>{
  const base=defaultRules.find(rule=>rule.id===value.id);if(!base||seen.has(value.id)||typeof value.enabled!=='boolean')throw new Error('告警规则标识错误');seen.add(value.id);
  for(const[key,min,max]of[['threshold',1,100],['windowSeconds',10,3600],['cooldownSeconds',60,86400]])if(!Number.isInteger(value[key])||value[key]<min||value[key]>max)throw new Error('告警阈值或时间范围错误');
  return{...base,enabled:value.enabled,threshold:value.threshold,windowSeconds:value.windowSeconds,cooldownSeconds:value.cooldownSeconds};
 });
 const userRules={};for(const[key,min,max]of[['spikePercent',1,100],['spikeSeconds',5,3600],['bandwidthPercent',1,100],['bandwidthSeconds',5,3600],['cooldownSeconds',60,86400]]){
  const value=input.userRules[key];if(!Number.isInteger(value)||value<min||value>max)throw new Error('用户告警阈值或时间错误');userRules[key]=value;
 }
 return{hostRules,userRules};
}
export function configureAlertRules(store,input){const result=validateAlertRules(input);store.set('alert-rules',result);store.audit('更新告警阈值');return result;}

export function evaluateRules(store,sample,rules=alertRules(store).hostRules){
  const now=store.clock(),retained=store.get('metric-samples')||[];
  for(const [key,value]of Object.entries(sample))if(!['cpuPercent','memoryPercent','diskPercent','uploadMbps','downloadMbps'].includes(key)||typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error('监控样本格式错误');
  const priorAt=retained.at(-1)?.at;
  if(priorAt!==undefined&&now<=priorAt)throw new Error('监控样本时间必须递增');
  // A missing collector interval must not be interpreted as continuous high usage.
  const samples=(priorAt!==undefined&&now-priorAt>60000?[]:retained).filter(item=>now-item.at<=3900000);
  samples.push({at:now,...sample});
  store.set('metric-samples',samples.slice(-900));
  const states=store.get('metric-rule-states')||{};
  const alerts=[];
  for(const rule of rules){
    if(rule.enabled===false)continue;
    const start=now-rule.windowSeconds*1000;
    const history=samples.filter((item,index)=>item.at>=start||(index+1<samples.length&&samples[index+1].at>start));
    if(history.length<2||history[0].at>start||history.some(item=>item[rule.metric]===undefined))continue;
    let average=0,duration=0;
    for(let index=1;index<history.length;index++){
      const span=history[index].at-Math.max(start,history[index-1].at);average+=history[index-1][rule.metric]*span;duration+=span;
    }
    if(!duration)continue;average/=duration;
    const threshold=rule.capacity?store.get('settings').bandwidthMbps*rule.threshold/100:rule.threshold;
    const exceeded=average>=threshold;
    const old=states[rule.id];
    if(exceeded){
      const body=`${rule.metric} 在${rule.windowSeconds/60}分钟窗口平均为${average.toFixed(1)}，阈值${threshold.toFixed(1)}。`;
      const id=enqueueEvent(store,rule.type||rule.id,{body},{key:rule.id,cooldown:rule.cooldownSeconds*1000});
      if(id)alerts.push(id);
      states[rule.id]={active:true,last:now};
    }else if(old?.active){
      const id=enqueueEvent(store,'repair.succeeded',{body:`${rule.metric} 已恢复至阈值以下。`},{key:rule.id+'.recovered',cooldown:rule.cooldownSeconds*1000});
      if(id)alerts.push(id);states[rule.id]={active:false,last:now};
    }
  }
  store.set('metric-rule-states',states);return alerts;
}

export function evaluateUserAlerts(store){
 const now=store.clock(),rules=alertRules(store).userRules,states=store.get('user-alert-states')||{},live=store.get('live-traffic')||{},statuses=store.get('service-status');
 const users=store.db.prepare('SELECT u.id,u.name,u.enabled,u.quota,COALESCE(t.up,0)+COALESCE(t.down,0) AS used FROM users u LEFT JOIN totals t ON t.user_id=u.id').all(),known=new Set(users.map(user=>user.id));
 for(const id of Object.keys(states))if(!known.has(id))delete states[id];
 for(const user of users){
  if(!user.enabled){delete states[user.id];continue;}
  if(user.quota>0&&user.used>=user.quota*.9)enqueueEvent(store,'user.quota',{body:`用户“${user.name}”已使用额度的${Math.floor(user.used/user.quota*100)}%。`},{key:'user.quota.'+user.id,cooldown:rules.cooldownSeconds*1000});
  const values=Object.entries(live[user.id]||{}).filter(([stream,value])=>statuses&&now-statuses.at<=20000&&statuses.profiles[stream]?.active&&store.get('collector-health.'+stream)?.ok&&now-value.at<=20000&&value.up!==null&&value.down!==null).map(([,value])=>value);
  if(!values.length){delete states[user.id];continue;}
  const rate=Math.max(values.reduce((sum,value)=>sum+value.up,0),values.reduce((sum,value)=>sum+value.down,0))*8/1e6,capacity=store.get('settings').bandwidthMbps;
  const state=states[user.id]||{};if(!state.at||now-state.at>20000){delete state.spikeSince;delete state.bandwidthSince;}
  for(const[metric,type,percent,seconds]of[['spike','user.spike',rules.spikePercent,rules.spikeSeconds],['bandwidth','user.bandwidth',rules.bandwidthPercent,rules.bandwidthSeconds]]){
   const key=metric+'Since';if(rate>=capacity*percent/100){state[key]??=now;if(now-state[key]>=seconds*1000)enqueueEvent(store,type,{body:`用户“${user.name}”持续占用较高带宽，当前约${rate.toFixed(1)}Mbps。`},{key:type+'.'+user.id,cooldown:rules.cooldownSeconds*1000});}else delete state[key];
  }
  state.at=now;states[user.id]=state;
 }
 store.set('user-alert-states',states);
}
