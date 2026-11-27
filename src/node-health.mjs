import net from'node:net';
import{performance}from'node:perf_hooks';
const fresh=(record,now,ttl=25000)=>!!record&&Number.isFinite(record.at)&&record.at<=now&&now-record.at<=ttl;
export function publicProbeIPv4(address){if(net.isIP(address)!==4)return false;const[a,b]=address.split('.').map(Number);return a!==0&&a!==10&&a!==127&&a<224&&!(a===100&&b>=64&&b<=127)&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&[0,168].includes(b))&&!(a===198&&[18,19].includes(b));}
export function tcpConnect(address,port,{timeoutMs=2500,signal}={}){return new Promise(resolve=>{const started=performance.now();let done=false;const socket=net.createConnection({host:address,port});const finish=ok=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);socket.destroy();resolve({ok,ms:ok?Math.round((performance.now()-started)*10)/10:null});};const abort=()=>finish(false),timer=setTimeout(abort,timeoutMs);socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});});}
function cleanSystem(s){if(!s||!s.profiles||typeof s.network?.up!=='boolean'||typeof s.network?.configured!=='boolean'||!['hy2.att','hy2.direct','vmess.att','vmess.direct'].every(id=>typeof s.profiles[id]?.active==='boolean'))throw new Error('服务状态不完整');return{profiles:Object.fromEntries(['vmess.att','vmess.direct','hy2.att','hy2.direct'].map(id=>[id,{active:s.profiles?.[id]?.active===true,state:String(s.profiles?.[id]?.state||'unknown').slice(0,24)}])),desired:Object.fromEntries(['vmess.att','vmess.direct','hy2.att','hy2.direct'].map(id=>[id,s.desired?.[id]===true])),emergencyStop:!!s.emergencyStop,guardPresent:typeof s.guardPresent==='boolean'?s.guardPresent:null,networkDesired:!!s.networkDesired,network:{configured:!!s.network?.configured,up:!!s.network?.up,protected:typeof s.network?.protected==='boolean'?s.network.protected:null,peers:(s.network?.peers||[]).map(p=>({handshakeAt:Number.isSafeInteger(p.handshakeAt)?p.handshakeAt:null}))},certificate:{notAfter:Number.isFinite(s.certificate?.notAfter)?s.certificate.notAfter:null,ok:s.certificate?.ok!==false}};}
export function createNodeHealth({store,request,localProbe=tcpConnect,enabled=true,intervalMs=15000}){
 let busy=null,closed=false,again=false;
 async function work(){
  const now=store.clock();let system;
  if(request)try{const data=cleanSystem(await request('status',{}, {timeout:8000}));system={at:store.clock(),ok:true,...data};store.set('health-system',system);}catch{store.set('health-system',{at:store.clock(),ok:false});}
  if(closed)return;
  if(system&&Object.entries(system.profiles).some(([id,p])=>id.startsWith('hy2')&&(p.active||system.desired[id]))){const result=await localProbe('127.0.0.1',18444);if(!closed)store.set('health-auth',{at:store.clock(),ok:result.ok});}

 }
 function sample(force=false){if(closed||!enabled)return Promise.resolve();if(busy){again ||= force;return busy;}busy=work().catch(()=>{}).finally(()=>{busy=null;if(again&&!closed){again=false;sample();}});return busy;}
 let timer;if(enabled){timer=setInterval(sample,intervalMs);timer.unref();sample();}
 return{sample,view:()=>nodeHealth(store,{managed:!!request}),async close(){closed=true;clearInterval(timer);await busy;}};
}
export function nodeHealth(store,{managed=true}={}){
 const now=store.clock(),source=store.get('health-system'),system=fresh(source,now,40000)&&source.ok?source:null,role=store.get('settings').role,relay=role!=='exit',worker=store.get('worker-health'),host=store.get('host-telemetry'),runtime=store.get('runtime')||{},rows=[];
 const add=(id,name,state,status,detail,{critical=false,affects=true}={})=>rows.push({id,name,state,status,detail,critical,affects});
 add('web','面板接口','green','正常响应','当前网页已取得管理后台的实际响应。');
 add('agent','系统管理器',!managed?'grey':system?'green':source?'red':'grey',!managed?'未接入':system?'正常':source?'响应异常':'正在检查',!managed?'开发预览未接入系统管理器，不代表正式服务器运行状态。':system?'可以读取本机服务状态；监控只读，不会启动或重启任何服务。':'尚未取得有效服务状态，不能据此认定代理已经停止。',{critical:true,affects:managed&&!!source});
 add('worker','数据采集与上报',fresh(worker,now)&&worker.ok?'green':managed?'red':'grey',fresh(worker,now)&&worker.ok?'正常':worker?'上报异常':'等待数据','本机统计后台约每5秒更新；超过25秒未更新视为异常。这里不是总控上报。',{critical:true,affects:managed});
 add('telemetry','服务器资源采集',fresh(host,now)?'green':managed?'yellow':'grey',fresh(host,now)?'正常':'暂无新数据','CPU、内存、磁盘和网卡采样，缺少采样不补造正常状态。',{affects:managed});
 const ids=['hy2.att','hy2.direct','vmess.att','vmess.direct'],known=!!system,blocked=runtime.emergencyStop||system?.emergencyStop||runtime.maintenance,active=known?(relay?ids.filter(id=>system.profiles[id].active):system.network.up?[true]:[]):[],attNeeded=known&&(relay?ids.some(id=>id.endsWith('att')&&(system.profiles[id].active||system.desired[id])):system.networkDesired||system.network.up);
 if(relay)for(const id of ids){const p=system?.profiles[id],wanted=system?.desired[id],transition=['activating','deactivating','reloading'].includes(p?.state),name=(id.startsWith('hy2')?'Hy2':'TCP')+' · '+(id.endsWith('att')?'经出口机':'本机直出');add('line-'+id,name,!known?'grey':p.active?'green':transition?'yellow':wanted&&!blocked?'red':'black',!known?'尚未确认':p.active?'运行中':transition?'正在切换':wanted&&!blocked?'启动失败':blocked?'已主动关闭':'未启用',!known?'尚未取得服务状态。':p.active?'进程正在运行；完整业务可达性还需结合隧道、认证与客户端实测。':wanted&&!blocked?'已要求运行，但进程没有正常启动，请查看线路日志。':'未运行的备用线路不算故障；全部业务线路关闭时，总灯显示黑色。',{critical:true,affects:known&&(p.active||wanted&&!blocked)});}
 const net=system?.network;add('wg','WG 加密隧道',!known?'grey':!net.configured?(attNeeded?'red':'grey'):!net.up?(attNeeded?'red':'black'):net.protected!==true?(net.protected===false&&attNeeded?'red':'yellow'):'green',!known?'尚未确认':!net.configured?(attNeeded?'缺少隧道配置':'未配置'):!net.up?(attNeeded?'隧道不可用':'已关闭'):net.protected===false?'保护异常':net.protected===null?'保护尚未确认':'接口运行中','检查本机隧道接口与路由保护；接口存在不等于已完成端到端通信。',{critical:true,affects:known&&(attNeeded||net.configured&&net.up)});
 if(known&&net.up){const peers=net.peers||[],recent=peers.filter(p=>p.handshakeAt&&p.handshakeAt<=now&&now-p.handshakeAt<=180000).length;add('handshake','隧道对端握手',recent===peers.length&&peers.length?'green':recent?'yellow':attNeeded?'red':'yellow',`${recent}/${peers.length} 台近期有握手`,'以最近3分钟的WireGuard握手为准；无近期握手需要检查对端，握手正常也不等于网站访问一定正常。',{critical:attNeeded,affects:true});}
 if(relay){const on=known&&active.length>0;add('guard','用户与出口保护',!known?'grey':!on?'black':system.guardPresent===true?'green':system.guardPresent===false?'red':'yellow',!on?'暂无运行线路':system.guardPresent===true?'保护正常':system.guardPresent===false?'保护规则异常':'尚未确认','检查本程序的访问限制与断线保护规则。发现异常只展示状态，不擅自修改防火墙。',{critical:true,affects:on});
  const hy2=known&&ids.some(id=>id.startsWith('hy2')&&system.profiles[id].active),auth=store.get('health-auth');add('auth','Hy2 用户认证',!hy2?'grey':fresh(auth,now,40000)?(auth.ok?'green':'red'):'yellow',!hy2?'当前不需要':fresh(auth,now,40000)?(auth.ok?'认证端口可连接':'认证端口异常'):'认证状态待确认','只检查本机认证监听端口，不携带用户密码，也不模拟登录。',{critical:true,affects:hy2});
  const running=known?ids.filter(id=>system.profiles[id].active):[],bad=running.filter(id=>{const h=store.get('collector-health.'+id);return !fresh(h,now)||!h.ok;}),quota=!!store.db.prepare('SELECT 1 FROM users WHERE enabled=1 AND quota IS NOT NULL LIMIT 1').get();add('meter','用户流量统计',!running.length?'grey':!bad.length?'green':quota?'red':'yellow',!running.length?'暂无运行线路':!bad.length?'正常':`${bad.length} 条线路缺少统计`,'只检查运行中的线路。存在流量限制时，统计异常按关键故障显示。',{critical:quota,affects:running.length>0});
  const expires=system?.certificate.notAfter;if(hy2)add('certificate','Hy2 域名证书',!expires?'yellow':expires<=now?'red':!system.certificate.ok||expires-now<7*86400000?'yellow':'green',!expires?'有效期尚未确认':expires<=now?'证书已过期':!system.certificate.ok?'最近签发或续签失败':expires-now<7*86400000?'即将到期':'证书有效','检查服务证书的有效期；不把域名或证书当成防封保证。',{critical:true});
 }

 if(fresh(host,now))for(const[key,name,threshold]of[['cpuPercent','CPU 使用',95],['memoryPercent','内存使用',92],['diskPercent','磁盘使用',90]])if(Number.isFinite(host[key]))add('resource-'+key,name,host[key]>=threshold?'yellow':'green',host[key].toFixed(1)+'%',`达到${threshold}%时提醒关注；瞬间占用不等于服务已经停止。`);
 add('controller','总控通信','grey','未接入','当前由本机独立管理，总控功能暂未开放，此项不计为故障。',{affects:false});
 let stoppedReason='全部业务线路当前已关闭，请结合日志确认停止原因。';
 const lastStop=store.db.prepare("SELECT event,detail FROM audit WHERE event IN ('执行服务操作','保护规则无法恢复，已停止全部线路','额度线路统计失效，已停止受影响线路','保存WG配对并保持停止','保存代理线路并保持停止') ORDER BY id DESC LIMIT 1").get();
 let lastAction;try{lastAction=JSON.parse(lastStop?.detail||'{}').action;}catch{}
 if(runtime.emergencyStop||system?.emergencyStop)stoppedReason='急停已锁定，全部业务线路已关闭；管理页面仍可使用。';
 else if(lastStop&&/保护规则无法恢复|统计失效/.test(lastStop.event))stoppedReason='检测到故障保护停机，全部业务线路已停止，请查看日志。';
 else if(known&&(relay?ids.some(id=>system.desired[id]):system.networkDesired)&&!blocked)stoppedReason='已要求提供服务，但当前没有业务线路正常运行，请检查故障项。';
 else if(['stop','stop-all','network-down','emergency-stop'].includes(lastAction))stoppedReason='已通过面板主动关闭全部业务线路；管理页面仍可使用。';
 else if(lastStop&&/保存WG配对|保存代理线路/.test(lastStop.event))stoppedReason='线路配置已保存，业务服务按要求保持关闭，需要手动启动。';
 const businessCount=known?(relay?active.filter(id=>!id.endsWith('att')||system.network.up).length:active.length):0;if(known&&relay&&active.length&&!businessCount&&!system.network.up)stoppedReason='所有运行中的线路都依赖WG隧道；当前隧道不可用，业务线路无法通行。';
 const failures=rows.filter(r=>r.affects&&r.state==='red'),warnings=rows.filter(r=>r.affects&&r.state==='yellow');let state=!managed?'grey':!system?(source?'red':'yellow'):!businessCount?'black':failures.length?'red':warnings.length?'yellow':'green';
 if(known&&relay&&active.length&&system.guardPresent!==true&&state==='black')state='red';
 return{at:now,observedAt:source?.at||null,state,label:state==='green'?'服务正常':state==='yellow'?'部分项目需关注':state==='red'?'关键项目异常':state==='black'?'业务服务不可用':'尚未接入检测',reason:state==='black'?stoppedReason:state==='red'?failures.map(r=>r.name).join('、')||'无法确认关键服务状态':state==='yellow'?warnings.map(r=>r.name).join('、')||'正在取得服务状态':'未启用项目不参与判定。',rows,readOnly:true};
}
