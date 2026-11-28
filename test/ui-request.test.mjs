import test from'node:test';
import assert from'node:assert/strict';
import{fetchPanel}from'../public/ui-request.mjs';
test('短暂断连只重试读取；保存请求不重复发送并标记需要核对进度',async()=>{
 let calls=0;const response={ok:true};assert.equal(await fetchPanel('/api/test',{fetchImpl:async()=>{if(++calls<3)throw new TypeError('offline');return response;},wait:async()=>{}}),response);assert.equal(calls,3);
 calls=0;await assert.rejects(fetchPanel('/api/test',{method:'POST',data:{step:'name'},fetchImpl:async()=>{calls++;throw new TypeError('offline');},wait:async()=>{}}),e=>e.network===true&&!e.message.includes('重启'));assert.equal(calls,1);
});
