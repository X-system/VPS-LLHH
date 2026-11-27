import { isIP } from 'node:net';
import { HttpError } from './validation.mjs';
import{allowsLine}from'./line-permissions.mjs';

function requireValue(condition,message){if(!condition)throw new HttpError(400,message);}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function interfaceName(value){requireValue(typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,14}$/.test(value),'网卡名称格式错误');return value;}
export function publicKey(value){requireValue(typeof value==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(value)&&Buffer.from(value,'base64').length===32,'WireGuard公钥格式错误');return value;}
export function port(value){requireValue(Number.isInteger(value)&&value>=1&&value<=65535,'端口必须在1至65535之间');return value;}
export function validateRelay(input){
  requireValue(input&&typeof input==='object','线路配置错误');
  requireValue(isIP(input.publicIPv4)===4,'本机公网IPv4错误');
  const enabled=input.enabledProtocols??['vmess','hy2'];
  requireValue(Array.isArray(enabled)&&enabled.length>0&&new Set(enabled).size===enabled.length&&enabled.every(value=>['vmess','hy2'].includes(value)),'请选择支持的协议');
  requireValue(input.attEnabled===undefined||typeof input.attEnabled==='boolean','出口连接设置错误');
  requireValue(typeof input.domain==='string'&&input.domain.length<=253&&(/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(input.domain)||!enabled.includes('hy2')&&isIP(input.domain)===4),'Hy2需要有效域名；TCP可以使用公网IPv4');
  const physical=interfaceName(input.physicalInterface),wg=interfaceName(input.wireguardInterface||'vps-wg');
  requireValue(physical!==wg,'物理网卡不能与隧道重名');
  if(input.attEnabled!==false){requireValue(isIP(input.endpointIPv4)===4,'出口IP格式错误');port(input.endpointPort);publicKey(input.endpointPublicKey);}
  requireValue(input.ports&&input.uids&&input.stats,'缺少端口或服务身份配置');
  const taken=new Set();
  for(const protocol of ['vmess','hy2'])for(const exit of ['att','direct']){
    const value=port(input.ports[protocol]?.[exit]);
    const name=protocol+'.'+exit;
    // Separate TCP and UDP can use the same numeric port; same-transport listeners cannot.
    const binding=protocol+':'+value;requireValue(!taken.has(binding),'同一协议端口重复');taken.add(binding);
    const uid=input.uids[name];requireValue(Number.isInteger(uid)&&uid>=100&&uid<=60000,'服务UID格式错误');
    port(input.stats[name]?.port);
    if(protocol==='hy2')requireValue(typeof input.stats[name].secret==='string'&&/^[A-Za-z0-9_-]{24,128}$/.test(input.stats[name].secret),'统计接口密钥格式错误');
  }
  requireValue(new Set(Object.values(input.uids)).size===4,'四个服务必须使用独立UID');
  if(input.controlUid!==undefined)requireValue(Number.isInteger(input.controlUid)&&input.controlUid>=100&&input.controlUid<=60000&&!Object.values(input.uids).includes(input.controlUid),'管理服务UID错误');
  const statsPorts=Object.values(input.stats).map(item=>item.port);
  requireValue(new Set(statsPorts).size===4,'统计接口端口不能重复');
  requireValue(!statsPorts.some(value=>Object.values(input.ports).some(group=>Object.values(group).includes(value))),'统计端口不能与公网入口冲突');
  if(input.authServices){
    port(input.authServices.port);
    requireValue(!statsPorts.includes(input.authServices.port)&&!Object.values(input.ports).some(group=>Object.values(group).includes(input.authServices.port)),'认证端口冲突');
    for(const exit of['att','direct'])requireValue(/^[A-Za-z0-9_-]{32,128}$/.test(input.authServices.secrets?.['hy2.'+exit]||''),'认证服务密钥格式错误');
  }
  return {...input,domain:input.domain.toLowerCase(),physicalInterface:physical,wireguardInterface:wg};
}

export function buildRelayConfigs(raw,users,now=Date.now()){
  const config=validateRelay(raw),result={};
  for(const protocol of ['vmess','hy2'])for(const exit of ['att','direct']){
    const name=protocol+'.'+exit;
    const selected=users.filter(user=>(!config.enabledProtocols||config.enabledProtocols.includes(protocol))&&(exit!=='att'||config.attEnabled!==false)&&user.enabled&&(!user.expires||user.expires>now)&&(user.quota===null||user.quota===undefined||(user.up||0)+(user.down||0)<user.quota)&&allowsLine(user,name));
    for(const user of selected){requireValue(uuid.test(user.id),'用户ID错误');requireValue(uuid.test(user.credentials.vmess),'VMess UUID错误');requireValue(/^[A-Za-z0-9_-]{24,128}$/.test(user.credentials.hy2),'Hy2凭证错误');}
    const device=exit==='att'?config.wireguardInterface:config.physicalInterface;
    const stats=config.stats[name];
    if(protocol==='hy2'){
      result[name]={listen:`0.0.0.0:${config.ports.hy2[exit]}`,tls:{cert:'/etc/vps-panel/certs/fullchain.pem',key:'/etc/vps-panel/certs/privkey.pem',sniGuard:'strict'},
        auth:config.authServices?{type:'http',http:{url:`http://127.0.0.1:${config.authServices.port}/hy2/${exit}/${config.authServices.secrets['hy2.'+exit]}`,insecure:false}}:{type:'userpass',userpass:Object.fromEntries(selected.map(user=>[user.id,user.credentials.hy2]))},
        ignoreClientBandwidth:true,resolver:{type:'udp',udp:{addr:'1.1.1.1:53',timeout:'4s'}},
        outbounds:[{name:'default',type:'direct',direct:{mode:'4',bindDevice:device}}],
        acl:{inline:['reject(0.0.0.0/8)','reject(127.0.0.0/8)','reject(10.0.0.0/8)','reject(100.64.0.0/10)','reject(172.16.0.0/12)','reject(192.168.0.0/16)','reject(169.254.0.0/16)','reject(198.18.0.0/15)','reject(224.0.0.0/3)','reject(::1/128)','reject(fc00::/7)','reject(fe80::/10)','default(all)']},
        trafficStats:{listen:`127.0.0.1:${stats.port}`,secret:stats.secret},masquerade:{type:'file',file:{dir:'/usr/local/lib/vps-panel/site'}}};
    }else{
      result[name]={log:{loglevel:'warning'},stats:{},api:{tag:'api',services:['HandlerService','StatsService']},
        policy:{levels:{'0':{statsUserUplink:true,statsUserDownlink:true,statsUserOnline:true}},system:{statsInboundUplink:true,statsInboundDownlink:true}},
        dns:{servers:['1.1.1.1'],queryStrategy:'UseIPv4'},
        inbounds:[{tag:'proxy',listen:'0.0.0.0',port:config.ports.vmess[exit],protocol:'vmess',settings:{clients:selected.map(user=>({id:user.credentials.vmess,email:user.id,alterId:0,level:0})),disableInsecureEncryption:true},streamSettings:{network:'tcp',security:'none'}},
          {tag:'api-in',listen:'127.0.0.1',port:stats.port,protocol:'dokodemo-door',settings:{address:'127.0.0.1'}}],
        outbounds:[{tag:'default',protocol:'freedom',settings:{domainStrategy:'UseIPv4'},streamSettings:{sockopt:{interface:device}}},{tag:'block',protocol:'blackhole'}],
        routing:{rules:[{type:'field',inboundTag:['api-in'],outboundTag:'api'},{type:'field',ip:['0.0.0.0/8','127.0.0.0/8','10.0.0.0/8','100.64.0.0/10','172.16.0.0/12','192.168.0.0/16','169.254.0.0/16','198.18.0.0/15','224.0.0.0/3','::/0'],outboundTag:'block'}]}};
    }
  }
  return result;
}

export function buildFailClosed(raw,{panelPort}={}){
  const config=validateRelay(raw);
  if(panelPort!==undefined){
    port(panelPort);
    requireValue(![...Object.values(config.stats).map(value=>value.port),config.authServices?.port,...Object.values(config.ports).flatMap(value=>Object.values(value))].includes(panelPort),'管理端口不能与协议或内部接口重叠');
  }
  return `table inet vps_panel_guard {
 chain reply_route {
  type route hook output priority mangle; policy accept;
${['vmess','hy2'].map(protocol=>`  meta skuid ${config.uids[protocol+'.att']} ct direction reply ${protocol==='vmess'?'tcp':'udp'} sport ${config.ports[protocol].att} meta mark set 51821`).join('\n')}
 }
 chain output {
  type filter hook output priority -5; policy accept;
  oifname "lo" ip daddr 127.0.0.1 ct direction original tcp dport { ${Object.values(config.stats).map(stats=>stats.port).join(', ')} } meta skuid { ${[0,...(config.controlUid===undefined?[]:[config.controlUid])].join(', ')} } accept
  oifname "lo" ip daddr 127.0.0.1 ct direction original tcp dport { ${Object.values(config.stats).map(stats=>stats.port).join(', ')} } counter reject
${config.authServices?`  oifname "lo" ip daddr 127.0.0.1 ct direction original tcp dport ${config.authServices.port} meta skuid { ${[0,...(config.controlUid===undefined?[]:[config.controlUid]),...Object.values(config.uids)].join(', ')} } accept\n  oifname "lo" ip daddr 127.0.0.1 ct direction original tcp dport ${config.authServices.port} counter reject`:''}
${config.attEnabled===false?'':`  meta mark 51820 oifname "${config.physicalInterface}" ip daddr ${config.endpointIPv4} udp dport ${config.endpointPort} accept`}
${['vmess','hy2'].flatMap(protocol=>['att','direct'].map(exit=>{
  const uid=config.uids[protocol+'.'+exit],transport=protocol==='vmess'?'tcp':'udp',listen=config.ports[protocol][exit];
  const auth=protocol==='hy2'&&config.authServices?`  meta skuid ${uid} oifname "lo" ip daddr 127.0.0.1 tcp dport ${config.authServices.port} accept\n`:'';
  // Only direct profiles may reach this host's public management listener locally.
  // FIB lookup follows assigned addresses without trusting a stale configured public IP.
  const panel=exit==='direct'&&panelPort!==undefined?`  meta skuid ${uid} oifname "lo" fib daddr type local ct direction original tcp dport ${panelPort} accept\n`:'';
  return `${auth}  meta skuid ${uid} oifname "lo" ct direction reply tcp sport ${config.stats[protocol+'.'+exit].port} accept\n  meta skuid ${uid} ct direction reply ${transport} sport ${listen} accept\n  meta skuid ${uid} meta nfproto ipv6 counter reject\n  meta skuid ${uid} ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/3 } counter reject\n${panel}  meta skuid ${uid} oifname "${exit==='att'?config.wireguardInterface:config.physicalInterface}" accept\n  meta skuid ${uid} counter reject`;
})).join('\n')}
 }
}
`;
}

export function clientLinks(raw,user,{names={},states={},serverName='服务器'}={}){
  const config=validateRelay(raw),links=[];
  if(user.protocols.some(value=>!['vmess','hy2'].includes(value))||user.exits.some(value=>!['att','direct'].includes(value)))throw new HttpError(400,'协议或出口错误');
  for(const protocol of ['vmess','hy2'])for(const exit of ['att','direct']){
    const id=protocol+'.'+exit;if(!allowsLine(user,id))continue;
    const base=names[id]||`${serverName} · ${protocol==='hy2'?'Hy2':'TCP'} · ${exit==='att'?'ATT':'直出'}`;
    const label=base+(states[id]==='unavailable'?' | 当前不可用':states[id]==='unknown'?' | 状态待确认':'');
    if(protocol==='hy2')links.push({protocol,exit,url:`hysteria2://${encodeURIComponent(user.credentials.hy2LegacyAuth===true?user.credentials.hy2:user.id+':'+user.credentials.hy2)}@${config.domain}:${config.ports.hy2[exit]}/?sni=${encodeURIComponent(config.domain)}&insecure=0#${encodeURIComponent(label)}`});
    else links.push({protocol,exit,url:'vmess://'+Buffer.from(JSON.stringify({v:'2',ps:label,add:config.domain,port:String(config.ports.vmess[exit]),id:user.credentials.vmess,aid:'0',scy:'auto',net:'tcp',type:'none',host:'',path:'',tls:''})).toString('base64')});
  }
  return links;
}
