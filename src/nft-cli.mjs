import{readFile,lstat,realpath}from'node:fs/promises';
import{resolve,join}from'node:path';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
import{atomicWrite}from'./system-driver.mjs';
import{nftFingerprint}from'./nft-integrity.mjs';

if(process.platform!=='linux'||process.getuid()!==0)throw new Error('内核规则只能由root管理');
const operation=process.argv[2],checking=operation?.startsWith('check-'),name=checking?operation.slice(6):operation,families={guard:[['inet','vps_panel_guard']],forward:[['inet','vps_panel_forward'],['ip','vps_panel_nat']]};
if(!Object.hasOwn(families,name))throw new Error('规则集标识错误');
const directory=resolve(process.argv[3]||'/etc/vps-panel'),stat=await lstat(directory);
if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==0||(stat.mode&0o022)||await realpath(directory)!==directory)throw new Error('内核规则目录不安全');
const run=promisify(execFile),options={timeout:15000,maxBuffer:1024*1024,windowsHide:true},deletes=[];
if(checking){
 try{
  const expected=JSON.parse(await readFile(join(directory,name+'-integrity.json'),'utf8'));
  for(const[family,table]of families[name])if(nftFingerprint((await run('/usr/sbin/nft',['-j','-nn','list','table',family,table],options)).stdout)!==expected[family+'.'+table])exitFailure();
 }catch{exitFailure();}
 process.exit(0);
}
function exitFailure(){process.exit(1);}
// The caller holds /etc/vps-panel/nft.lock via flock across inspection and apply.
for(const[family,table]of families[name])try{await run('/usr/sbin/nft',['list','table',family,table],options);deletes.push(`delete table ${family} ${table}`);}catch(error){if(error.code!==1)throw error;}
const file=join(directory,name+'.nft');
await atomicWrite(file,[...deletes,await readFile(join(directory,name+'-source.nft'),'utf8')].join('\n'));
await run('/usr/sbin/nft',['--check','--file',file],options);await run('/usr/sbin/nft',['--file',file],options);
const fingerprints={};
for(const[family,table]of families[name])fingerprints[family+'.'+table]=nftFingerprint((await run('/usr/sbin/nft',['-j','-nn','list','table',family,table],options)).stdout);
await atomicWrite(join(directory,name+'-integrity.json'),JSON.stringify(fingerprints));
