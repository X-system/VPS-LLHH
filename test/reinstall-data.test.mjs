import test from'node:test';
import assert from'node:assert/strict';
import{mkdtemp,rm,readFile}from'node:fs/promises';
import{join}from'node:path';
import{tmpdir}from'node:os';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
import{openStore}from'../src/store.mjs';

test('覆盖安装保留账户、主密钥、配对和配置，只清理瞬时运行状态并停止线路',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'llhh-reinstall-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let s=await openStore({directory,password:'test-only'});const admin=s.db.prepare('SELECT * FROM admin').get();
 const config={'relay-config':{fixture:'paired-relay'},'network-config':{fixture:'paired-network'},'auth-services':{fixture:'user-auth'},onboarding:{completed:['account'],step:'done'},settings:{...s.get('settings'),panelName:'unchanged'}};
 for(const[k,v]of Object.entries(config))s.set(k,v);s.set('live-traffic',{stale:true});s.close();const key=await readFile(join(directory,'master.key'));
 await promisify(execFile)(process.execPath,['src/install-init.mjs','--restore','--preserve-config'],{env:{...process.env,VPS_DATA_DIR:directory}});
 s=await openStore({directory});try{assert.deepEqual(s.db.prepare('SELECT * FROM admin').get(),admin);for(const[k,v]of Object.entries(config))assert.deepEqual(s.get(k),v,k);assert.deepEqual(await readFile(join(directory,'master.key')),key);assert.equal(s.get('live-traffic'),null);assert.equal(s.get('runtime').emergencyStop,true);}finally{s.close();}
});
