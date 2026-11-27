import http from'node:http';
import{chmod,mkdir,lstat}from'node:fs/promises';
import{resolve}from'node:path';
import{fileURLToPath}from'node:url';
import{createSystemDriver}from'./system-driver.mjs';

export function createAgent({driver}){
 let busy=false,urgent=0,readers=0,pending=0;
 const server=http.createServer(async(req,res)=>{
  const answer=(status,value)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(req.method!=='POST'||req.url!=='/')return answer(404,{error:'Not found'});
  if(pending>=12)return answer(429,{error:'系统请求较多，请稍后重试'});pending++;
  try{
   let size=0;const chunks=[];
   for await(const chunk of req){size+=chunk.length;if(size>8*1024*1024)return answer(413,{error:'请求过大'});chunks.push(chunk);}
   const payload=JSON.parse(Buffer.concat(chunks));
   if(typeof payload.action!=='string'||!/^[a-z-]{1,40}$/.test(payload.action)||!payload.data||typeof payload.data!=='object'||Array.isArray(payload.data))return answer(400,{error:'系统请求格式错误'});
   const emergency=['stop','stop-all','network-down','emergency-stop'].includes(payload.action);
   const readonly=['status','inspect','logs','certificate-status','panel-status'].includes(payload.action)||payload.action==='update-status'&&payload.data.check!==true;
   if(!emergency&&!readonly&&(busy||urgent))return answer(409,{error:'系统正在执行上一项操作，请稍后重试'});
   if(readonly&&readers>=4)return answer(429,{error:'状态请求较多，请稍后重试'});
   if(emergency)urgent++;else if(readonly)readers++;else busy=true;
   try{answer(200,await driver.action(payload.action,payload.data));}finally{if(emergency)urgent--;else if(readonly)readers--;else busy=false;}
  }catch(error){
   const safe=!error.code&&typeof error.message==='string'&&error.message.length<=200&&!/[\r\n]/.test(error.message)&&/[\u4e00-\u9fff]/.test(error.message)?error.message:'系统操作未完成，请查看本机管理器日志';
   console.error(JSON.stringify({event:'系统操作失败',operation:typeof error.operation==='string'&&/^[A-Za-z0-9_.-]{1,64}$/.test(error.operation)?error.operation:null,code:typeof error.code==='number'||typeof error.code==='string'&&/^[A-Z_]{1,32}$/.test(error.code)?error.code:null,message:safe}));
   answer(500,{error:safe});
  }finally{pending--;}
 });
 server.requestTimeout=10000;server.headersTimeout=5000;
 return{server,close:()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.platform!=='linux'||process.getuid()!==0)throw new Error('系统管理器必须在Linux中由root服务启动');
 const socket='/run/vps-panel/agent.sock';
 await mkdir('/run/vps-panel',{recursive:true,mode:0o750});
 try{await lstat(socket);throw new Error('管理器套接字已存在，请通过systemd重启，避免覆盖其他进程');}catch(error){if(error.code!=='ENOENT')throw error;}
 const driver=createSystemDriver(),agent=createAgent({driver});
 const timer=setInterval(()=>driver.renewCertificates().catch(()=>{}),3600000);timer.unref();
 agent.server.listen(socket,async()=>{await chmod(socket,0o660);console.log('本机系统管理器已启动');driver.renewCertificates().catch(()=>{});});
 for(const signal of['SIGINT','SIGTERM'])process.once(signal,()=>agent.close().then(()=>process.exit(0)));
}
