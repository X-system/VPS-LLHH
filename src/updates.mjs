import{readFile,mkdir}from'node:fs/promises';
import{join}from'node:path';
import{fileURLToPath}from'node:url';
import{atomicWrite}from'./system-driver.mjs';
import{parseVersion,compareVersions}from'./versions.mjs';

export function repositoryName(value){if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value)||value.split('/').some(part=>part==='..'||part.endsWith('.git')))throw new Error('仓库格式应为GitHub用户名/仓库名');return value;}
export function releaseAsset(repository,release,{allowTest=false,role='relay'}={}){
 repositoryName(repository);if(!['relay','exit'].includes(role))throw new Error('安装角色错误');
 const prefix=role+'-v',version=release?.tag_name?.startsWith(prefix)?release.tag_name.slice(prefix.length):null,parsed=parseVersion(version);
 if(!release||release.draft||!parsed||!Array.isArray(release.assets)||!!release.prerelease!==(parsed.test!==null)||parsed.test!==null&&!allowTest||release.body?.includes('<!-- llhh:installer -->'))throw new Error('没有可用的发布版本');
 const name='vps-panel-v'+version+'.tar.gz',asset=release.assets.find(item=>item.name===name);
 if(!asset||!Number.isInteger(asset.size)||asset.size<=0||asset.size>20*1024*1024||!/^sha256:[a-f0-9]{64}$/.test(asset.digest||''))throw new Error('发布包缺失、过大或没有GitHub SHA256校验');
 const expected=`https://github.com/${repository}/releases/download/${release.tag_name}/${name}`;
 if(asset.browser_download_url!==expected)throw new Error('发布包地址与配置仓库不一致');
 return{version,role,url:expected,sha256:asset.digest.slice(7),size:asset.size};
}
export function newerVersion(candidate,current){return!!parseVersion(candidate)&&!!parseVersion(current)&&compareVersions(candidate,current)>0;}
export function createUpdateManager({directory='/etc/vps-panel',coreDirectory='/usr/local/lib/vps-panel',fetchImpl=fetch,schedule,getRole=async()=> 'relay'}={}){
 async function repository(){try{return repositoryName((await readFile(join(directory,'repository'),'utf8')).trim());}catch(error){if(error.code==='ENOENT')return null;throw error;}}
 async function version(){return JSON.parse(await readFile(fileURLToPath(new URL('../package.json',import.meta.url)),'utf8')).version;}
 async function latest(repo){
  const allowTest=parseVersion(await version())?.test!=null,role=await getRole(),found=[];
  if(!['relay','exit'].includes(role))throw new Error('安装角色错误');
  for(let page=1;page<=10;page++){
   const response=await fetchImpl('https://api.github.com/repos/'+repositoryName(repo)+'/releases?per_page=100&page='+page,{headers:{Accept:'application/vnd.github+json','User-Agent':'vps-panel-updater','X-GitHub-Api-Version':'2026-03-10'},redirect:'error',signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw new Error('未能读取发布列表，请检查仓库与GitHub限制');const releases=await response.json();if(!Array.isArray(releases))throw new Error('发布列表格式错误');
   for(const release of releases)try{found.push(releaseAsset(repo,release,{allowTest,role}));}catch{}
   if(releases.length<100)break;
  }
  if(!found.length)throw new Error(allowTest?'尚无可用版本':'尚无正式版本，正式安装不会自动切到测试版');
  return found.sort((a,b)=>compareVersions(b.version,a.version))[0];
 }
 async function status({check=false}={}){
  const repo=await repository(),current=await version();let job=null;
  try{job=JSON.parse(await readFile(join(directory,'update-state.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  let available=null;if(check&&repo)available=await latest(repo);
  return{repository:repo,currentVersion:current,job,available,hasUpdate:!!available&&newerVersion(available.version,current)};
 }
 return{
  status,
  async configure(input){const repo=repositoryName(input.repository);await latest(repo);await atomicWrite(join(directory,'repository'),repo+'\n');return status();},
  async start(input){
   if(input.confirmed!==true)throw new Error('更新会停止线路，请先确认');
   const repo=await repository();if(!repo)throw new Error('尚未配置发布仓库');
   const asset=await latest(repo);if(!newerVersion(asset.version,await version()))throw new Error('当前已经是最新可用版本');
   await atomicWrite(join(directory,'update-request.json'),JSON.stringify({...asset,repository:repo}));
   await atomicWrite(join(directory,'update-state.json'),JSON.stringify({step:'queued',version:asset.version,at:Date.now()}));
   await schedule(join(coreDirectory,'app/src/update-runner.mjs'),'--update');return{accepted:true,version:asset.version};
  },
  async rollback(input){
   if(input.confirmed!==true)throw new Error('回滚会恢复升级前的配置与统计，请确认');
   await readFile('/var/cache/vps-panel-updates/previous/panel.sqlite');
   await schedule(join(coreDirectory,'app/src/update-runner.mjs'),'--rollback');return{accepted:true};
  }
 };
}
