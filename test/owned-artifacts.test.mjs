import test from'node:test';
import assert from'node:assert/strict';
import{mkdtemp,writeFile,readFile,rm,mkdir,symlink}from'node:fs/promises';
import{join}from'node:path';
import{tmpdir}from'node:os';
import{registerInstallerArtifact,removeInstallerArtifacts}from'../src/owned-artifacts.mjs';
test('彻底卸载只移除登记且未改动的临时安装脚本，不删除用户文件或越界路径',async t=>{
 const root=await mkdtemp(join(tmpdir(),'llhh-owned-'));t.after(()=>rm(root,{recursive:true,force:true}));const owned=join(root,'owned'),other=join(root,'other');await mkdir(owned);await mkdir(other);const ledgerPath=join(root,'ledger.json'),options={ledgerPath,parents:[owned]},script=join(owned,'install.sh'),modified=join(owned,'changed.sh'),user=join(owned,'user.sh'),outside=join(other,'outside.sh');for(const name of[script,modified,outside])await writeFile(name,'# LLHH 安装向导');await writeFile(user,'user data');assert.equal(await registerInstallerArtifact(script,options),true);assert.equal(await registerInstallerArtifact(modified,options),true);assert.equal(await registerInstallerArtifact(outside,options),false);await writeFile(modified,'user changed script');const entries=JSON.parse(await readFile(ledgerPath));entries.push({path:outside,sha256:entries[0].sha256});await writeFile(ledgerPath,JSON.stringify(entries));await removeInstallerArtifacts(options);await assert.rejects(readFile(script),{code:'ENOENT'});assert.equal(await readFile(user,'utf8'),'user data');assert.equal(await readFile(modified,'utf8'),'user changed script');assert.equal(await readFile(outside,'utf8'),'# LLHH 安装向导');
});
