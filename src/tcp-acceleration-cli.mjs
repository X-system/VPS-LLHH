import{execFile,spawn}from'node:child_process';
import{promisify}from'node:util';
import{createTcpAcceleration}from'./tcp-acceleration.mjs';
if(process.platform!=='linux'||process.getuid()!==0)throw new Error('TCP加速只能由本机系统服务执行');
const execute=promisify(execFile);
const runner=(binary,args,options)=>{
 if(binary!=='/bin/bash')return execute(binary,args,options);
 // Stream the inspected installer output to this task's journal instead of
 // discarding build diagnostics or buffering an entire compiler transcript.
 return new Promise((resolve,reject)=>{const child=spawn(binary,args,{stdio:'inherit',windowsHide:true});const timer=setTimeout(()=>child.kill('SIGTERM'),options.timeout);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);code===0?resolve({stdout:''}):reject(new Error('BBRX安装未完成'));});});
};
const manager=createTcpAcceleration({runner}),boot=process.argv[2]==='--boot';
try{await manager.execute(boot?'off':process.argv[2],{boot});console.log('TCP加速配置完成');}catch{console.error('TCP加速配置失败，请检查安装依赖、内核兼容性和本机任务日志');process.exitCode=1;}
