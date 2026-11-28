import{readFile,lstat,realpath,unlink,readdir,rm}from'node:fs/promises';
import{resolve,dirname,join}from'node:path';
import{createHash}from'node:crypto';
import{atomicWrite}from'./system-driver.mjs';
const digest=data=>createHash('sha256').update(data).digest('hex');
const ledger='/etc/vps-panel/install-artifacts.json';
export async function registerInstallerArtifact(path,{ledgerPath=ledger,parents=['/tmp','/var/tmp']}={}){
 const full=resolve(path);if(!parents.includes(dirname(full)))return false;
 const stat=await lstat(full);if(!stat.isFile()||stat.isSymbolicLink()||await realpath(full)!==full)return false;
 const raw=await readFile(full);if(!raw.includes(Buffer.from('LLHH 安装向导')))return false;
 let files=[];try{files=JSON.parse(await readFile(ledgerPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 files=files.filter(item=>item.path!==full);files.push({path:full,sha256:digest(raw)});await atomicWrite(ledgerPath,JSON.stringify(files));return true;
}
export async function removeInstallerArtifacts({ledgerPath=ledger,parents=['/tmp','/var/tmp']}={}){
 let files=[];try{files=JSON.parse(await readFile(ledgerPath,'utf8'));}catch(e){if(e.code==='ENOENT')return;throw e;}
 for(const file of files){if(typeof file.path!=='string'||!parents.includes(dirname(file.path))||resolve(file.path)!==file.path)continue;
  try{const stat=await lstat(file.path);if(stat.isFile()&&!stat.isSymbolicLink()&&digest(await readFile(file.path))===file.sha256)await unlink(file.path);}catch(e){if(e.code!=='ENOENT')throw e;}
 }
}
export async function removeProgramResidues(){
 // Exact program-owned namespaces; never remove packages, shared logs or caches.
 for(const path of['/var/cache/vps-panel-updates','/var/cache/vps-panel','/var/log/vps-panel','/run/vps-panel',...['vmess-att','vmess-direct','hy2-att','hy2-direct'].map(s=>'/run/vps-panel-core-'+s)]){
  try{const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(path)!==path)throw Error('残留目录身份不正确，拒绝删除：'+path);await rm(path,{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 for(const name of await readdir('/var/tmp')){
  if(!/^vps-panel-(install|bootstrap)\.[A-Za-z0-9]{8}$/.test(name))continue;
  const path=join('/var/tmp',name);const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==0)continue;
  let owned=false;for(const sub of['app/package.json','source/package.json'])try{if(JSON.parse(await readFile(join(path,sub),'utf8')).name==='vps-panel')owned=true;}catch{}
  if(owned)await rm(path,{recursive:true});
 }
}
