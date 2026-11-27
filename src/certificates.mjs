import{readFile,writeFile,mkdir}from'node:fs/promises';
import{join}from'node:path';
import{randomBytes,X509Certificate,createPrivateKey,createPublicKey}from'node:crypto';
import{encrypt,decrypt}from'./security.mjs';
import{atomicWrite}from'./system-driver.mjs';
import{createDnsJournal}from'./dns-journal.mjs';

export function validateCertificateSettings(input){
 if(input&&typeof input==='object')input={...input,...Object.fromEntries(['domain','zoneId','token','email'].filter(key=>typeof input[key]==='string').map(key=>[key,['domain','zoneId'].includes(key)?input[key].trim().toLowerCase():input[key].trim()]))};
 if(!input||typeof input!=='object'||typeof input.domain!=='string'||input.domain.length>253||!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(input.domain))throw new Error('证书域名格式错误');
 if(typeof input.zoneId!=='string'||!/^[a-f0-9]{32}$/.test(input.zoneId))throw new Error('Cloudflare区域ID应为32位十六进制字符');
 if(typeof input.token!=='string'||!/^[A-Za-z0-9_-]{20,256}$/.test(input.token))throw new Error('Cloudflare API令牌格式错误');
 if(typeof input.email!=='string'||input.email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email))throw new Error('证书联系邮箱格式错误');
 if(input.termsAccepted!==true)throw new Error('必须同意证书签发机构的服务条款');
 return{domain:input.domain,zoneId:input.zoneId,token:input.token,email:input.email,termsAccepted:true,staging:input.staging===true};
}
export function createCloudflareDns({zoneId,token,fetchImpl=fetch}){
 if(!/^[a-f0-9]{32}$/.test(zoneId)||!token)throw new Error('Cloudflare配置错误');
 const endpoint=`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`;
 async function call(path,options={}){
  const response=await fetchImpl(endpoint+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(options.method==='DELETE'&&response.status===404)return null;
  const data=await response.json();if(!response.ok||!data.success)throw new Error('Cloudflare DNS操作失败，请检查区域ID与DNS编辑权限');return data.result;
 }
 return{
  check:()=>call('?per_page=1'),
  async create(name,content,marker){
   if(!/^_acme-challenge\.[a-z0-9.-]+$/.test(name)||typeof content!=='string'||content.length>256)throw new Error('DNS验证记录错误');
   if(marker!==undefined&&!/^vps-panel-acme-[a-f0-9]{32}$/.test(marker))throw new Error('DNS验证记录标记错误');
   const result=await call('',{method:'POST',body:JSON.stringify({type:'TXT',name,content,ttl:60,...(marker?{comment:marker}:{})})});
   if(!/^[a-f0-9]{32}$/.test(result.id))throw new Error('Cloudflare返回无效记录ID');return result.id;
  },
  async findOwned({name,content,marker}){
   if(!/^_acme-challenge\.[a-z0-9.-]+$/.test(name)||!/^vps-panel-acme-[a-f0-9]{32}$/.test(marker))throw new Error('DNS清理标识错误');
   const ids=[];
   for(let page=1;page<=10;page++){
    const records=await call('?type=TXT&name='+encodeURIComponent(name)+'&per_page=100&page='+page);
    if(!Array.isArray(records))throw new Error('DNS清理查询格式错误');
    for(const record of records)if(record.type==='TXT'&&record.name===name&&record.content===content&&record.comment===marker){if(!/^[a-f0-9]{32}$/.test(record.id))throw new Error('DNS记录ID错误');ids.push(record.id);}
    if(records.length<100)return ids;
   }
   throw new Error('同名DNS记录数量异常，请人工检查');
  },
  async remove(id){if(!/^[a-f0-9]{32}$/.test(id))throw new Error('DNS记录ID错误');await call('/'+id,{method:'DELETE'});}
 };
}
export function certificateInfo(pem,key,domain,now=Date.now()){
 const cert=new X509Certificate(pem);
 if(!cert.checkHost(domain,{subject:'never'}))throw new Error('证书未包含指定域名');
 const expected=createPublicKey(createPrivateKey(key)).export({format:'der',type:'spki'}),actual=cert.publicKey.export({format:'der',type:'spki'});
 if(!actual.equals(expected))throw new Error('证书与私钥不匹配');
 const notBefore=Date.parse(cert.validFrom),notAfter=Date.parse(cert.validTo);
 if(notBefore>now+300000||notAfter<=now+86400000)throw new Error('证书尚未生效或已接近过期');
 return{domain,notBefore,notAfter,fingerprint:cert.fingerprint256};
}
export function createCertificateManager({directory='/etc/vps-panel/certs',fetchImpl=fetch,acmeLoader=()=>import('acme-client'),clock=Date.now}={}){
 let job=null;
 async function master(){
  await mkdir(directory,{recursive:true,mode:0o700});const path=join(directory,'master.key');
  try{return await readFile(path);}catch(error){if(error.code!=='ENOENT')throw error;const key=randomBytes(32);await writeFile(path,key,{mode:0o600,flag:'wx'});return key;}
 }
 async function config(){
  try{return JSON.parse(decrypt(await readFile(join(directory,'settings.enc'),'utf8'),await master()));}catch(error){if(error.code==='ENOENT')return null;throw error;}
 }
 async function renewalConfig(){
  try{return JSON.parse(decrypt(await readFile(join(directory,'renewal.enc'),'utf8'),await master()));}
  catch(error){if(error.code!=='ENOENT')throw error;const current=await config();return current?.staging?null:current;}
 }
 const journal=createDnsJournal({directory,master,createDns:value=>createCloudflareDns({...value,fetchImpl})});
 async function status(){
  let info={};try{info=JSON.parse(await readFile(join(directory,'status.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const settings=await config(),renewal=await renewalConfig();return{...info,configured:!!settings,certificateDomain:info.domain||null,certificateStaging:info.staging??null,domain:settings?.domain||null,email:settings?.email||null,zoneId:settings?.zoneId||null,staging:settings?.staging||false,autoRenewDomain:renewal?.domain||null,job:job?{running:true,started:job.started}:null};
 }
 async function configure(input){
  if(job)throw new Error('证书任务进行中，请稍后修改配置');
  const prior=await config(),settings=validateCertificateSettings({...input,token:input.token||prior?.token});
  await createCloudflareDns({...settings,fetchImpl}).check();
  await journal.refresh(settings);
  await atomicWrite(join(directory,'settings.enc'),encrypt(JSON.stringify(settings),await master()));
  if(!settings.staging)await atomicWrite(join(directory,'renewal.enc'),encrypt(JSON.stringify(settings),await master()));
  return status();
 }
 async function issue(selected){
  await journal.cleanup();
  const settings=selected||await config();if(!settings)throw new Error('尚未配置证书');
  if(!settings.staging)await atomicWrite(join(directory,'renewal-state.json'),JSON.stringify({domain:settings.domain,lastAttempt:clock()}));
  const acmeModule=await acmeLoader(),acme=acmeModule.default||acmeModule;
  const dns=createCloudflareDns({...settings,fetchImpl});
  const accountPath=join(directory,settings.staging?'account-staging.pem':'account.pem');let account;
  try{account=await readFile(accountPath);}catch(error){if(error.code!=='ENOENT')throw error;account=await acme.crypto.createPrivateEcdsaKey();await atomicWrite(accountPath,account);}
  const client=new acme.Client({directoryUrl:settings.staging?acme.directory.letsencrypt.staging:acme.directory.letsencrypt.production,accountKey:account});
  const[key,csr]=await acme.crypto.createCsr({commonName:settings.domain,altNames:[settings.domain]},await acme.crypto.createPrivateEcdsaKey());
  const created=new Map();
  try{
   const certificate=await client.auto({csr,email:settings.email,termsOfServiceAgreed:true,challengePriority:['dns-01'],
    challengeCreateFn:async(authz,challenge,authorization)=>{
     if(challenge.type!=='dns-01'||authz.identifier.value!==settings.domain)throw new Error('签发机构返回了意外的域名验证');
     const record=await journal.intent(settings,'_acme-challenge.'+settings.domain,authorization);
     const id=await dns.create(record.name,authorization,record.marker);created.set(challenge.url,{id,marker:record.marker});await journal.created(record.marker,id);
    },
    challengeRemoveFn:async(authz,challenge)=>{const record=created.get(challenge.url);if(record){await dns.remove(record.id);await journal.removed(record.marker);created.delete(challenge.url);}}
   });
   const info=certificateInfo(certificate,key,settings.domain,clock());
   if(settings.staging){
    const previous=await status();delete previous.job;
    await atomicWrite(join(directory,'status.json'),JSON.stringify({...previous,domain:previous.certificateDomain,staging:previous.certificateStaging,testResult:info,lastTestAt:clock(),lastAttempt:clock(),ok:true,error:null}));
    return{...info,testOnly:true};
   }
   // Swap a whole versioned certificate directory with one atomic symlink rename.
   const version='issued-'+randomBytes(10).toString('hex');await mkdir(join(directory,version),{mode:0o700});
   await atomicWrite(join(directory,version,'fullchain.pem'),certificate);await atomicWrite(join(directory,version,'privkey.pem'),key);
   const{symlink,rename,lstat,readlink,unlink}=await import('node:fs/promises');
   const next=join(directory,'current-next-'+randomBytes(10).toString('hex'));
   try{await symlink(version,next);await rename(next,join(directory,'current'));}finally{await unlink(next).catch(error=>{if(error.code!=='ENOENT')throw error;});}
   // Unit credentials use stable paths pointing through current/.
   for(const name of['fullchain.pem','privkey.pem']){
    try{const stat=await lstat(join(directory,name));if(!stat.isSymbolicLink()||await readlink(join(directory,name))!=='current/'+name)throw new Error('证书文件路径已被其他配置占用');}catch(error){if(error.code!=='ENOENT')throw error;await symlink('current/'+name,join(directory,name));}
   }
   await atomicWrite(join(directory,'status.json'),JSON.stringify({...info,staging:settings.staging,issued:clock(),lastAttempt:clock(),ok:true}));
   return info;
  }finally{
   let cleanupFailed=false;for(const record of created.values())try{await dns.remove(record.id);await journal.removed(record.marker);}catch{cleanupFailed=true;}
   if(cleanupFailed)throw new Error('验证记录清理失败，请检查Cloudflare中的本次TXT记录');
  }
 }
 async function start({automatic=false}={}){
  if(job)return{accepted:true,running:true};
  const settings=automatic?await renewalConfig():await config();if(!settings)throw new Error('请先保存CF与证书配置');
  if(job)return{accepted:true,running:true};
  job={started:clock()};
  job.promise=issue(settings).catch(async()=>{
   const previous=await status();delete previous.job;
   await atomicWrite(join(directory,'status.json'),JSON.stringify({...previous,domain:previous.certificateDomain,staging:previous.certificateStaging,ok:false,lastAttempt:clock(),error:'证书任务失败，请检查DNS权限、解析传播及签发限制'}));
  }).finally(()=>{job=null;});
  return{accepted:true,running:true};
 }
 async function renew(){
  if(job)return;await journal.cleanup();const settings=await renewalConfig();if(!settings)return;
  let attempt=null;try{attempt=JSON.parse(await readFile(join(directory,'renewal-state.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const info=await status(),last=attempt?.domain===settings.domain?attempt.lastAttempt:null;
  if((info.certificateDomain!==settings.domain||!info.notAfter||info.notAfter-clock()<30*86400000)&&(!last||clock()-last>6*3600000))await start({automatic:true});
 }
 return{configure,status,start,renew,issue,async wait(){await job?.promise;}};
}
