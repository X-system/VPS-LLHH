import{HttpError}from'./validation.mjs';
const DAY=86400000,FRESH=20000;
export const historyRanges={'5m':{span:300000,step:5000},'1h':{span:3600000,step:15000},'24h':{span:DAY,step:300000}};
export const historyMetrics=['cpu','memory','disk','networkUp','networkDown','tunnelUp','tunnelDown','userUp','userDown'];
const cache=new WeakMap();
const valid=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const percentage=value=>{const number=valid(value);return number!==null&&number<=100?number:null;};
export function captureHistory(store){
 const now=store.clock(),host=store.get('host-telemetry');
 if(!host||!Number.isSafeInteger(host.at)||host.at>now||now-host.at>FRESH)return{recorded:false};
 const snapshots=store.get('traffic-samples')||[],business=snapshots.at(-1),freshBusiness=business&&Number.isSafeInteger(business.at)&&business.at<=now&&now-business.at<=FRESH;
 const data={cpu:percentage(host.cpuPercent),memory:percentage(host.memoryPercent),disk:percentage(host.diskPercent),networkUp:valid(host.physical?.up),networkDown:valid(host.physical?.down),tunnelUp:valid(host.wireguard?.up),tunnelDown:valid(host.wireguard?.down),userUp:freshBusiness?valid(business.up):null,userDown:freshBusiness?valid(business.down):null};
 if(!historyMetrics.some(key=>data[key]!==null))return{recorded:false};
 return store.transaction(()=>{
  const result=store.db.prepare('INSERT OR IGNORE INTO monitor_history(at,data) VALUES(?,?)').run(host.at,JSON.stringify(data));
  if(!result.changes)return{recorded:false};
  if(!store.get('monitor-recorded-since'))store.set('monitor-recorded-since',host.at);
  const pruned=store.get('monitor-pruned-at');if(!pruned||now-pruned>=60000||now<pruned){store.db.prepare('DELETE FROM monitor_history WHERE at<?').run(now-2*DAY);store.set('monitor-pruned-at',now);}
  cache.delete(store);return{recorded:true,at:host.at};
 });
}
export function readHistory(store,range='5m'){
 if(!Object.hasOwn(historyRanges,range))throw new HttpError(400,'请选择5分钟、1小时或24小时');
 const now=store.clock(),cached=cache.get(store)?.get(range);if(cached&&now>=cached.at&&now-cached.at<2000)return cached.data;
 const {span,step}=historyRanges[range],from=now-span,rows=store.db.prepare('SELECT at,data FROM monitor_history WHERE at>=? AND at<=? ORDER BY at').all(from,now),buckets=new Map(),peaks=Object.fromEntries(historyMetrics.map(k=>[k,null]));
 for(const row of rows){
  let data;try{data=JSON.parse(row.data);}catch{continue;}if(!data||typeof data!=='object')continue;
  const id=Math.floor(row.at/step);let bucket=buckets.get(id);if(!bucket){bucket={times:0,count:0,totals:{},counts:{}};buckets.set(id,bucket);}bucket.times+=row.at;bucket.count++;
  for(const key of historyMetrics){const value=valid(data[key]);if(value===null)continue;bucket.totals[key]=(bucket.totals[key]||0)+value;bucket.counts[key]=(bucket.counts[key]||0)+1;peaks[key]=peaks[key]===null?value:Math.max(peaks[key],value);}
 }
 const points=[...buckets.values()].map(bucket=>({at:Math.round(bucket.times/bucket.count),samples:bucket.count,...Object.fromEntries(historyMetrics.map(key=>[key,bucket.counts[key]?bucket.totals[key]/bucket.counts[key]:null]))}));
 const latestRow=store.db.prepare('SELECT at,data FROM monitor_history WHERE at<=? ORDER BY at DESC LIMIT 1').get(now);let latest=null;
 if(latestRow)try{const data=JSON.parse(latestRow.data);latest={at:latestRow.at,...Object.fromEntries(historyMetrics.map(key=>[key,valid(data[key])]))};}catch{}
 const result={range,from,to:now,stepMs:step,sampleIntervalMs:5000,points,peaks,latest,fresh:!!latest&&now-latest.at<=FRESH,recordedSince:store.get('monitor-recorded-since')||null};
 let records=cache.get(store);if(!records){records=new Map();cache.set(store,records);}records.set(range,{at:now,data:result});return result;
}
export function createHistorySampler(store,{intervalMs=5000}={}){
 const sample=()=>{try{return captureHistory(store);}catch{return{recorded:false,error:true};}};
 const timer=setInterval(sample,intervalMs);timer.unref();sample();
 return{sample,close:()=>clearInterval(timer)};
}
