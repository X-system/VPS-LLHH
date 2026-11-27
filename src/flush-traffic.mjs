import{openStore}from'./store.mjs';
import{readSecret}from'./deployment.mjs';
import{agentRequest}from'./agent-client.mjs';
import{readHy2,readXray,ingestSnapshot}from'./collectors.mjs';
import{streams}from'./access.mjs';

const store=await openStore({directory:'/var/lib/vps-panel'});
try{
 const config=readSecret(store,'relay-config');
 if(config){
  const{profiles}=await agentRequest('status');
  for(const stream of streams)if(profiles[stream]?.active){
   const samples=await(stream.startsWith('hy2')?readHy2(config.stats[stream]):readXray(config.stats[stream]));
   ingestSnapshot(store,{stream,epoch:profiles[stream].epoch,samples});
  }
 }
 store.set('runtime',{maintenance:true,emergencyStop:true});
 store.audit('升级维护前保存流量并进入急停');
}finally{store.close();}
