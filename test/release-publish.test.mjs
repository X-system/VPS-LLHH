import test from'node:test';
import assert from'node:assert/strict';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
const run=promisify(execFile);
test('公开发布先校验全部附件再转正式；上传失败保留草稿，已发布版本不覆盖',async()=>{
 for(const mode of['success','failure','existing','missing','required']){
  const result=await run(process.platform==='win32'?'python':'python3',['test/publish-fixture.py',mode],{timeout:15000,windowsHide:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  assert.ok(JSON.parse(result.stdout.trim().split('\n').at(-1)).passed);
 }
});
test('授权替换test2时归档旧源码和附件，发布新包后再恢复可见，不删除旧程序包',async()=>{
 const result=await run(process.platform==='win32'?'python':'python3',['test/replacement-publish-fixture.py'],{timeout:15000,windowsHide:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).oldSourceAndProgramsPreserved,true);
});
