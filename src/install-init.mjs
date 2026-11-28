import{writeFileSync,existsSync}from'node:fs';
import{resolve,join}from'node:path';
import{openStore}from'./store.mjs';
import{token,digest}from'./security.mjs';
import{resumeSetup}from'./onboarding.mjs';
const directory=resolve(process.env.VPS_DATA_DIR||'/var/lib/vps-panel');
const restore=process.argv.includes('--restore');
const roleIndex=process.argv.indexOf('--role'),role=roleIndex<0?'relay':process.argv[roleIndex+1];
if(!['relay','exit'].includes(role))throw new Error('安装角色必须为中转端或出口端');
if(existsSync(join(directory,'panel.sqlite'))&&!restore)throw new Error('禁止覆盖已有数据');
const store=await openStore({directory});
if(restore){
 store.set('runtime',{maintenance:true,emergencyStop:true});
 for(const key of['relay-config','relay-pending','network-config','auth-services','access-applied','service-status','live-traffic'])store.set(key,null);
 const encoded=store.get('role-archives');if(encoded){const archives=JSON.parse(store.unseal(encoded));for(const snapshot of Object.values(archives))snapshot.config={};store.set('role-archives',store.seal(JSON.stringify(archives)));}
 store.audit('恢复安装，保留账户及统计并要求重新确认配对');
 resumeSetup(store);
}else{
 store.set('settings',{...store.get('settings'),role,uiVersion:2});
 store.set('onboarding',{version:2,step:'welcome',welcome:true,completed:[],draft:{}});
 const setupToken=token();store.set('bootstrap-access',{hash:digest(setupToken),expires:store.clock()+24*3600000});
 writeFileSync(join(directory,'.bootstrap.json'),JSON.stringify({setupToken}),{mode:0o600,flag:'wx'});
}
console.log(JSON.stringify({role:store.get('settings').role,restored:restore}));
store.close();
