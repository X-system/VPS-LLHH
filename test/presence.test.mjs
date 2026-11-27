import test from'node:test';
import assert from'node:assert/strict';
import{lastOnline}from'../public/presence.mjs';

test('最后在线时间按分钟展示相对时间，同时提供完整时间；未知状态不伪装离线',()=>{
 const seen=Date.parse('2026-11-24T08:24:00Z');
 for(const[minutes,label]of[[0,'不足1分钟前在线'],[5,'5分钟前在线'],[60,'1小时前在线'],[72,'1小时12分钟前在线'],[1512,'1天1小时12分钟前在线']]){
  const value=lastOnline({online:false,last_online:seen},{now:seen+minutes*60000,timeZone:'Asia/Shanghai'});
  assert.equal(value.label,label);assert.match(value.exact,/2026/);assert.match(value.exact,/16:24/);
 }
 assert.equal(lastOnline({online:true,last_online:seen}).label,'当前在线');
 assert.equal(lastOnline({online:null,last_online:seen},{now:seen+5*60000}).label,'5分钟前在线');
 assert.equal(lastOnline({online:null,last_online:null}).label,'尚无在线记录');
 assert.equal(lastOnline({online:false,last_online:seen},{now:seen-120000}).label,'时间待校准');
});
