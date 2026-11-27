import{readSecret}from'./deployment.mjs';

export function diagnosticRedactor(store){
 const secrets=new Set([store.get('entrance')?.value]);
 const collect=value=>{
  if(typeof value==='string'&&value.length>=8)secrets.add(value);
  else if(Array.isArray(value))value.forEach(collect);
  else if(value&&typeof value==='object')Object.values(value).forEach(collect);
 };
 for(const key of['relay-config','relay-pending','network-config','wg-identity','certificate-settings','bark']){const value=readSecret(store,key);if(value)collect(value);}
 for(const row of store.db.prepare('SELECT credentials FROM users').all())collect(JSON.parse(store.unseal(row.credentials)));
 const ordered=[...secrets].filter(Boolean).sort((a,b)=>b.length-a.length);
 return value=>{
  let text=typeof value==='string'?value:JSON.stringify(value);
  for(const secret of ordered)text=text.split(secret).join('[已隐藏]');
  return text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,'[私钥已隐藏]').replace(/(?:hysteria2|hy2|vmess):\/\/[^\s"<>]+/g,'[导入链接已隐藏]').replace(/\/sub\/[A-Za-z0-9_-]{24,128}/g,'/sub/[已隐藏]').replace(/Bearer\s+[A-Za-z0-9_-]+/gi,'Bearer [已隐藏]');
 };
}
export async function diagnostics(store,request,target='all'){
 const redact=diagnosticRedactor(store),runtime=store.get('runtime'),settings=store.get('settings');
 const statuses=await request('status'),logs=await request('logs',{target});
 return{format:'vps-panel-diagnostics',version:1,at:store.clock(),serverName:settings.serverName,role:settings.role,runtime,
  services:statuses.profiles,worker:store.get('worker-health'),telemetry:store.get('host-telemetry'),
  audit:store.db.prepare('SELECT at,event,detail FROM audit ORDER BY id DESC LIMIT 100').all().map(row=>({...row,detail:redact(row.detail)})),
  logs:redact(logs.text),notes:['敏感凭证和导入链接已做脱敏；分享前仍请检查主机IP、域名及自定义日志内容。']};
}
