import test from'node:test';
import assert from'node:assert/strict';
import{mkdtempSync,rmSync,readFileSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{randomBytes}from'node:crypto';
import{createDnsJournal}from'../src/dns-journal.mjs';
import{createCloudflareDns}from'../src/certificates.mjs';

test('签发中断后凭加密日志重试清理；HTTP响应未落盘时按专属标记查找，不删除他人记录',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-dns-journal-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const key=randomBytes(32),settings={zoneId:'a'.repeat(32),token:'private-token-for-dns-test'},requests=[];
 let record,fail=true;
 const fetchImpl=async(url,options)=>{
  requests.push([url,options.method]);
  if(options.method==='DELETE'){
   if(fail)throw new Error('network unavailable');
   assert.ok(url.endsWith('/'+'b'.repeat(32)));return{ok:false,status:404};
  }
  return{ok:true,json:async()=>({success:true,result:[
   {id:'b'.repeat(32),type:'TXT',name:record.name,content:record.content,comment:record.marker},
   {id:'c'.repeat(32),type:'TXT',name:record.name,content:record.content,comment:'personal record'},
   {id:'d'.repeat(32),type:'TXT',name:record.name,content:'different',comment:record.marker}
  ]})};
 };
 const options={directory,master:async()=>key,createDns:config=>createCloudflareDns({...config,fetchImpl})};
 record=await createDnsJournal(options).intent(settings,'_acme-challenge.relay.example.test','test-authorization');
 assert.ok(!readFileSync(join(directory,'dns-cleanup.enc'),'utf8').includes(settings.token));
 await assert.rejects(createDnsJournal(options).cleanup(),/重试/);
 fail=false;await createDnsJournal(options).cleanup();const count=requests.length;
 await createDnsJournal(options).cleanup();assert.equal(requests.length,count);
 assert.equal(requests.filter(([,method])=>method==='DELETE').length,2);
});

test('已知本次记录ID直接重试清理，换配置后仍使用原始区域与令牌',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-dns-journal-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const key=randomBytes(32),seen=[],options={directory,master:async()=>key,createDns:config=>{seen.push(config);return{remove:async id=>assert.equal(id,'e'.repeat(32)),findOwned:async()=>assert.fail('known ID must not scan')};}};
 const journal=createDnsJournal(options),settings={zoneId:'a'.repeat(32),token:'original-token'};
 const record=await journal.intent(settings,'_acme-challenge.relay.example.test','authorization');await journal.created(record.marker,'e'.repeat(32));
 await createDnsJournal(options).cleanup();assert.equal(seen[0].zoneId,settings.zoneId);assert.equal(seen[0].token,settings.token);
});

test('同一区域更换有效令牌后，未清理记录使用新令牌重试，不误用其他区域凭证',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-dns-token-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const key=randomBytes(32),seen=[],journal=createDnsJournal({directory,master:async()=>key,createDns:config=>{seen.push(config);return{remove:async()=>{},findOwned:async()=>[]};}});
 const settings={zoneId:'a'.repeat(32),token:'old-token'},record=await journal.intent(settings,'_acme-challenge.relay.example.test','authorization');
 await journal.created(record.marker,'b'.repeat(32));await journal.refresh({zoneId:'c'.repeat(32),token:'other-zone-token'});await journal.refresh({...settings,token:'new-valid-token'});await journal.cleanup();
 assert.equal(seen[0].zoneId,settings.zoneId);assert.equal(seen[0].token,'new-valid-token');
});
