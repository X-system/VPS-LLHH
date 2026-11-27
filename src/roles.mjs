import{HttpError}from'./validation.mjs';
import{storedUsers,restoreLineRows,ledgerSnapshot,restoreLedger}from'./user-storage.mjs';

const keys=['relay-config','relay-pending','network-config','auth-services','subscription-settings','att-binding'];
export async function switchRole(store,input,request){
 if(!input||!['relay','exit'].includes(input.role)||input.confirmed!==true)throw new HttpError(409,'请先确认角色切换会停止当前服务');
 const current=store.get('settings');if(current.role===input.role)return{role:current.role,changed:false};
 store.set('runtime',{...store.get('runtime'),maintenance:true,emergencyStop:true});
 await request('switch-role',{role:input.role,confirmed:true});
 const archives=store.get('role-archives')?JSON.parse(store.unseal(store.get('role-archives'))):{};
 const snapshot={users:storedUsers(store),...ledgerSnapshot(store),totals:store.db.prepare('SELECT * FROM totals').all(),traffic:store.db.prepare('SELECT * FROM traffic').all(),presence:store.db.prepare('SELECT * FROM user_presence').all(),config:Object.fromEntries(keys.map(key=>[key,store.get(key)??null]))};
 archives[current.role]=snapshot;const target=archives[input.role];
 store.transaction(()=>{
  store.db.exec('DELETE FROM users; DELETE FROM totals; DELETE FROM traffic;');
  for(const key of keys)store.set(key,target?.config?.[key]??null);
  for(const key of['att-invitation','att-pending','att-outgoing'])store.set(key,null);
  restoreLedger(store,{});
  if(target){
   for(const row of target.users)store.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)').run(row.id,row.name,row.enabled,row.protocols,row.exits,row.quota,row.expires,row.credentials,row.created);
   restoreLineRows(store,target.users);restoreLedger(store,target);
   for(const row of target.totals)store.db.prepare('INSERT INTO totals VALUES(?,?,?,?)').run(row.user_id,row.up,row.down,row.last_activity);
   for(const row of target.traffic)store.db.prepare('INSERT INTO traffic VALUES(?,?,?,?,?,?)').run(row.user_id,row.stream,row.epoch,row.up,row.down,row.at);
   for(const row of target.presence||[])store.db.prepare('INSERT INTO user_presence VALUES(?,?)').run(row.user_id,row.seen);
  }
  store.set('settings',{...current,role:input.role});store.set('role-archives',store.seal(JSON.stringify(archives)));
  for(const key of['access-applied','live-traffic','service-status'])store.set(key,null);
  store.audit('受控切换服务器角色',{from:current.role,to:input.role});
 });
 return{role:input.role,changed:true,maintenance:true,emergencyStop:true,started:false};
}
