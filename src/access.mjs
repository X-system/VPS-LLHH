import { createHash } from 'node:crypto';
import { kickHy2 } from './collectors.mjs';

export const streams=['vmess.att','vmess.direct','hy2.att','hy2.direct'];
export function permitted(user,stream,now,runtime,role='relay'){
  const[protocol,exit]=stream.split('.');
  return role==='relay'&&!runtime?.maintenance&&!runtime?.emergencyStop&&user.enabled&&
    (user.expires===null||user.expires>now)&&(user.quota===null||user.up+user.down<user.quota)&&
    user.protocols.includes(protocol)&&user.exits.includes(exit);
}
export function accessUsers(store){
  return store.db.prepare('SELECT u.*,COALESCE(t.up,0) AS up,COALESCE(t.down,0) AS down FROM users u LEFT JOIN totals t ON t.user_id=u.id').all().map(row=>({...row,enabled:!!row.enabled,protocols:JSON.parse(row.protocols),exits:JSON.parse(row.exits),credentials:JSON.parse(store.unseal(row.credentials))}));
}
function fingerprint(user,protocol){return createHash('sha256').update(user.credentials[protocol]).digest('hex');}
// Ports and process identities come from the trusted manager, never from a browser request.
export function createAccessReconciler({store,profiles,adapter,clock=store.clock}){
  let running=false;
  return async function reconcile(){
    if(running)return{busy:true};running=true;
    try{
      const users=accessUsers(store),runtime=store.get('runtime'),role=store.get('settings').role;
      const previous=store.get('access-applied')||{},results=[];
      for(const stream of streams){
        const profile=profiles[stream];if(!profile)continue;
        try{
          const status=await adapter.status(stream);
          if(!status.active){results.push({stream,status:'stopped'});continue;}
          if(!status.epoch)throw new Error('服务缺少启动周期');
          const protocol=stream.split('.')[0];
          const selected=users.filter(user=>permitted(user,stream,clock(),runtime,role));
          const desired=Object.fromEntries(selected.map(user=>[user.id,fingerprint(user,protocol)]));
          const prior=previous[stream]?.epoch===status.epoch?previous[stream].users:null;
          if(protocol==='hy2'){
            // Unknown startup state: revoke every currently unauthorized ID, including orphans.
            const known=new Set([...users.map(user=>user.id),...Object.keys(prior||{})]);
            if(!prior){for(const id of await adapter.onlineIds(stream))known.add(id);}
            const revoke=[...known].filter(id=>!desired[id]||(prior?.[id]&&prior[id]!==desired[id]));
            if(revoke.length)await(adapter.kick?adapter.kick(stream,revoke):kickHy2(profile,revoke));
          }else{
            // HandlerService removal does not reliably terminate existing TCP streams.
            // Rebuild only this TCP/exit instance for a hard revocation. Never claim per-user kick.
            if(!prior||JSON.stringify(Object.entries(prior).sort())!==JSON.stringify(Object.entries(desired).sort())){
              await adapter.replaceTcp(stream,selected);
              const after=await adapter.status(stream);
              if(!after.active&&after.state==='inactive'){results.push({stream,status:'stopped'});continue;}
              if(!after.active||!after.epoch)throw new Error('TCP服务尚未恢复');
              status.epoch=after.epoch;
            }
          }
          previous[stream]={epoch:status.epoch,users:desired,at:clock()};
          store.set('access-applied',previous);
          results.push({stream,status:'applied',users:selected.length});
        }catch{
          // A failed revoke must not leave unauthorized streams running.
          let stopped=false;try{await adapter.stop(stream);stopped=true;}catch{}
          results.push({stream,status:stopped?'failed-closed':'stop-unconfirmed'});
          store.audit(stopped?'用户权限同步失败，已停止受影响线路':'用户权限同步失败，未能确认线路停止',{stream});
        }
      }
      return{results};
    }finally{running=false;}
  };
}
