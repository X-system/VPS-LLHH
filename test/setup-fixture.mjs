export function setupDriver({onConfigure,publicIPv4='11.0.0.2',role='relay'}={}){
 const ids=['vmess.att','vmess.direct','hy2.att','hy2.direct'],calls=[];
 let acceleration='off';
 let relay=null,automation=null,certificate={},desired={},configuredNetwork=null,networkUp=false;
 const profiles=Object.fromEntries(ids.map(id=>[id,{active:false,state:'inactive',epoch:'test-'+id}]));
 const info=()=>({publicIPv4,physicalInterface:'eth0',panelPort:18443,controlUid:999,uids:{'vmess.att':900,'vmess.direct':901,'hy2.att':902,'hy2.direct':903},stopTokens:{automation}});
 const ports={vmess:{att:18001,direct:18002},hy2:{att:443,direct:8443}};
 async function request(action,data={}){
  calls.push({action,data});
  if(Object.hasOwn(data,'expectedAutomationToken')&&data.expectedAutomationToken!==automation)throw new Error('已收到新的手动停止操作');
  if(action==='tcp-acceleration-set')acceleration=data.mode;
  if(['tcp-acceleration-status','tcp-acceleration-set'].includes(action))return{mode:acceleration,effective:acceleration==='off'?'cubic':acceleration,bbrxSupported:true,job:null};
  if(action==='inspect')return info();
  if(action==='plan-relay')return{...info(),ports:relay?.ports||ports};
  if(action==='plan-network')return{listenPort:role==='exit'?51874:51820};
  if(action==='configure-relay'){relay=data.config;desired={};for(const value of Object.values(profiles)){value.active=false;value.state='inactive';}if(onConfigure)automation=onConfigure();return{configured:true};}
  if(action==='configure-network'){configuredNetwork=data.config;networkUp=false;return{configured:true};}
  if(action==='network-up'){networkUp=true;return{up:true};}
  if(action==='network-down'){networkUp=false;return{up:false};}
  if(action==='forget-network'){configuredNetwork=null;return{forgotten:true};}
  if(action==='certificate-configure'){certificate={domain:data.domain,configured:true,email:data.email,zoneId:data.zoneId};return certificate;}
  if(action==='certificate-issue'){certificate={...certificate,certificateDomain:certificate.domain,certificateStaging:false,notAfter:Date.now()+86400000};return{accepted:true};}
  if(action==='certificate-status')return certificate;
  if(action==='policy')return{ok:true};
  if(action==='release-emergency')return{emergencyStop:false};
  if(action==='start'){profiles[data.stream]={active:true,state:'active',epoch:'test-'+data.stream};desired[data.stream]=true;return profiles[data.stream];}
  if(action==='stop'){automation='manual';profiles[data.stream].active=false;profiles[data.stream].state='inactive';desired[data.stream]=false;return{active:false};}
  if(action==='stop-all'){automation='manual';for(const id of ids){profiles[id].active=false;profiles[id].state='inactive';desired[id]=false;}return{stopped:true};}
  if(action==='status')return{profiles:structuredClone(profiles),desired:{...desired},guardPresent:!!relay,network:{configured:!!configuredNetwork,up:networkUp,protected:networkUp,peers:[]},certificate};
  throw new Error('Unsupported isolated setup operation: '+action);
 }
 return{request,calls,stop:()=>{automation='manual';},state:()=>({relay,desired,profiles,certificate})};
}
