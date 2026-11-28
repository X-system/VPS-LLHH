import test from'node:test';
import assert from'node:assert/strict';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
const run=promisify(execFile);
test('安装入口自动补依赖、复查、复用已安装组件；失败或部分下载不执行安装',{skip:process.platform!=='linux'},async()=>{
 const result=await run('python3',['test/installer-environment-fixture.py'],{timeout:60000});assert.equal(JSON.parse(result.stdout).passed.length,10);
});
