import test from'node:test';
import assert from'node:assert/strict';
import http from'node:http';
import{mkdtemp,rm,readFile}from'node:fs/promises';
import{join}from'node:path';
import{tmpdir}from'node:os';
import{webcrypto,createPrivateKey}from'node:crypto';
import{X509CertificateGenerator,SubjectAlternativeNameExtension}from'@peculiar/x509';
import{issueIpCertificate,ipCertificateInfo}from'../src/ip-certificate.mjs';
async function material(ip){const keys=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const cert=await X509CertificateGenerator.createSelfSigned({name:'CN=IP fixture',keys,signingAlgorithm:{name:'ECDSA',hash:'SHA-256'},notBefore:new Date(Date.now()-60000),notAfter:new Date(Date.now()+6*86400000),extensions:[new SubjectAlternativeNameExtension([{type:'ip',value:ip}])]},webcrypto);return{cert:cert.toString('pem'),key:createPrivateKey({key:Buffer.from(await webcrypto.subtle.exportKey('pkcs8',keys.privateKey)),format:'der',type:'pkcs8'}).export({format:'pem',type:'pkcs8'})};}
test('IP签发使用shortlived和ip标识，只提供本次HTTP验证，成功缓存、失败不覆盖证书',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'llhh-ip-cert-'));t.after(()=>rm(directory,{recursive:true,force:true}));const ip='11.0.0.2',m=await material(ip),probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));let orders=0,removed=0;const challenge={type:'http-01',token:'fixture-token-long-enough'};
 class Client{async createAccount(v){assert.equal(v.termsOfServiceAgreed,true);}async createOrder(v){orders++;assert.deepEqual(v,{identifiers:[{type:'ip',value:ip}],profile:'shortlived'});return{};}async getAuthorizations(){return[{identifier:{type:'ip',value:ip},challenges:[challenge]}];}async getChallengeKeyAuthorization(){return'fixture-authorization';}async completeChallenge(){const url='http://127.0.0.1:'+port;assert.equal(await(await fetch(url+'/.well-known/acme-challenge/'+challenge.token)).text(),'fixture-authorization');assert.equal((await fetch(url+'/')).status,404);assert.equal((await fetch(url+'/.well-known/acme-challenge/'+challenge.token,{method:'POST'})).status,404);}async waitForValidStatus(){}async finalizeOrder(){return{};}async getCertificate(){return m.cert;}}
 const acme={Client,directory:{letsencrypt:{production:'https://fixture.invalid'}},crypto:{createPrivateKey:async()=>m.key,createCsr:async v=>{assert.deepEqual(v.altNames,[ip]);return[m.key,'fixture-csr'];}}},options={ip,directory,port,acmeLoader:async()=>acme,firewall:{allowPort:async(p,proto,tag)=>{assert.equal(p,port);assert.equal(tag,'vps-panel-ip-certificate');},removeOwned:async()=>removed++}};
 assert.equal((await issueIpCertificate(options)).ip,ip);assert.equal(orders,1);assert.equal(removed,1);assert.equal((await issueIpCertificate(options)).ip,ip);assert.equal(orders,1);const old=await readFile(join(directory,'fullchain.pem'),'utf8');assert.equal(old,m.cert);assert.throws(()=>ipCertificateInfo(m.cert,m.key,'11.0.0.3'),/检查失败/);await assert.rejects(issueIpCertificate({...options,ip:'127.0.0.1'}),/公网IPv4/);
});
