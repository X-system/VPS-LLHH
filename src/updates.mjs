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
export const builtInRepository='X-system/VPS-LLHH';
export function beijingDay(now){return new Date(now+8*3600000).toISOString().slice(0,10);}
export function dailyCheckDue(now,lastDay){return new Date(now+8*3600000).getUTCHours()>=8&&beijingDay(now)!==lastDay;}
export function createUpdateManager({directory='/etc/vps-panel',coreDirectory='/usr/local/lib/vps-panel',fetchImpl=fetch,schedule,getRole=async()=> 'relay',clock=Date.now,sourceRepository=builtInRepository,isRunning=async()=>false}={}){
 const repository=repositoryName(sourceRepository);let checking=null,ticking=null,queueing=false;
 const read=async(name,fallback=null)=>{try{return JSON.parse(await readFile(join(directory,name),'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
 const write=(name,value)=>atomicWrite(join(directory,name),JSON.stringify(value));
 async function version(){return JSON.parse(await readFile(fileURLToPath(new URL('../package.json',import.meta.url)),'utf8')).version;}
 async function check(){
  if(checking)return checking;
  checking=(async()=>{const current=await version(),allowTest=parseVersion(current)?.test!=null,role=await getRole(),found=[];
   if(!['relay','exit'].includes(role))throw new Error('安装角色错误');
   try{
    for(let page=1;page<=10;page++){
     const response=await fetchImpl('https://api.github.com/repos/'+repository+'/releases?per_page=100&page='+page,{headers:{Accept:'application/vnd.github+json','User-Agent':'vps-panel-updater','X-GitHub-Api-Version':'2026-03-10'},redirect:'error',signal:AbortSignal.timeout(15000)});
     if(!response.ok)throw new Error('暂时无法检查更新，请稍后重试');const releases=await response.json();if(!Array.isArray(releases))throw new Error('更新信息格式错误');
     for(const release of releases)try{found.push(releaseAsset(repository,release,{allowTest,role}));}catch{}
     if(releases.length<100)break;
    }
    const available=found.sort((a,b)=>compareVersions(b.version,a.version))[0]||null;
    await write('update-check.json',{checkedAt:clock(),role,available,error:null});return available;
   }catch(e){const previous=await read('update-check.json',{});await write('update-check.json',{...previous,attemptedAt:clock(),error:'检查更新失败，请检查网络后重试'});throw e;}
  })().finally(()=>{checking=null;});return checking;
 }
 async function status({check:requested=false}={}){
  if(requested)await check();const current=await version(),role=await getRole(),cache=await read('update-check.json',{}),job=await read('update-state.json'),plan=await read('update-plan.json');
  const available=cache.role===role?cache.available:null;
  return{currentVersion:current,job,available:available?{version:available.version}:null,hasUpdate:!!available&&newerVersion(available.version,current),checkedAt:cache.checkedAt||null,checkError:cache.error||null,plan:plan?{state:plan.state,at:plan.at,version:plan.version}:null,dailyCheckTime:'08:00',timeZone:'Asia/Shanghai'};
 }
 async function queue(asset){
  if(queueing)throw new Error('正在提交更新任务，请稍候');queueing=true;
  try{
   if(asset.role!==await getRole()||!newerVersion(asset.version,await version()))throw new Error('预约版本与当前服务器不匹配，或已不是更新版本');
   await write('update-request.json',{...asset,repository});await write('update-state.json',{step:'queued',version:asset.version,at:clock()});
   try{await schedule(join(coreDirectory,'app/src/update-runner.mjs'),'--update');}catch(e){await write('update-state.json',{step:'failed-to-start',at:clock()});throw e;}
   return{accepted:true,version:asset.version};
  }finally{queueing=false;}
 }
 async function start(input){
  if(input.confirmed!==true)throw new Error('更新会短暂暂停线路，请先确认');
  const asset=await check();if(!asset||!newerVersion(asset.version,await version()))throw new Error('当前已经是最新可用版本');
  await write('update-plan.json',{state:'launching',at:clock(),launchAt:clock(),version:asset.version,asset});
  try{const result=await queue(asset);await write('update-plan.json',{state:'launched',at:clock(),launchAt:clock(),version:asset.version,asset});return result;}
  catch(e){await write('update-plan.json',{state:'failed',at:clock(),version:asset.version});throw e;}
 }
 async function tick(){
  if(ticking)return ticking;ticking=(async()=>{
   let plan=await read('update-plan.json');const job=await read('update-state.json');
   if(plan&&['launching','launched'].includes(plan.state)){
    if(job?.at>=(plan.launchAt||plan.at)&&['complete','rolled-back','failed','failed-rolled-back','failed-needs-ssh','failed-to-start','failed-interrupted'].includes(job?.step)){plan={...plan,state:'finished',asset:undefined};await write('update-plan.json',plan);}
    else if(clock()-(plan.launchAt||plan.at)>60000&&!await isRunning()){plan={...plan,state:'scheduled'};await write('update-plan.json',plan);}
   }
   if(plan?.state==='scheduled'&&(plan.asset?.role!==await getRole()||!newerVersion(plan.version,await version()))){plan={state:'cancelled',at:clock(),version:plan.version};await write('update-plan.json',plan);}
   if(plan?.state==='scheduled'&&plan.at<=clock()&&(!plan.retryAt||plan.retryAt<=clock())){
    try{plan={...plan,state:'launching',launchAt:clock()};await write('update-plan.json',plan);await queue(plan.asset);await write('update-plan.json',{...plan,state:'launched'});}
    catch{const attempts=(plan.attempts||0)+1;await write('update-plan.json',{...plan,state:attempts>=5?'failed':'scheduled',attempts,retryAt:clock()+60000});}
   }
   const latestJob=await read('update-state.json');if(['queued','downloading','prepared','installing','checking'].includes(latestJob?.step)&&clock()-latestJob.at>120000&&!await isRunning())await write('update-state.json',{step:'failed-interrupted',at:clock(),interruptedPhase:latestJob.step});
   const daily=await read('update-daily.json',{});
   if(dailyCheckDue(clock(),daily.day)){
    await write('update-daily.json',{day:beijingDay(clock()),at:clock()});try{await check();}catch{}
   }
  })().finally(()=>{ticking=null;});return ticking;
 }
 return{status,tick,start,
  async reserve(input){
   if(input.confirmed!==true||!Number.isSafeInteger(input.at)||input.at<clock()+60000||input.at>clock()+30*86400000)throw new Error('请选择1分钟后、30天以内的预约时间，并确认更新');
   const asset=await check();if(!asset||!newerVersion(asset.version,await version()))throw new Error('当前没有可预约的更新');
   if(await isRunning())throw new Error('更新正在执行，不能重新预约');await write('update-plan.json',{state:'scheduled',at:input.at,version:asset.version,asset,confirmedAt:clock()});return{accepted:true,at:input.at,version:asset.version};
  },
  async cancel(){const plan=await read('update-plan.json');if(plan&&!['scheduled','failed'].includes(plan.state))throw new Error('更新已经开始，不能取消');await write('update-plan.json',null);return{cancelled:true};},
  async diagnostics(){return{format:'vps-panel-update-diagnostics',at:clock(),status:await status(),history:await read('update-history.json',[])};},
  async rollback(input){if(input.confirmed!==true)throw new Error('回滚会恢复升级前的配置与统计，请确认');await readFile('/var/cache/vps-panel-updates/previous/panel.sqlite');await schedule(join(coreDirectory,'app/src/update-runner.mjs'),'--rollback');return{accepted:true};}
 };
}
