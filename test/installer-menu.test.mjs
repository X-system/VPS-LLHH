import test from'node:test';
import assert from'node:assert/strict';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
test('终端安装菜单明确提示、无效输入重试、确认、取消和输入中断',{skip:process.platform!=='linux'},async()=>{
 const r=await promisify(execFile)('python3',['test/installer-menu-fixture.py'],{timeout:40000});assert.equal(JSON.parse(r.stdout).eofHandled,true);
});
