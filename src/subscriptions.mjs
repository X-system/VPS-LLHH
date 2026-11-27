import{digest}from'./security.mjs';
import{clientLinks}from'./core-config.mjs';
import{readSecret}from'./deployment.mjs';
import{linePermissions}from'./line-permissions.mjs';
import{linkPresentation}from'./line-catalog.mjs';

export function subscriptionAddress(origin,secret,title){
 const url=new URL('/sub/'+secret,origin);url.searchParams.set('remarks',title);url.hash=title;return url.href;
}

export function indexSubscriptions(store){
 store.transaction(()=>{
  store.db.exec('DELETE FROM subscriptions');
  for(const user of store.db.prepare('SELECT id,credentials FROM users').all()){
   const credentials=JSON.parse(store.unseal(user.credentials));
   store.db.prepare('INSERT INTO subscriptions VALUES(?,?)').run(digest(credentials.subscription),user.id);
  }
 });
}
export function subscription(store,raw){
 if(typeof raw!=='string'||!/^[A-Za-z0-9_-]{24,128}$/.test(raw))return null;
 const config=readSecret(store,'relay-config');if(!config||store.get('settings').role!=='relay')return null;
 const user=store.db.prepare('SELECT u.*,COALESCE(t.up,0) AS up,COALESCE(t.down,0) AS down FROM subscriptions s JOIN users u ON u.id=s.user_id LEFT JOIN totals t ON t.user_id=u.id WHERE s.token=?').get(digest(raw));
 if(!user||!user.enabled||user.expires!==null&&user.expires<=store.clock()||user.quota!==null&&user.up+user.down>=user.quota)return null;
 const account={...user,protocols:JSON.parse(user.protocols),exits:JSON.parse(user.exits),lines:linePermissions(store,user.id),credentials:JSON.parse(store.unseal(user.credentials))},presentation=linkPresentation(store);
 return{title:presentation.title,body:Buffer.from(clientLinks(config,account,presentation).map(link=>link.url).join('\n')).toString('base64'),userinfo:`upload=${user.up}; download=${user.down}; total=${user.quota||0}; expire=${user.expires?Math.floor(user.expires/1000):0}`};
}
