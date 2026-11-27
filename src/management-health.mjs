import https from'node:https';
import tls from'node:tls';
import{readFile}from'node:fs/promises';
import{DatabaseSync}from'node:sqlite';

export async function managementHealth({attempts=15}={}){
 const entries=(await readFile('/etc/vps-panel/web.env','utf8')).split('\n').filter(line=>/^[A-Z_]+=/.test(line)).map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];});
 const env=Object.fromEntries(entries),origin=new URL(env.VPS_ORIGIN),ca=[...tls.rootCertificates,await readFile('/etc/vps-panel/certs/panel-fullchain.pem','utf8')];
 const db=new DatabaseSync('/var/lib/vps-panel/panel.sqlite',{readOnly:true});let entrance;
 try{entrance=JSON.parse(db.prepare("SELECT value FROM config WHERE key='entrance'").get().value).value;}finally{db.close();}
 for(let attempt=0;attempt<attempts;attempt++){
  try{
   const value=await new Promise((resolve,reject)=>{
    const request=https.get({hostname:'127.0.0.1',port:Number(env.VPS_PORT),path:`/${entrance}/api/meta`,headers:{Host:origin.host},ca,checkServerIdentity:(_,cert)=>tls.checkServerIdentity(origin.hostname,cert),timeout:2000},response=>{
     let body='';response.on('data',chunk=>{body+=chunk;if(body.length>65536)response.destroy(new Error('响应过大'));});response.on('error',reject);
     response.on('end',()=>{try{if(response.statusCode!==200)throw new Error();resolve(JSON.parse(body));}catch{reject(new Error('管理服务启动检查失败'));}});
    });request.on('error',reject);request.on('timeout',()=>request.destroy(new Error('管理服务启动超时')));
   });if(value.serverName&&['relay','exit'].includes(value.role))return true;
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 throw new Error('管理服务HTTPS自检未通过');
}
