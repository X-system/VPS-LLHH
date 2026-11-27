import test from'node:test';
import assert from'node:assert/strict';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
const run=promisify(execFile);
test('公开发布先校验全部附件再转正式；上传失败保留草稿，已发布版本不覆盖',async()=>{
 for(const mode of['success','failure','existing']){
  const result=await run(process.platform==='win32'?'python':'python3',['test/publish-fixture.py',mode],{timeout:15000,windowsHide:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  assert.ok(JSON.parse(result.stdout.trim().split('\n').at(-1)).passed);
 }
});
