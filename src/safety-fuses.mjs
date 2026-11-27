import{readFileSync,writeFileSync,renameSync,unlinkSync}from'node:fs';
import{join}from'node:path';
import{randomBytes}from'node:crypto';

const names=new Set(['emergency','network','automation','vmess.att','vmess.direct','hy2.att','hy2.direct']);
function pathFor(directory,name){if(!names.has(name))throw new Error('安全锁标识错误');return join(directory,'stop-'+name+'.fuse');}
export function readFuse(directory,name){try{return readFileSync(pathFor(directory,name),'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}}
export function tripped(directory,name){return readFuse(directory,name)!==null;}
export function tripFuse(directory,name){
 const path=pathFor(directory,name),id=randomBytes(24).toString('hex'),temporary=path+'.'+id+'.tmp';
 try{writeFileSync(temporary,id,{mode:0o600,flag:'wx'});renameSync(temporary,path);}finally{try{unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
 return id;
}
export function clearFuse(directory,name,observed){if(readFuse(directory,name)!==observed)return false;if(observed!==null)unlinkSync(pathFor(directory,name));return true;}
