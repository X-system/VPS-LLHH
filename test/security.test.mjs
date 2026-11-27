import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { newEntrance,hashPassword,verifyPassword,encrypt,decrypt,RateLimiter } from '../src/security.mjs';

test('入口始终20位，四类字符均存在，批量生成不重复',()=>{
  const seen=new Set();
  for(let index=0;index<1000;index++){
    const value=newEntrance();
    assert.match(value,/^[A-Za-z0-9_~\-]{20}$/);
    for(const expression of [/[a-z]/,/[A-Z]/,/\d/,/[_~\-]/])assert.match(value,expression);
    assert.ok(!seen.has(value));seen.add(value);
  }
});
test('密码校验和认证加密拒绝错误密码、错误密钥及篡改',async()=>{
  const hash=await hashPassword('a-long-test-password');
  assert.ok(await verifyPassword('a-long-test-password',hash));
  assert.equal(await verifyPassword('wrong-password',hash),false);
  const key=randomBytes(32),value=encrypt('private-api-token',key);
  assert.ok(!value.includes('private-api-token'));
  assert.equal(decrypt(value,key),'private-api-token');
  assert.throws(()=>decrypt(value,randomBytes(32)));
  const parts=value.split('.');parts[2]=randomBytes(16).toString('base64url');
  assert.throws(()=>decrypt(parts.join('.'),key));
});
test('登录限速有时间窗口和内存容量限制',()=>{
  let now=0;const limiter=new RateLimiter({max:2,capacity:2,window:100,clock:()=>now});
  assert.ok(limiter.allow('one'));assert.ok(limiter.allow('one'));assert.equal(limiter.allow('one'),false);
  assert.ok(limiter.allow('two'));assert.equal(limiter.allow('three'),false);
  now=101;assert.ok(limiter.allow('three'));
});
