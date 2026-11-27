import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { port as validatePort } from './core-config.mjs';

const execute=promisify(execFile);
function count(value){const result=typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;if(!Number.isSafeInteger(result)||result<0)throw new Error('核心返回无效流量计数');return result;}
export function normalizeHy2(traffic,online={},ids=[]){
  if(!traffic||typeof traffic!=='object'||Array.isArray(traffic))throw new Error('Hy2统计格式错误');
  if(!online||typeof online!=='object'||Array.isArray(online))throw new Error('Hy2在线统计格式错误');
  return [...new Set([...Object.keys(traffic),...Object.keys(online),...ids])].map(id=>({id,up:traffic[id]?count(traffic[id].rx??0):null,down:traffic[id]?count(traffic[id].tx??0):null,connections:count(online[id]??0)}));
}
export function normalizeXray(data,online=null,ids=[]){
  if(!data||!Array.isArray(data.stat||[]))throw new Error('Xray统计格式错误');
  const users=new Map(),seen=new Set();
  for(const row of data.stat||[]){
    const match=/^user>>>([a-f0-9-]{36})>>>traffic>>>(uplink|downlink)$/.exec(row.name||'');if(!match)continue;
    if(seen.has(row.name))throw new Error('Xray返回重复计数');seen.add(row.name);
    const user=users.get(match[1])||{id:match[1],up:0,down:0,connections:null};
    user[match[2]==='uplink'?'up':'down']=count(row.value??0);users.set(user.id,user);
  }
  if(online!==null){
    if(!online||!Array.isArray(online.users??[]))throw new Error('Xray在线格式错误');
    const active=new Set((online.users||[]).map(value=>{const match=/^user>>>([a-f0-9-]{36})>>>online$/.exec(value);if(!match)throw new Error('Xray在线身份错误');return match[1];}));
    for(const id of[...active,...ids]){
      if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Xray用户身份错误');
      if(!users.has(id))users.set(id,{id,up:null,down:null,connections:0});
    }
    for(const user of users.values())user.connections=active.has(user.id)?1:0;
  }
  return [...users.values()];
}
export async function readHy2({port,secret,ids=[]},{fetchImpl=fetch}={}){
  validatePort(port);
  if(typeof secret!=='string'||secret.length<24)throw new Error('统计密钥缺失');
  async function get(path){const response=await fetchImpl(`http://127.0.0.1:${port}/${path}`,{headers:{Authorization:secret},signal:AbortSignal.timeout(3000),redirect:'error'});if(!response.ok)throw new Error('Hy2统计接口不可用');return response.json();}
  const[traffic,online]=await Promise.all([get('traffic'),get('online')]);return normalizeHy2(traffic,online,ids);
}
export async function kickHy2({port,secret},ids,{fetchImpl=fetch}={}){
  validatePort(port);if(!Array.isArray(ids)||!ids.length||ids.some(id=>!/^[a-f0-9-]{36}$/.test(id)))throw new Error('撤销用户列表不正确');
  const response=await fetchImpl(`http://127.0.0.1:${port}/kick`,{method:'POST',headers:{Authorization:secret,'Content-Type':'application/json'},body:JSON.stringify(ids),redirect:'error',signal:AbortSignal.timeout(3000)});
  if(!response.ok)throw new Error('Hy2未完成连接撤销');return{ok:true};
}
export async function readXray({port,binary='/usr/local/lib/vps-panel/xray',ids=[]},{runner=execute}={}){
  validatePort(port);const options={timeout:5000,maxBuffer:4*1024*1024,windowsHide:true};
  const[result,online]=await Promise.all([
    runner(binary,['api','statsquery',`--server=127.0.0.1:${port}`,'-pattern','user>>>'],options),
    runner(binary,['api','statsgetallonlineusers',`--server=127.0.0.1:${port}`],options)
  ]);
  return normalizeXray(JSON.parse(result.stdout),JSON.parse(online.stdout),ids);
}
export function ingestSnapshot(store,{stream,epoch,samples}){
  if(!/^(hy2|vmess)\.(att|direct)$/.test(stream)||typeof epoch!=='string'||!epoch||epoch.length>128||!Array.isArray(samples))throw new Error('采集周期格式错误');
  return store.transaction(()=>{
  const users=new Set(store.db.prepare('SELECT id FROM users').all().map(user=>user.id));
  const state=store.get('live-traffic')||{},now=store.clock();
  const seen=new Set();
  // Validate the whole response before applying any user's counters.
  for(const sample of samples){
    if(!sample||typeof sample.id!=='string'||seen.has(sample.id))throw new Error('采集包含重复或无效用户');
    seen.add(sample.id);
    if(sample.up!==null||sample.down!==null){count(sample.up);count(sample.down);}
    if(sample.connections!==null)count(sample.connections);
    if(!users.has(sample.id)||sample.up===null)continue;
    const prior=store.db.prepare('SELECT * FROM traffic WHERE user_id=? AND stream=?').get(sample.id,stream);
    if(prior?.epoch===epoch&&(sample.up<prior.up||sample.down<prior.down))throw new Error('同一核心周期的计数不应倒退');
    const total=store.db.prepare('SELECT up,down FROM totals WHERE user_id=?').get(sample.id)||{up:0,down:0};
    const up=sample.up-(prior?.epoch===epoch?prior.up:0),down=sample.down-(prior?.epoch===epoch?prior.down:0);
    if(![total.up+up,total.down+down,total.up+up+total.down+down].every(Number.isSafeInteger))throw new Error('累计流量超出精确计数范围');
  }
  for(const sample of samples){
    if(!users.has(sample.id))continue;
    if(sample.connections>0)store.db.prepare('INSERT INTO user_presence VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET seen=excluded.seen').run(sample.id,now);
    state[sample.id]??={};
    if(sample.up===null){
      state[sample.id][stream]={at:now,connections:sample.connections,up:null,down:null};
      continue;
    }
    const prior=store.db.prepare('SELECT * FROM traffic WHERE user_id=? AND stream=?').get(sample.id,stream);
    const delta=store.applyTraffic({userId:sample.id,stream,epoch,up:sample.up,down:sample.down});
    const duration=prior&&prior.epoch===epoch&&now>prior.at&&now-prior.at<=60000?(now-prior.at)/1000:null;
    state[sample.id][stream]={at:now,connections:sample.connections,up:duration?delta.up/duration:null,down:duration?delta.down/duration:null};
  }
  store.set('live-traffic',state);
  });
}
