import{readFile,mkdir,copyFile,symlink,rename,unlink}from'node:fs/promises';
import{join}from'node:path';
import{randomBytes}from'node:crypto';
import{port}from'./core-config.mjs';
import{probeBindings}from'./bindings.mjs';
import{atomicWrite}from'./system-driver.mjs';
import{resolve4}from'node:dns/promises';
import{isIP}from'node:net';
import{networkInterfaces}from'node:os';

export function parseWebEnvironment(text){return Object.fromEntries(text.split('\n').filter(line=>/^[A-Z_]+=/.test(line)).map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];}));}
export function createPanelNetwork({directory='/etc/vps-panel',getState,saveState,certificates,schedule,firewall,resolveDomain=resolve4,interfaces=networkInterfaces,begin=async()=>{},release=async()=>{}}){
 async function status(){
  const env=parseWebEnvironment(await readFile(join(directory,'web.env'),'utf8')),state=await getState(),cert=await certificates.status();
  return{port:Number(env.VPS_PORT),origin:env.VPS_ORIGIN,allowedOrigins:env.VPS_ALLOWED_ORIGINS?env.VPS_ALLOWED_ORIGINS.split(','):[env.VPS_ORIGIN],ipAccess:env.VPS_ALLOW_IP_ACCESS!=='0',useDomainCertificate:!!state.panelUseAcme,availableDomain:cert.certificateStaging===false?cert.certificateDomain:null};
 }
 async function configure(input){
  port(input.port);if(input.ipAccess!==undefined&&typeof input.ipAccess!=='boolean'||input.useDomainCertificate!==undefined&&typeof input.useDomainCertificate!=='boolean'||input.ipAccess===undefined&&input.useDomainCertificate===undefined)throw new Error('管理连接设置错误');
  const envFile=join(directory,'web.env'),oldText=await readFile(envFile,'utf8'),env=parseWebEnvironment(oldText),state=await getState();
  const reserved=[18444,19001,19002,19003,19004,...Object.values(state.relay?.ports||{}).flatMap(group=>Object.values(group)),state.network?.listenPort].filter(Boolean);
  if(reserved.includes(input.port))throw new Error('管理端口不能占用协议、隧道、认证或统计端口');
  const cert=await certificates.status();
  const ipAccess=input.ipAccess??(input.useDomainCertificate===false?true:env.VPS_ALLOW_IP_ACCESS!=='0'),useDomainCertificate=input.useDomainCertificate??(!ipAccess||!!state.panelUseAcme);
  if(cert.job)throw new Error('请等待证书任务完成后再修改管理连接');
  if(useDomainCertificate&&(cert.certificateStaging!==false||!cert.certificateDomain||!cert.notAfter||cert.notAfter<=Date.now()))throw new Error('请先签发有效的正式域名证书');
  if(!ipAccess){
   if(!useDomainCertificate)throw new Error('关闭IP访问前，请先配置有效的域名证书');
   let records,timer;try{records=await Promise.race([resolveDomain(cert.certificateDomain),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('DNS timeout')),5000);timer.unref?.();})]);}catch{throw new Error('域名解析检查失败，访问设置保持不变');}finally{clearTimeout(timer);}
   const initialHost=new URL(state.initialOrigin||env.VPS_ORIGIN).hostname,addresses=new Set([state.relay?.publicIPv4,...(isIP(initialHost)===4?[initialHost]:[]),...Object.values(interfaces()).flat().filter(row=>row&&!row.internal&&row.family==='IPv4').map(row=>row.address)].filter(Boolean));
   if(!Array.isArray(records)||!records.some(address=>addresses.has(address)))throw new Error('域名A记录尚未指向本机，不能关闭IP访问');
  }
  if(input.port!==Number(env.VPS_PORT))await probeBindings([{port:input.port,protocol:'tcp',host:env.VPS_HOST}]);
  const initialOrigin=state.initialOrigin||env.VPS_ORIGIN,origin=new URL(useDomainCertificate?'https://'+cert.certificateDomain:initialOrigin);origin.port=String(input.port);
  const id='panel-backup-'+randomBytes(10).toString('hex'),backup=join(directory,id);await mkdir(backup,{mode:0o700});
  await atomicWrite(join(backup,'web.env'),oldText);
  for(const name of['panel-fullchain.pem','panel-privkey.pem'])await copyFile(join(directory,'certs',name),join(backup,name));
  await atomicWrite(join(backup,'state.json'),JSON.stringify({panelUseAcme:state.panelUseAcme||false,panelIpAccess:state.panelIpAccess??true,initialOrigin:state.initialOrigin||null}));
  let acquired=false;
  try{
  await begin();acquired=true;
  if(env.VPS_HOST==='0.0.0.0'&&firewall)await firewall.allowPort(input.port,'tcp','vps-panel-web');
  const initial=join(directory,'certs','panel-initial');
  if(!state.initialOrigin){await mkdir(initial,{recursive:true,mode:0o700});for(const name of['panel-fullchain.pem','panel-privkey.pem'])await copyFile(join(directory,'certs',name),join(initial,name));}
  for(const[name,target]of[['panel-fullchain.pem','current/fullchain.pem'],['panel-privkey.pem','current/privkey.pem']]){
   const file=join(directory,'certs',name);
   if(useDomainCertificate){const next=file+'.'+randomBytes(10).toString('hex');try{await symlink(target,next);await rename(next,file);}finally{await unlink(next).catch(error=>{if(error.code!=='ENOENT')throw error;});}}
   else await atomicWrite(file,await readFile(join(initial,name)));
  }
  const initialAddress=new URL(initialOrigin);initialAddress.port=String(input.port);
  const next={...env,VPS_PORT:String(input.port),VPS_ORIGIN:origin.origin,VPS_ALLOW_IP_ACCESS:ipAccess?'1':'0',VPS_ALLOWED_ORIGINS:[...new Set([origin.origin,...(ipAccess?[initialAddress.origin]:[])])].join(',')};
  await atomicWrite(envFile,Object.entries(next).map(([key,value])=>key+'='+value).join('\n')+'\n');
  await saveState({...state,initialOrigin,panelUseAcme:useDomainCertificate,panelIpAccess:ipAccess,panelCertificateFingerprint:useDomainCertificate?cert.fingerprint:null});
  await atomicWrite(join(directory,'panel-rebind-request.json'),JSON.stringify({backup:id,origin:origin.origin}));
  await schedule();return{accepted:true,origin:origin.origin,port:input.port,ipAccess};
  }catch(error){
   if(acquired){try{await atomicWrite(envFile,oldText);for(const name of['panel-fullchain.pem','panel-privkey.pem'])await atomicWrite(join(directory,'certs',name),await readFile(join(backup,name)));await saveState(state);if(firewall)await firewall.removeOwned(['vps-panel-web'],{keepPorts:env.VPS_HOST==='0.0.0.0'?[Number(env.VPS_PORT)]:[]});}finally{await release();}}
   throw error;
  }
 }
 return{status,configure};
}
