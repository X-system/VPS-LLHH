import{generateKeyPairSync,createPrivateKey,createPublicKey}from'node:crypto';
import{isIP}from'node:net';
import{interfaceName,publicKey,port}from'./core-config.mjs';

function check(value,message){if(!value)throw new Error(message);}
export function wgKeys(){
 const pair=generateKeyPairSync('x25519');
 return{privateKey:pair.privateKey.export({format:'der',type:'pkcs8'}).subarray(-32).toString('base64'),publicKey:pair.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64')};
}
export function wgPublic(privateKey){
 publicKey(privateKey);
 const key=createPrivateKey({format:'der',type:'pkcs8',key:Buffer.concat([Buffer.from('302e020100300506032b656e04220420','hex'),Buffer.from(privateKey,'base64')])});
 return createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32).toString('base64');
}
export function tunnelAddress(value){
 check(typeof value==='string'&&/^10\.76\.0\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/.test(value),'隧道地址必须属于10.76.0.1至254');return value;
}
export function validateNetwork(raw){
 check(raw&&['relay','exit'].includes(raw.role),'服务器角色错误');
 const value={role:raw.role,physicalInterface:interfaceName(raw.physicalInterface),wireguardInterface:interfaceName(raw.wireguardInterface||'vps-wg'),privateKey:publicKey(raw.privateKey),listenPort:port(raw.listenPort),address:tunnelAddress(raw.address),peers:[]};
 check(value.physicalInterface!==value.wireguardInterface,'隧道不能覆盖物理网卡');
 check(Array.isArray(raw.peers)&&raw.peers.length<=253,'配对列表错误');
 check(raw.role!=='relay'||raw.peers.length===1,'中转机必须配对一个出口');
 const keys=new Set(),addresses=new Set([value.address]);
 for(const peer of raw.peers){
  const item={publicKey:publicKey(peer.publicKey),address:tunnelAddress(peer.address)};
  if(peer.name!==undefined){check(typeof peer.name==='string'&&peer.name.length<=48&&!/[\x00-\x1f\x7f]/.test(peer.name),'配对名称格式错误');item.name=peer.name.trim();}
  check(!keys.has(item.publicKey)&&!addresses.has(item.address),'配对公钥或地址重复');keys.add(item.publicKey);addresses.add(item.address);
  if(raw.role==='relay'){
   check(isIP(peer.endpointIPv4)===4,'出口公网IPv4错误');item.endpointIPv4=peer.endpointIPv4;item.endpointPort=port(peer.endpointPort);
  }
  value.peers.push(item);
 }
 if(raw.role==='relay'){
  check(Array.isArray(raw.uids)&&raw.uids.length===2&&new Set(raw.uids).size===2&&raw.uids.every(uid=>Number.isInteger(uid)&&uid>=100&&uid<=60000),'隧道线路UID错误');
  value.uids=raw.uids;
 }
 return value;
}
export function wgConfig(raw){
 const config=validateNetwork(raw);
 return `[Interface]\nPrivateKey = ${config.privateKey}\nListenPort = ${config.listenPort}\nFwMark = 51820\n`+config.peers.map(peer=>`\n[Peer]\nPublicKey = ${peer.publicKey}\nAllowedIPs = ${config.role==='relay'?'0.0.0.0/0':peer.address+'/32'}\n`+(config.role==='relay'?`Endpoint = ${peer.endpointIPv4}:${peer.endpointPort}\nPersistentKeepalive = 25\n`:'')).join('');
}
export function exitRules(raw){
 const config=validateNetwork(raw);check(config.role==='exit','此规则仅用于出口机');
 const wg=config.wireguardInterface,phy=config.physicalInterface;
 // Only traffic on our tunnel is constrained. Existing host firewall policies remain in force.
 return `table inet vps_panel_forward {
 chain forward {
  type filter hook forward priority -5; policy accept;
  iifname "${wg}" oifname "${phy}" ip saddr { ${config.peers.map(peer=>peer.address).join(', ')||'10.76.0.255'} } ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/3 } counter reject
  iifname "${wg}" oifname "${phy}" ip saddr { ${config.peers.map(peer=>peer.address).join(', ')||'10.76.0.255'} } meta nfproto ipv4 accept
  iifname "${phy}" oifname "${wg}" ct state established,related accept
  iifname "${wg}" counter reject
  oifname "${wg}" counter reject
 }
 chain input {
  type filter hook input priority -5; policy accept;
  iifname "${wg}" counter reject
 }
}
table ip vps_panel_nat {
 chain postrouting {
  type nat hook postrouting priority srcnat; policy accept;
  ip saddr 10.76.0.0/24 oifname "${phy}" masquerade
 }
}
`;
}
export function routePlan(raw){
 const config=validateNetwork(raw),wg=config.wireguardInterface;
 const plan=[['ip',['link','set','dev',wg,'mtu','1380']],['ip',['address','replace',config.address+'/24','dev',wg]],['ip',['link','set','dev',wg,'up']]];
 if(config.role==='relay'){
  plan.push(['ip',['route','replace','table','51820','default','dev',wg]]);
  plan.push(['ip',['rule','add','pref','11000','fwmark','51821','lookup','main','protocol','196']]);
  // Unreachable catch rule prevents Linux from falling through to main when WG goes away.
  config.uids.forEach((uid,index)=>{
   plan.push(['ip',['rule','add','pref',String(11100+index*2),'uidrange',`${uid}-${uid}`,'lookup','51820','protocol','196']]);
   plan.push(['ip',['rule','add','pref',String(11101+index*2),'uidrange',`${uid}-${uid}`,'unreachable','protocol','196']]);
  });
  // The reply to an ATT-routed request for this host returns through WG with
  // this host's own public source IP. Accept it only on our authenticated tunnel;
  // keep physical-interface and global source validation settings untouched.
  plan.push(['sysctl',['-w',`net.ipv4.conf.${wg}.accept_local=1`]]);
  plan.push(['sysctl',['-w',`net.ipv4.conf.${wg}.rp_filter=2`]]);
 }
 return plan;
}
export function ownsRouteRule(rule,uids){
 if(String(rule.protocol)!=='196'||!Array.isArray(uids)||uids.length!==2)return false;
 if(rule.priority===11000)return Number(rule.fwmark)===51821&&rule.table==='main'&&(rule.fwmask===undefined||Number(rule.fwmask)===0xffffffff);
 const offset=rule.priority-11100;if(offset<0||offset>3)return false;
 const uid=uids[Math.floor(offset/2)];
 return rule.uid_start===uid&&rule.uid_end===uid&&(offset%2?rule.action==='unreachable':String(rule.table)==='51820');
}
