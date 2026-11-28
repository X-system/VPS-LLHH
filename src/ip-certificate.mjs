import http from'node:http';
import{isIP}from'node:net';
import{readFile,mkdir,copyFile,symlink,rename,unlink}from'node:fs/promises';
import{join}from'node:path';
import{X509Certificate,createPrivateKey,randomBytes}from'node:crypto';
import{atomicWrite}from'./system-driver.mjs';
import{publicProbeIPv4}from'./node-health.mjs';

export function ipCertificateInfo(cert,key,ip,now=Date.now()){
 const leaf=new X509Certificate(cert),notAfter=Date.parse(leaf.validTo);
 if(!leaf.checkIP(ip)||!leaf.checkPrivateKey(createPrivateKey(key))||Date.parse(leaf.validFrom)>now+300000||notAfter<=now+86400000)throw Error('IP证书地址、私钥或有效期检查失败');
 return{ip,notAfter,fingerprint:leaf.fingerprint256};
}
export async function issueIpCertificate({ip,directory='/etc/vps-panel/certs/ip',acmeLoader=()=>import('acme-client'),port=80,firewall,clock=Date.now}={}){
 if(isIP(ip)!==4||!publicProbeIPv4(ip))throw Error('IP证书需要本机公网IPv4地址');
 await mkdir(directory,{recursive:true,mode:0o700});
 try{const info=ipCertificateInfo(await readFile(join(directory,'fullchain.pem')),await readFile(join(directory,'privkey.pem')),ip,clock());if(info.notAfter-clock()>72*3600000)return info;}catch{}
 const tokens=new Map();
 const server=http.createServer((req,res)=>{const token=req.url?.match(/^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]{16,256})$/)?.[1],value=token&&tokens.get(token);res.writeHead(req.method==='GET'&&value?200:404,{'Content-Type':'text/plain','Connection':'close','Cache-Control':'no-store'});res.end(req.method==='GET'&&value?value:'Not found');});
 let listening=false;
 try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',()=>{listening=true;resolve();});});
  await firewall?.allowPort(port,'tcp','vps-panel-ip-certificate');
  const imported=await acmeLoader(),acme=imported.default||imported;
  let accountKey;try{accountKey=await readFile(join(directory,'account.key'));}catch(e){if(e.code!=='ENOENT')throw e;accountKey=await acme.crypto.createPrivateKey();await atomicWrite(join(directory,'account.key'),accountKey);}
  const client=new acme.Client({directoryUrl:acme.directory.letsencrypt.production,accountKey,backoffAttempts:15,backoffMin:2000,backoffMax:10000});
  await client.createAccount({termsOfServiceAgreed:true});
  const[key,csr]=await acme.crypto.createCsr({altNames:[ip]});
  const order=await client.createOrder({identifiers:[{type:'ip',value:ip}],profile:'shortlived'});
  for(const auth of await client.getAuthorizations(order)){
   if(auth.status==='valid')continue;
   if(auth.identifier.type!=='ip'||auth.identifier.value!==ip)throw Error('IP证书验证地址不匹配');
   const challenge=auth.challenges.find(c=>c.type==='http-01');if(!challenge)throw Error('签发机构未提供IP验证方式');
   tokens.set(challenge.token,await client.getChallengeKeyAuthorization(challenge));
   try{await client.completeChallenge(challenge);await client.waitForValidStatus(challenge);}finally{tokens.delete(challenge.token);}
  }
  const cert=await client.getCertificate(await client.finalizeOrder(order,csr)),info=ipCertificateInfo(cert,key,ip,clock());
  await atomicWrite(join(directory,'privkey.pem'),key);await atomicWrite(join(directory,'fullchain.pem'),cert);await atomicWrite(join(directory,'status.json'),JSON.stringify({...info,issuedAt:clock()}));return info;
 }catch(e){if(e.code==='EADDRINUSE')throw Error('IP证书验证需要TCP 80端口，但该端口已被占用；未关闭其他服务');throw Error('受信任IP证书申请失败，请确认服务商放行TCP 80、服务器可访问签发机构，并检查系统时间。原因：'+String(e.message).slice(0,500));}
 finally{tokens.clear();if(listening)await new Promise(resolve=>server.close(resolve));await firewall?.removeOwned(['vps-panel-ip-certificate']);}
}
export async function installIpMaterial({ip,directory='/etc/vps-panel/certs',now=Date.now()}={}){
 const source=join(directory,'ip'),cert=await readFile(join(source,'fullchain.pem')),key=await readFile(join(source,'privkey.pem'));const info=ipCertificateInfo(cert,key,ip,now);
 const generation='ip-live-'+randomBytes(10).toString('hex'),next=join(directory,generation);await mkdir(next,{mode:0o700});await atomicWrite(join(next,'fullchain.pem'),cert);await atomicWrite(join(next,'privkey.pem'),key);
 const link=join(directory,'ip-active.next');await unlink(link).catch(e=>{if(e.code!=='ENOENT')throw e;});await symlink(generation,link);await rename(link,join(directory,'ip-active'));
 for(const[name,target]of[['panel-fullchain.pem','fullchain.pem'],['panel-privkey.pem','privkey.pem']]){const file=join(directory,name),temporary=file+'.'+randomBytes(8).toString('hex');await symlink('ip-active/'+target,temporary);await rename(temporary,file);}

 // The original IP identity must keep renewing after a domain is added.
 await mkdir(join(directory,'panel-initial'),{recursive:true,mode:0o700});for(const name of['fullchain','privkey'])await copyFile(join(source,name+'.pem'),join(directory,'panel-initial','panel-'+name+'.pem'));
 return info;
}
