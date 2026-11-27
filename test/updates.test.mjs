import test from'node:test';
import assert from'node:assert/strict';
import{mkdtempSync,rmSync,readFileSync,writeFileSync}from'node:fs';
import{join,resolve}from'node:path';
import{tmpdir}from'node:os';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
import{createUpdateManager,releaseAsset,newerVersion}from'../src/updates.mjs';

const runner=promisify(execFile);
test('更新只接受指定GitHub正式Release的正确发布包、大小与摘要，不能降级或改下载主机',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-update-test-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const release={tag_name:'relay-v0.2.1',assets:[{name:'vps-panel-v0.2.1.tar.gz',size:100,digest:'sha256:'+'a'.repeat(64),browser_download_url:'https://github.com/example/panel/releases/download/relay-v0.2.1/vps-panel-v0.2.1.tar.gz'}]};
 assert.equal(releaseAsset('example/panel',release).version,'0.2.1');
 assert.throws(()=>releaseAsset('example/panel',{...release,prerelease:true}));
 assert.throws(()=>releaseAsset('example/panel',{...release,assets:[{...release.assets[0],browser_download_url:'https://evil.example/file'}]}));
 assert.equal(newerVersion('0.1.0','0.2.0'),false);
 const calls=[],manager=createUpdateManager({directory,fetchImpl:async url=>{assert.equal(url,'https://api.github.com/repos/example/panel/releases?per_page=100&page=1');return{ok:true,json:async()=>[release]};},schedule:async(...args)=>calls.push(args)});
 await manager.configure({repository:'example/panel'});await assert.rejects(manager.start({confirmed:false}));
 await manager.start({confirmed:true});assert.equal(calls.length,1);
 const request=JSON.parse(readFileSync(join(directory,'update-request.json')));assert.equal(request.sha256,'a'.repeat(64));
});
test('发布包只打包公开源文件，提取器拒绝路径穿越、重复成员与不在清单的文件',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-release-test-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const python=process.platform==='win32'?'python':'python3';
 await runner(python,['scripts/build_release.py'],{cwd:resolve('.'),timeout:30000});
 const version=JSON.parse(readFileSync('package.json')).version;
 const output=await runner(python,['scripts/extract_release.py',`dist/vps-panel-v${version}.tar.gz`,join(directory,'good')],{timeout:30000});assert.equal(output.stdout.trim(),version);
 const manifest=JSON.parse(readFileSync(join(directory,'good/release-manifest.json')));assert.ok(!Object.keys(manifest.files).some(file=>file.startsWith('data/')||file.includes('node_modules')));
 await runner(python,['-c',"import tarfile,io,sys\nwith tarfile.open(sys.argv[1],'w:gz')as t:\n i=tarfile.TarInfo('../escape');i.size=1;t.addfile(i,io.BytesIO(b'x'))",join(directory,'bad.tar.gz')]);
 await assert.rejects(runner(python,['scripts/extract_release.py',join(directory,'bad.tar.gz'),join(directory,'bad')],{timeout:10000}));
});
