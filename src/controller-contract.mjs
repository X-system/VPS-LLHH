import{lineUsage}from'./line-usage.mjs';

// Internal/read-only contract. Machine authentication and remote writes are deliberately absent.
export function nodeCapabilities(store){
 return{contractVersion:1,nodeId:store.get('identity'),serverName:store.get('settings').serverName,role:store.get('settings').role,
  management:{mode:'standalone',controllerImplemented:false},protocols:['vmess','hy2'],exits:['direct','att'],
  telemetry:{lineUsage:true,userUsage:true,lastOnline:true,speedUnit:'bytes/second',trafficUnit:'bytes'},
  remoteConfiguration:false};
}
export function nodeSnapshot(store){
 return{...nodeCapabilities(store),generatedAt:store.clock(),lineUsage:lineUsage(store),workerHealth:store.get('worker-health')||null};
}
