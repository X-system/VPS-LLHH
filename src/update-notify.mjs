import{openStore}from'./store.mjs';
import{emitUpdateNotice}from'./update-notices.mjs';
import{dispatchEvents}from'./bark.mjs';
const store=await openStore({directory:'/var/lib/vps-panel'});
try{const[phase,key,version]=process.argv.slice(2),eventId=emitUpdateNotice(store,phase,key,{version});if(eventId)await dispatchEvents(store,{eventId,max:1});}finally{store.close();}
