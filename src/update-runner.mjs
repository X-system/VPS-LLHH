import{mkdir,readFile,writeFile,rename,rm,copyFile,chown,chmod,lstat,unlink,realpath}from'node:fs/promises';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
import{createHash,randomBytes}from'node:crypto';
import{DatabaseSync,backup}from'node:sqlite';
import https from'node:https';
import tls from'node:tls';
import{join}from'node:path';
import{createSystemDriver,atomicWrite}from'./system-driver.mjs';

if(process.platform!=='linux'||process.getuid()!==0)throw new Error('更新程序只能由Linux的root运行');
const mode=process.argv[2];if(!['--update','--rollback'].includes(mode))throw new Error('更新模式错误');
const base='/usr/local/lib/vps-panel',directory='/etc/vps-panel',cache='/var/cache/vps-panel-updates',data='/var/lib/vps-panel';
const run=promisify(execFile),command=(binary,args,timeout=30000)=>run(binary,args,{timeout,maxBuffer:2*1024*1024,windowsHide:true});
const node=join(base,'runtime/bin/node'),driver=createSystemDriver();
const units=['vps-panel-web','vps-panel-worker','vps-panel-auth','vps-panel-agent'];
for(const root of[base,directory,data]){const stat=await lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(root)!==root)throw new Error('程序目录不安全');}
await mkdir(cache,{recursive:true,mode:0o700});
const cacheStat=await lstat(cache);if(!cacheStat.isDirectory()||cacheStat.uid!==0||(cacheStat.mode&0o077)||await realpath(cache)!==cache)throw new Error('更新缓存目录不安全');
const previous=join(cache,'previous'),oldApp=join(base,'previous-app');
const setState=(step,extra={})=>atomicWrite(join(directory,'update-state.json'),JSON.stringify({step,at:Date.now(),...extra}));
async function generateUnits(){
 await command(node,['--input-type=module','-e',`import{writeFileSync}from'node:fs';import{serviceUnits}from'/usr/local/lib/vps-panel/app/src/service-units.mjs';for(const[name,text]of Object.entries(serviceUnits()))writeFileSync('/etc/systemd/system/'+name,text,{mode:0o644});`]);
 await command('/usr/bin/systemctl',['daemon-reload']);
 await command('/usr/bin/install',['-m','755',join(base,'app/config/vps-panel'),'/usr/local/bin/vps-panel']);
}
async function startManagement(){await generateUnits();await command('/usr/bin/systemctl',['reset-failed',...units]);await command('/usr/bin/systemctl',['start',...units]);}
async function stopManagement(){await command('/usr/bin/systemctl',['stop',...units]);}
async function snapshot(target){
 await mkdir(target,{recursive:true,mode:0o700});
 const db=new DatabaseSync(join(data,'panel.sqlite'),{readOnly:true});
 try{await backup(db,join(target,'panel.sqlite'));}finally{db.close();}
 await copyFile(join(data,'master.key'),join(target,'master.key'));
 const stat=await lstat(join(data,'panel.sqlite'));await atomicWrite(join(target,'metadata.json'),JSON.stringify({uid:stat.uid,gid:stat.gid,at:Date.now()}));
}
async function restoreSnapshot(source=previous){
 const metadata=JSON.parse(await readFile(join(source,'metadata.json'),'utf8'));
 for(const name of['panel.sqlite-wal','panel.sqlite-shm'])await unlink(join(data,name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
 for(const name of['panel.sqlite','master.key']){await copyFile(join(source,name),join(data,name));await chmod(join(data,name),0o600);await chown(join(data,name),metadata.uid,metadata.gid);}
 await command('/usr/sbin/runuser',['-u','vps-panel','--',node,'--input-type=module','-e',"import{openStore}from'/usr/local/lib/vps-panel/app/src/store.mjs';const store=await openStore({directory:'/var/lib/vps-panel'});store.set('runtime',{maintenance:true,emergencyStop:true});for(const key of['service-status','live-traffic','host-counters'])store.set(key,null);store.close();"]);
}
async function health(){
 const env=Object.fromEntries((await readFile(join(directory,'web.env'),'utf8')).split('\n').filter(line=>/^[A-Z_]+=/.test(line)).map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];}));
 const origin=new URL(env.VPS_ORIGIN),ca=[...tls.rootCertificates,await readFile(join(directory,'certs/panel-fullchain.pem'),'utf8')];
 const db=new DatabaseSync(join(data,'panel.sqlite'),{readOnly:true});let entrance;try{entrance=JSON.parse(db.prepare("SELECT value FROM config WHERE key='entrance'").get().value).value;}finally{db.close();}
 for(let attempt=0;attempt<15;attempt++){
  try{
   const value=await new Promise((resolve,reject)=>{
    const req=https.get({hostname:'127.0.0.1',port:Number(env.VPS_PORT),path:`/${entrance}/api/meta`,headers:{Host:origin.host},ca,checkServerIdentity:(_,cert)=>tls.checkServerIdentity(origin.hostname,cert),timeout:2000},res=>{
     let body='';res.on('data',chunk=>{body+=chunk;if(body.length>65536)res.destroy(new Error('响应过大'));});res.on('error',reject);res.on('end',()=>{try{if(res.statusCode!==200)throw new Error('启动检查失败');resolve(JSON.parse(body));}catch(error){reject(error);}});
    });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('启动超时')));
   });if(value.serverName&&['relay','exit'].includes(value.role))return;
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 throw new Error('更新后面板自检未通过');
}
async function download(request,path){
 if(!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/v\d+\.\d+\.\d+\/vps-panel-v\d+\.\d+\.\d+\.tar\.gz$/.test(request.url)||!Number.isInteger(request.size)||request.size>20*1024*1024||!/^[a-f0-9]{64}$/.test(request.sha256))throw new Error('发布任务参数错误');
 const response=await fetch(request.url,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw new Error('发布包下载失败');
 const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>request.size||size>20*1024*1024)throw new Error('发布包大小异常');chunks.push(chunk);}
 const content=Buffer.concat(chunks);if(size!==request.size||createHash('sha256').update(content).digest('hex')!==request.sha256)throw new Error('发布包SHA256校验失败');
 await writeFile(path,content,{mode:0o600,flag:'wx'});
}
let swapped=false,stopped=false,manualRecovery=null,retained=null;
async function restoreRetained(){
 if(!retained)return;
 if(retained.newDataInstalled)await rm(previous,{recursive:true,force:true});
 if(retained.data)await rename(retained.data,previous);
 if(retained.app)await rename(retained.app,oldApp);
 retained=null;
}
async function retainPrevious(nextSnapshot){
 retained={data:null,app:null,newDataInstalled:false};const id=randomBytes(8).toString('hex');
 const dataBackup=join(cache,'retained-'+id),appBackup=join(base,'retained-app-'+id);
 try{await rename(previous,dataBackup);retained.data=dataBackup;}catch(error){if(error.code!=='ENOENT')throw error;}
 try{await rename(oldApp,appBackup);retained.app=appBackup;}catch(error){if(error.code!=='ENOENT')throw error;}
 await rename(nextSnapshot,previous);retained.newDataInstalled=true;
}
try{
 if(mode==='--rollback'){
  await readFile(join(previous,'panel.sqlite'));await lstat(oldApp);
 }else{
  const request=JSON.parse(await readFile(join(directory,'update-request.json'),'utf8'));
  const stage=join(cache,'stage-'+randomBytes(12).toString('hex'));await mkdir(stage,{mode:0o700});await setState('downloading',{version:request.version});
  await download(request,join(stage,'release.tar.gz'));
  await command('/usr/bin/python3',[join(base,'app/scripts/extract_release.py'),join(stage,'release.tar.gz'),join(stage,'app')]);
  const manifest=JSON.parse(await readFile(join(stage,'app/release-manifest.json'),'utf8'));
  if(manifest.version!==request.version||manifest.runtimeMajor!==24||manifest.schemaVersion!==2)throw new Error('发布版本或运行时不兼容');
  const installedComponents=JSON.parse(await readFile(join(base,'app/config/releases.json'),'utf8')),candidateComponents=JSON.parse(await readFile(join(stage,'app/config/releases.json'),'utf8'));
  if(['node','xray','hysteria'].some(name=>installedComponents[name]?.sha256!==candidateComponents[name]?.sha256))throw new Error('此版本包含核心或运行时变更，当前面板升级器尚不支持');
  await command(node,[join(base,'runtime/lib/node_modules/npm/bin/npm-cli.js'),'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund','--prefix',join(stage,'app')],180000);
  await command(node,[join(base,'app/scripts/check.mjs'),join(stage,'app')],120000);
  await setState('prepared',{version:request.version});
  await command('/usr/sbin/runuser',['-u','vps-panel','--',node,join(base,'app/src/flush-traffic.mjs')]);
  await command('/usr/bin/systemctl',['stop','vps-panel-worker']);
  await driver.action('emergency-stop');stopped=true;await stopManagement();
  const nextSnapshot=join(cache,'next-previous-'+randomBytes(8).toString('hex'));await snapshot(nextSnapshot);
  // Staging is in /var/cache, which may be a different filesystem. Copy first, then rename locally.
  const candidate=join(base,'next-app');await rm(candidate,{recursive:true,force:true});await command('/usr/bin/cp',['-a',join(stage,'app'),candidate]);await chmod(candidate,0o755);
  await command('/usr/bin/chmod',['-R','go+rX,go-w',candidate]);
  await command('/usr/sbin/runuser',['-u','vps-panel','--',node,'--input-type=module','-e',`import{createRequire}from'node:module';const require=createRequire('${candidate}/package.json');require('qrcode');require('acme-client');`]);
  await retainPrevious(nextSnapshot);
  await rename(join(base,'app'),oldApp);swapped=true;await rename(candidate,join(base,'app'));
 }
 if(mode==='--rollback'){
  await command('/usr/sbin/runuser',['-u','vps-panel','--',node,join(base,'app/src/flush-traffic.mjs')]);
  await command('/usr/bin/systemctl',['stop','vps-panel-worker']);
  await driver.action('emergency-stop');stopped=true;await stopManagement();
  const safety=join(cache,'before-manual-rollback-'+randomBytes(8).toString('hex'));await snapshot(safety);
  const failed=join(base,'rolled-back-app-'+randomBytes(8).toString('hex'));await rename(join(base,'app'),failed);manualRecovery={app:failed,snapshot:safety};await rename(oldApp,join(base,'app'));await restoreSnapshot();swapped=false;
 }
 await startManagement();await health();await setState(mode==='--rollback'?'rolled-back':'complete',{maintenance:true});
 if(retained)for(const path of[retained.data,retained.app].filter(Boolean))await rm(path,{recursive:true,force:true}).catch(()=>{});
 console.log('维护完成，代理保持急停；请检查配置后手动恢复。');
}catch{
 if(manualRecovery){
  try{
   await stopManagement();
   try{await rename(join(base,'app'),join(base,'failed-rollback-app-'+randomBytes(8).toString('hex')));}catch(error){if(error.code!=='ENOENT')throw error;}
   await rename(manualRecovery.app,join(base,'app'));await restoreSnapshot(manualRecovery.snapshot);await startManagement();await health();await setState('rollback-failed-restored-current',{maintenance:true});
  }catch{await setState('failed-needs-ssh',{maintenance:true});}
 }else if(swapped){
  try{await stopManagement();const failed=join(base,'failed-app-'+randomBytes(8).toString('hex'));try{await rename(join(base,'app'),failed);}catch(error){if(error.code!=='ENOENT')throw error;}await rename(oldApp,join(base,'app'));await restoreSnapshot();await restoreRetained();await startManagement();await health();await setState('failed-rolled-back',{maintenance:true});}catch{await setState('failed-needs-ssh',{maintenance:true});}
 }else{
  let backupRecovered=true;try{await restoreRetained();}catch{backupRecovered=false;}
  if(stopped)try{await startManagement();}catch{}
  else try{await command('/usr/bin/systemctl',['start','vps-panel-worker']);}catch{}
  await setState(backupRecovered?'failed':'failed-needs-ssh',{maintenance:true});
 }
 console.error('维护未完成；凭证未写入日志，请查看面板更新状态或SSH应急菜单。');process.exitCode=1;
}finally{await unlink(join(directory,'maintenance.lock')).catch(error=>{if(error.code!=='ENOENT')throw error;});}
