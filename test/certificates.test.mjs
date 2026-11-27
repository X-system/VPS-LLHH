import test from'node:test';
import assert from'node:assert/strict';
import{mkdtempSync,readFileSync,rmSync}from'node:fs';
import{join}from'node:path';
import{tmpdir}from'node:os';
import{webcrypto,createPrivateKey}from'node:crypto';
import{X509CertificateGenerator,SubjectAlternativeNameExtension}from'@peculiar/x509';
import{createCertificateManager,createCloudflareDns,certificateInfo}from'../src/certificates.mjs';

async function cert(){
 const keys=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const certificate=await X509CertificateGenerator.createSelfSigned({name:'CN=relay.example.test',keys,signingAlgorithm:{name:'ECDSA',hash:'SHA-256'},notBefore:new Date(Date.now()-60000),notAfter:new Date(Date.now()+90*86400000),extensions:[new SubjectAlternativeNameExtension([{type:'dns',value:'relay.example.test'}])]},webcrypto);
 const key=createPrivateKey({key:Buffer.from(await webcrypto.subtle.exportKey('pkcs8',keys.privateKey)),format:'der',type:'pkcs8'}).export({format:'pem',type:'pkcs8'});
 return{certificate:certificate.toString('pem'),key};
}
test('CF DNS仅创建验证TXT并按本次记录ID删除，不更改A记录或清空同名记录',async()=>{
 const requests=[],zoneId='a'.repeat(32),id='b'.repeat(32),token='test-token-for-dns-only';
 const dns=createCloudflareDns({zoneId,token,fetchImpl:async(url,options)=>{requests.push({url,options});return{ok:true,json:async()=>({success:true,result:{id}})};}});
 await dns.check();assert.equal(await dns.create('_acme-challenge.relay.example.test','authorization'),id);await dns.remove(id);
 assert.ok(requests.every(request=>request.url.startsWith('https://api.cloudflare.com/client/v4/zones/'+zoneId+'/dns_records')));
 assert.equal(JSON.parse(requests[1].options.body).type,'TXT');assert.equal(requests[2].options.method,'DELETE');
 await assert.rejects(dns.remove('../dns_records'));await assert.rejects(dns.create('relay.example.test','anything'));
});
test('证书校验同时检查SAN、私钥匹配和有效期',async()=>{
 const f=await cert(),other=await cert();assert.equal(certificateInfo(f.certificate,f.key,'relay.example.test').domain,'relay.example.test');
 assert.throws(()=>certificateInfo(f.certificate,other.key,'relay.example.test'));
 assert.throws(()=>certificateInfo(f.certificate,f.key,'other.example.test'));
 assert.throws(()=>certificateInfo(f.certificate,f.key,'relay.example.test',Date.now()+100*86400000));
});
test('CF令牌加密落盘且状态不回显，签发失败仍清理本次验证记录',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-certificate-test-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const removed=[],token='mock-cf-token-private-123456';
 const fake={crypto:{createPrivateEcdsaKey:async()=>Buffer.from('mock-account'),createCsr:async()=>[Buffer.from('mock-key'),Buffer.from('mock-csr')]},directory:{letsencrypt:{production:'mock',staging:'mock-staging'}},Client:class{async auto(options){await options.challengeCreateFn({identifier:{value:'relay.example.test'}},{type:'dns-01',url:'challenge1'},'authorization');throw new Error('mock validation failure');}}};
 const manager=createCertificateManager({directory,acmeLoader:async()=>fake,fetchImpl:async(url,options)=>{if(options.method==='DELETE')removed.push(url);return{ok:true,json:async()=>({success:true,result:{id:'b'.repeat(32)}})};}});
 await manager.configure({domain:'relay.example.test',email:'test@example.test',zoneId:'a'.repeat(32),token,termsAccepted:true});
 assert.ok(!readFileSync(join(directory,'settings.enc'),'utf8').includes(token));assert.ok(!JSON.stringify(await manager.status()).includes(token));
 await manager.start();await manager.wait();assert.equal((await manager.status()).ok,false);assert.equal(removed.length,1);
});
test('完整签发以同一次版本发布证书与私钥，清理验证记录，保留自动续签配置',{skip:process.platform!=='linux'},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-certificate-test-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const f=await cert();let removed=0;
 const fake={crypto:{createPrivateEcdsaKey:async()=>Buffer.from(f.key),createCsr:async()=>[Buffer.from(f.key),Buffer.from('mock-csr')]},directory:{letsencrypt:{production:'mock',staging:'mock-staging'}},Client:class{async auto(options){const auth={identifier:{value:'relay.example.test'}},challenge={type:'dns-01',url:'challenge1'};await options.challengeCreateFn(auth,challenge,'authorization');await options.challengeRemoveFn(auth,challenge);return f.certificate;}}};
 const manager=createCertificateManager({directory,acmeLoader:async()=>fake,fetchImpl:async(url,options)=>{if(options.method==='DELETE')removed++;return{ok:true,json:async()=>({success:true,result:{id:'b'.repeat(32)}})};}});
 await manager.configure({domain:'relay.example.test',email:'test@example.test',zoneId:'a'.repeat(32),token:'mock-cf-token-private-123456',termsAccepted:true});
 await manager.start();await manager.wait();const status=await manager.status();assert.equal(status.ok,true);assert.equal(removed,1);
 certificateInfo(readFileSync(join(directory,'fullchain.pem')),readFileSync(join(directory,'privkey.pem')),'relay.example.test');
});

test('测试签发不覆盖正式续签配置或延后正式重试，并发申请只创建一个任务',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'vps-renewal-test-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));let now=1700000000000;const seen=[];
 const fake={crypto:{createPrivateEcdsaKey:async()=>Buffer.from('mock-account'),createCsr:async()=>[Buffer.from('mock-key'),Buffer.from('mock-csr')]},directory:{letsencrypt:{production:'mock-production',staging:'mock-staging'}},Client:class{constructor(options){this.url=options.directoryUrl;}async auto(){seen.push(this.url);throw new Error('simulated upstream failure');}}};
 const manager=createCertificateManager({directory,clock:()=>now,acmeLoader:async()=>fake,fetchImpl:async()=>({ok:true,json:async()=>({success:true,result:{id:'b'.repeat(32)}})})});
 const config={domain:'relay.example.test',email:'test@example.test',zoneId:'a'.repeat(32),token:'mock-cf-token-private-123456',termsAccepted:true};
 await manager.configure(config);await manager.configure({...config,staging:true});
 assert.equal((await manager.status()).autoRenewDomain,config.domain);await manager.renew();await manager.wait();assert.deepEqual(seen,['mock-production']);
 await manager.renew();assert.equal(seen.length,1);
 now+=6*3600000+1;await Promise.all([manager.start(),manager.start()]);await manager.wait();assert.deepEqual(seen,['mock-production','mock-staging']);
 await manager.renew();await manager.wait();assert.deepEqual(seen,['mock-production','mock-staging','mock-production']);
 assert.ok(!readFileSync(join(directory,'renewal.enc'),'utf8').includes(config.token));
});
