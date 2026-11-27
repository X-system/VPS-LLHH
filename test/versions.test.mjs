import test from'node:test';
import assert from'node:assert/strict';
import{parseVersion,compareVersions,versionLabel}from'../src/versions.mjs';
import{releaseAsset,newerVersion}from'../src/updates.mjs';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
const run=promisify(execFile);
test('版本按 test1、test2、test10、正式版排序；测试版有中文标注',()=>{
 const values=['0.2.0','0.2.0-test10','0.1.0-test1','0.2.0-test2','0.2.0-test1'];
 assert.deepEqual(values.sort(compareVersions),['0.1.0-test1','0.2.0-test1','0.2.0-test2','0.2.0-test10','0.2.0']);
 assert.equal(versionLabel('0.2.0-test1'),'0.2.0-test1（测试版）');assert.equal(versionLabel('0.4.2'),'0.4.2');
 for(const value of['v0.2.0','01.2.0','0.2.0-test0','0.2.0-test01','0.2.0-test','0.2.0-beta1','0.2.0\n'])assert.equal(parseVersion(value),null);
 assert.equal(newerVersion('0.2.0-test1','0.2.0'),false);assert.equal(newerVersion('0.2.0','0.2.0-test10'),true);
});
test('发布包按角色隔离，正式渠道拒绝测试包，测试标识必须一致',()=>{
 const release={tag_name:'relay-v0.2.0-test1',prerelease:true,assets:[{name:'vps-panel-v0.2.0-test1.tar.gz',size:100,digest:'sha256:'+'a'.repeat(64),browser_download_url:'https://github.com/example/panel/releases/download/relay-v0.2.0-test1/vps-panel-v0.2.0-test1.tar.gz'}]};
 assert.throws(()=>releaseAsset('example/panel',release));assert.throws(()=>releaseAsset('example/panel',release,{allowTest:true,role:'exit'}));
 assert.equal(releaseAsset('example/panel',release,{allowTest:true}).role,'relay');
 assert.throws(()=>releaseAsset('example/panel',{...release,prerelease:false},{allowTest:true}));
 assert.throws(()=>releaseAsset('example/panel',{...release,body:'<!-- llhh:installer -->'},{allowTest:true}));
});
test('实际安装目录列表按角色过滤、只列完整发布，安全提取阻止路径穿越和数据库降级',async()=>{
 const result=await run(process.platform==='win32'?'python':'python3',['test/version-installer-fixture.py'],{timeout:15000,windowsHide:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});assert.ok(JSON.parse(result.stdout.trim().split('\n').at(-1)).passed);
});
