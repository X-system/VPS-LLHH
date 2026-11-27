import{generateKeyPairSync}from'node:crypto';
import{createRequire}from'node:module';
const forge=createRequire(import.meta.url)('node-forge');
export function certificate(){
 const pair=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}}),cert=forge.pki.createCertificate();
 cert.publicKey=forge.pki.publicKeyFromPem(pair.publicKey);cert.serialNumber='01';cert.validity.notBefore=new Date(Date.now()-60000);cert.validity.notAfter=new Date(Date.now()+86400000);const attrs=[{name:'commonName',value:'localhost'}];cert.setSubject(attrs);cert.setIssuer(attrs);cert.setExtensions([{name:'subjectAltName',altNames:[{type:2,value:'localhost'},{type:7,ip:'127.0.0.1'}]}]);cert.sign(forge.pki.privateKeyFromPem(pair.privateKey),forge.md.sha256.create());return{cert:forge.pki.certificateToPem(cert),key:pair.privateKey};
}
