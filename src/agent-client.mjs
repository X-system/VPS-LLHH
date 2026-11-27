import http from'node:http';

export function agentRequest(action,data={},options={}){
 const socketPath=options.socketPath||'/run/vps-panel/agent.sock';
 return new Promise((resolve,reject)=>{
  const payload=JSON.stringify({action,data});
  const request=http.request({socketPath,path:'/',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},response=>{
   let size=0;const parts=[];response.on('data',chunk=>{size+=chunk.length;if(size>4*1024*1024)response.destroy(new Error('系统管理器响应过大'));else parts.push(chunk);});
   response.on('error',reject);response.on('end',()=>{try{const result=JSON.parse(Buffer.concat(parts));if(response.statusCode!==200){const error=new Error(result.error||'系统操作未完成');error.code='AGENT_ERROR';error.statusCode=response.statusCode;reject(error);}else resolve(result);}catch(error){reject(error);}});
  });
  request.setTimeout(options.timeout||60000,()=>request.destroy(new Error('系统管理器响应超时')));request.on('error',reject);request.end(payload);
 });
}

// Root mutations are serialized. A short overlap with tunnel repair must not be
// mistaken for a failed access revocation. Retries stay bounded; the caller
// still stops the affected line if the operation cannot complete.
export async function retryAgentBusy(operation,{attempts=11,delay=500}={}){
 for(let attempt=0;;attempt++){
  try{return await operation();}catch(error){
   if(error.code!=='AGENT_ERROR'||error.statusCode!==409||attempt+1>=attempts)throw error;
   await new Promise(resolve=>setTimeout(resolve,delay));
  }
 }
}
