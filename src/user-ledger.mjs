import{trafficPeriod}from'./line-usage.mjs';
import{HttpError}from'./validation.mjs';

export function usageDay(now){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
export function addUserUsage(store,{userId,up,down,at}){
 const period=trafficPeriod(at).id,day=usageDay(at);
 store.db.prepare('INSERT INTO user_days VALUES(?,?,?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET up=up+excluded.up,down=down+excluded.down').run(userId,day,period,up,down);
}
export function userUsage(store,id){
 const month=trafficPeriod(store.clock()).id,day=usageDay(store.clock());
 const today=store.db.prepare('SELECT up,down FROM user_days WHERE user_id=? AND day=?').get(id,day)||{up:0,down:0};
 const current=store.db.prepare('SELECT COALESCE(SUM(up),0) AS up,COALESCE(SUM(down),0) AS down FROM user_days WHERE user_id=? AND period=?').get(id,month);
 return{today,month:{...current,period:month},recordedSince:store.get('user-metering-started')};
}
export function deletedUsage(store){
 const period=trafficPeriod(store.clock()).id,row=store.db.prepare('SELECT COALESCE(SUM(up),0) AS up,COALESCE(SUM(down),0) AS down FROM deleted_days WHERE period=?').get(period);
 return{period,up:row.up,down:row.down,visible:row.up+row.down>0};
}
export function monthlyUserUsage(store){
 const period=trafficPeriod(store.clock()).id;
 const live=store.db.prepare('SELECT COALESCE(SUM(up),0) AS up,COALESCE(SUM(down),0) AS down FROM user_days WHERE period=?').get(period),deleted=deletedUsage(store);
 return{period,up:live.up+deleted.up,down:live.down+deleted.down,recordedSince:store.get('user-metering-started')};
}
export function deleteUser(store,id){
 return store.transaction(()=>{
  if(!store.db.prepare('SELECT id FROM users WHERE id=?').get(id))throw new HttpError(404,'用户不存在');
  for(const row of store.db.prepare('SELECT * FROM user_days WHERE user_id=?').all(id))store.db.prepare('INSERT INTO deleted_days VALUES(?,?,?,?) ON CONFLICT(day) DO UPDATE SET up=up+excluded.up,down=down+excluded.down').run(row.day,row.period,row.up,row.down);
  store.db.prepare('DELETE FROM traffic WHERE user_id=?').run(id);store.db.prepare('DELETE FROM totals WHERE user_id=?').run(id);
  store.db.prepare('DELETE FROM users WHERE id=?').run(id);
  const live=store.get('live-traffic')||{};delete live[id];store.set('live-traffic',live);
  // Keep access-applied until the worker has revoked the deleted identity.
  store.audit('删除用户',{id});return{ok:true,revocation:'pending'};
 });
}
