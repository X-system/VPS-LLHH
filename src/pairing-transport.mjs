import https from'node:https';
import{lookup}from'node:dns/promises';
import{createHash,timingSafeEqual}from'node:crypto';
import{publicProbeIPv4}from'./node-health.mjs';
import{HttpError}from'./validation.mjs';

export const pairingPath='/node-link/att';
export function decodeInvite(raw){
 try{
  if(typeof raw!=='string'||raw.length>4096||!/^ATT1\.[A-Za-z0-9_-]+$/.test(raw.trim()))throw new Error();
  const data=JSON.parse(Buffer.from(raw.trim().slice(5),'base64url'));
  const url=new URL(data.url);if(url.protocol!=='https:'||url.username||url.password||url.pathname!==pairingPath||url.search||url.hash||!/^[a-f0-9]{64}$/.test(data.fingerprint)||!/^[A-Za-z0-9_-]{32,128}$/.test(data.token))throw new Error();
  return{url:url.href,fingerprint:data.fingerprint,token:data.token};
 }catch{throw new HttpError(400,'这不是有效的ATT连接密钥，请复制中转端生成的完整密钥');}
}
export async function pairingRequest(target,payload,{allowLocal=false,resolve=lookup}={}){
 const url=new URL(target.url);if(url.protocol!=='https:'||url.pathname!==pairingPath||url.username||url.password||url.search||url.hash)throw new HttpError(400,'配对地址错误');
 const addresses=await resolve(url.hostname,{family:4,all:true}),address=addresses.find(row=>publicProbeIPv4(row.address)||allowLocal&&row.address==='127.0.0.1')?.address;
 if(!address)throw new HttpError(400,'配对地址必须指向公网IPv4');
 const body=Buffer.from(JSON.stringify(payload));if(body.length>16384)throw new HttpError(400,'配对请求过大');
 return new Promise((resolve,reject)=>{
  let done=false;const fail=()=>{if(done)return;done=true;reject(new HttpError(502,'无法完成ATT通信，请检查两台面板能否互相访问，或重新生成连接密钥'));};
  const request=https.request(url,{method:'POST',agent:false,family:4,autoSelectFamily:false,rejectUnauthorized:false,lookup:(_host,_options,callback)=>callback(null,address,4),headers:{'Content-Type':'application/json','Content-Length':body.length,Authorization:'Bearer '+target.token}},response=>{
   let size=0;const chunks=[];response.on('data',chunk=>{size+=chunk.length;if(size>16384){response.destroy();fail();}else chunks.push(chunk);});response.on('error',fail);response.on('end',()=>{if(done)return;try{const data=JSON.parse(Buffer.concat(chunks));if(response.statusCode!==200){if(response.statusCode===409&&typeof data.error==='string'&&/^已有名为.{1,48}的中转机，请更换命名$/.test(data.error)){done=true;reject(new HttpError(409,data.error));return;}return fail();}done=true;resolve(data);}catch{fail();}});
  });
  // Do not send the bearer token until the actual peer certificate has been pinned.
  request.on('socket',socket=>socket.once('secureConnect',()=>{
   const cert=socket.getPeerCertificate().raw;if(!cert)return request.destroy(new Error('peer certificate missing'));
   const actual=createHash('sha256').update(cert).digest(),expected=Buffer.from(target.fingerprint,'hex');
   if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return request.destroy(new Error('peer certificate changed'));
   request.end(body);
  }));
  request.setTimeout(15000,()=>request.destroy());request.on('error',fail);
 });
}
