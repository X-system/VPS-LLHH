import { DatabaseSync } from 'node:sqlite';
import { existsSync, unlinkSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { openStore } from './store.mjs';
import { token,hashPassword } from './security.mjs';
import { agentRequest } from './agent-client.mjs';
import { serviceAction } from './deployment.mjs';

const directory=resolve(process.env.VPS_DATA_DIR||'data');
if(!existsSync(join(directory,'panel.sqlite')))throw new Error('面板尚未初始化');
const action=process.argv[2]||'status';
if(action==='address'||action==='status'){
  const db=new DatabaseSync(join(directory,'panel.sqlite'),{readOnly:true});
  const get=key=>JSON.parse(db.prepare('SELECT value FROM config WHERE key=?').get(key).value);
  if(action==='address')console.log(`${process.env.VPS_ORIGIN||`http://127.0.0.1:${process.env.VPS_PORT||18443}`}/${get('entrance').value}/`);
  else{
   let system=null;try{const result=await agentRequest('status');system={profiles:result.profiles,network:result.network,emergencyStop:result.emergencyStop};}catch{}
   console.log(JSON.stringify({serverName:get('settings').serverName,role:get('settings').role,runtime:get('runtime'),system,systemAgentAvailable:!!system},null,2));
  }
  db.close();
}else if(action==='reset-entry'||action==='reset-password'){
  const store=await openStore({directory});
  try{
    if(action==='reset-entry'){
      const entrance=store.rotateEntrance();
      console.log(`新入口：${process.env.VPS_ORIGIN||`http://127.0.0.1:${process.env.VPS_PORT||18443}`}/${entrance.value}/`);
    }else{
      const password=token().slice(0,24),hash=await hashPassword(password);
      store.transaction(()=>{store.db.prepare('UPDATE admin SET username=?,password=? WHERE id=1').run('admin',hash);store.db.exec('DELETE FROM sessions');store.set('bootstrap-access',null);store.audit('通过SSH应急命令重置管理员凭证');});
      if(existsSync(join(directory,'.bootstrap.json')))unlinkSync(join(directory,'.bootstrap.json'));
      console.log(`管理员：admin\n新密码：${password}\n所有原有会话已注销。`);
    }
  }finally{store.close();}
}else if(['stop-all','emergency-stop','release-emergency'].includes(action)){
 const store=await openStore({directory});
 try{console.log(JSON.stringify(await serviceAction(store,{action,confirmed:true},agentRequest),null,2));}finally{store.close();}
}else if(['check-update','update','rollback','uninstall-keep','uninstall-purge'].includes(action)){
 const mapping={'check-update':'update-status',update:'update-start',rollback:'update-rollback','uninstall-keep':'uninstall','uninstall-purge':'uninstall'};
 console.log(JSON.stringify(await agentRequest(mapping[action],{check:true,confirmed:true,purgeData:action==='uninstall-purge'}),null,2));
}else{
  console.error('支持命令：status | address | reset-entry | reset-password | stop-all | emergency-stop | release-emergency');process.exitCode=1;
}
