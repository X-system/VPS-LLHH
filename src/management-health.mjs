import https from'node:https';
import tls from'node:tls';
import{readFile}from'node:fs/promises';
import{DatabaseSync}from'node:sqlite';

// Startup can be slow on small machines. Reuse the verified TLS connection and
// bound the whole check, rather than repeatedly forcing a two-second handshake.
export async function probeManagement({origin,port,ca,entrance,attempts=15,requestTimeout=15000,totalTimeout=180000,retryDelay=1000}={}){
 const target=new URL(origin);
 if(target.protocol!=='https:'||target.origin!==origin||!/^[A-Za-z0-9_~-]{20}$/.test(entrance)||
 !Number.isInteger(attempts)||attempts<1||attempts>120||!Number.isInteger(requestTimeout)||requestTimeout<10||requestTimeout>60000||
 !Number.isInteger(totalTimeout)||totalTimeout<10||totalTimeout>600000||!Number.isInteger(retryDelay)||retryDelay<0||retryDelay>10000)throw new Error('管理服务检查参数错误');
 const listenPort=port??Number(target.port||443);if(!Number.isInteger(listenPort)||listenPort<1||listenPort>65535)throw new Error('管理端口错误');
 const deadline=performance.now()+totalTimeout,checkIdentity=(_,cert)=>tls.checkServerIdentity(target.hostname,cert),agent=new https.Agent({keepAlive:true,maxSockets:1,ca,checkServerIdentity:checkIdentity});
 function request(path){
  const budget=Math.max(1,Math.floor(Math.min(requestTimeout,deadline-performance.now())));
  return new Promise((resolve,reject)=>{
   const req=https.get({hostname:'127.0.0.1',port:listenPort,path,headers:{Host:target.host},agent,
    ...(target.hostname.match(/^[0-9.]+$/)?{}:{servername:target.hostname}),
    },res=>{
    let body='';res.on('data',chunk=>{body+=chunk;if(Buffer.byteLength(body)>65536)res.destroy(new Error('响应过大'));});res.on('error',reject);
    res.on('end',()=>resolve({status:res.statusCode,body}));
   });
   const timer=setTimeout(()=>req.destroy(new Error('管理服务启动检查超时')),budget);req.on('error',reject);req.on('close',()=>clearTimeout(timer));
  });
 }
 try{
  for(let attempt=0;attempt<attempts&&performance.now()<deadline;attempt++){
   try{
    const response=await request(`/${entrance}/api/meta`),value=response.status===200?JSON.parse(response.body):null;
    if(typeof value?.serverName==='string'&&value.serverName.trim()&&['relay','exit'].includes(value.role)&&performance.now()<deadline){
     const root=await request('/');if(root.status===404&&performance.now()<=deadline)return true;
    }
   }catch{}
   const remaining=deadline-performance.now();if(attempt+1<attempts&&remaining>0)await new Promise(resolve=>setTimeout(resolve,Math.min(retryDelay,remaining)));
  }
 }finally{agent.destroy();}
 throw new Error('管理服务HTTPS自检未通过');
}
export async function managementHealth({attempts=15,requestTimeout=15000,totalTimeout=180000}={}){
 const entries=(await readFile('/etc/vps-panel/web.env','utf8')).split('\n').filter(line=>/^[A-Z_]+=/.test(line)).map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];});
 const env=Object.fromEntries(entries),ca=[...tls.rootCertificates,await readFile('/etc/vps-panel/certs/panel-fullchain.pem','utf8')];
 const db=new DatabaseSync('/var/lib/vps-panel/panel.sqlite',{readOnly:true});let entrance;
 try{entrance=JSON.parse(db.prepare("SELECT value FROM config WHERE key='entrance'").get().value).value;}finally{db.close();}
 return probeManagement({origin:env.VPS_ORIGIN,port:Number(env.VPS_PORT),ca,entrance,attempts,requestTimeout,totalTimeout});
}
