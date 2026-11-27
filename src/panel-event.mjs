import{openStore}from'./store.mjs';
import{barkStatus,enqueueEvent}from'./bark.mjs';

const origin=new URL(process.argv[2]);if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.username||origin.password)throw new Error('管理地址错误');
const store=await openStore({directory:'/var/lib/vps-panel'});
try{
 const encrypted=barkStatus(store).encrypted;
 enqueueEvent(store,'panel.changed',{origin:origin.origin,body:`管理连接已更改为${origin.origin}，原安全入口不变。`,...(encrypted?{url:new URL('/'+store.get('entrance').value+'/',origin).href}:{})},{cooldown:0});
 store.audit('管理连接通过HTTPS自检',{port:Number(origin.port)||443});
}finally{store.close();}
