import{streams}from'./access.mjs';

export function trafficPeriod(now){
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).formatToParts(now);
 const year=Number(parts.find(part=>part.type==='year').value),month=Number(parts.find(part=>part.type==='month').value);
 return{id:year+'-'+String(month).padStart(2,'0'),timeZone:'Asia/Shanghai',start:Date.UTC(year,month-1,1)-8*3600000,end:Date.UTC(year,month,1)-8*3600000};
}
export function addLineUsage(store,{stream,up,down,at}){
 if(!streams.includes(stream)||![up,down,up+down].every(value=>Number.isSafeInteger(value)&&value>=0))throw new Error('线路流量计数错误');
 const period=trafficPeriod(at),prior=store.db.prepare('SELECT up,down FROM line_periods WHERE period=? AND stream=?').get(period.id,stream)||{up:0,down:0};
 if(![prior.up+up,prior.down+down,prior.up+prior.down+up+down].every(Number.isSafeInteger))throw new Error('线路累计超过精确计数范围');
 store.db.prepare('INSERT INTO line_periods VALUES(?,?,?,?,?,?) ON CONFLICT(period,stream) DO UPDATE SET up=up+excluded.up,down=down+excluded.down,last_at=excluded.last_at').run(period.id,stream,up,down,at,at);
}
export function lineUsage(store){
 const now=store.clock(),period=trafficPeriod(now),status=store.get('service-status'),live=store.get('live-traffic')||{};
 const fresh=!!status&&now>=status.at&&now-status.at<=20000;
 const records=store.db.prepare('SELECT * FROM line_periods WHERE period=?').all(period.id),recordedSince=store.get('line-metering-started');
 const profiles=streams.map(stream=>{
  const total=records.find(record=>record.stream===stream),health=store.get('collector-health.'+stream);
  const valid=fresh&&status.profiles[stream]?.active&&health?.ok&&now>=health.at&&now-health.at<=20000;
  const samples=valid?Object.values(live).map(user=>user[stream]).filter(sample=>sample&&now>=sample.at&&now-sample.at<=20000):[];
  const speed=direction=>samples.some(sample=>sample[direction]!==null)?samples.reduce((sum,sample)=>sum+(sample[direction]||0),0):null;
  return{id:stream,protocol:stream.split('.')[0],exit:stream.split('.')[1],uploadBytes:total?.up||0,downloadBytes:total?.down||0,uploadBytesPerSecond:speed('up'),downloadBytesPerSecond:speed('down'),state:fresh?(status.profiles[stream]?.active?'running':'stopped'):'unknown'};
 });
 const routes=['direct','att'].map(exit=>{
  const items=profiles.filter(profile=>profile.exit===exit),sum=key=>items.reduce((total,item)=>total+(item[key]||0),0),rate=key=>items.some(item=>item[key]!==null)?sum(key):null;
  return{id:exit,name:exit==='att'?'经ATT出口':'本机直出',uploadBytes:sum('uploadBytes'),downloadBytes:sum('downloadBytes'),uploadBytesPerSecond:rate('uploadBytesPerSecond'),downloadBytesPerSecond:rate('downloadBytesPerSecond'),state:items.some(item=>item.state==='running')?'running':items.every(item=>item.state==='stopped')?'stopped':'unknown',profiles:items};
 });
 return{period,recordedSince,observedAt:status?.at||null,fresh,routes};
}
