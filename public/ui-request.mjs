// Retry read-only requests only. A dropped write may already have taken effect.
export async function fetchPanel(url,{method='GET',data,csrf,fetchImpl=fetch,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 for(let attempt=0;;attempt++){
  const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),method==='GET'?15000:75000);
  try{return await fetchImpl(url,{method,signal:controller.signal,credentials:'same-origin',headers:{...(data?{'Content-Type':'application/json'}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},body:data?JSON.stringify(data):undefined});}
  catch(cause){
   if(method==='GET'&&attempt<2){await wait(attempt===0?350:900);continue;}
   const error=new Error(controller.signal.aborted?'响应时间较长，请先确认当前进度，避免重复提交。':'连接暂时中断，请稍候确认当前进度。');error.network=true;throw error;
  }finally{clearTimeout(deadline);}
 }
}
