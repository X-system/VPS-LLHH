import test from'node:test';
import assert from'node:assert/strict';
import{wgKeys,wgPublic,wgConfig,exitRules,routePlan,validateNetwork,ownsRouteRule}from'../src/network.mjs';
const fixture=()=>({role:'relay',privateKey:wgKeys().privateKey,physicalInterface:'eth0',wireguardInterface:'vps-wg',address:'10.76.0.2',listenPort:51820,uids:[900,902],peers:[{publicKey:wgKeys().publicKey,address:'10.76.0.1',endpointIPv4:'198.51.100.1',endpointPort:51874}]});
test('WG配对仅交换公钥；路由只接管两个隧道UID并有失效拒绝规则',()=>{
 const pair=wgKeys();assert.equal(wgPublic(pair.privateKey),pair.publicKey);
 const config=fixture(),text=wgConfig(config);assert.ok(text.includes('AllowedIPs = 0.0.0.0/0'));assert.ok(!text.includes('PostUp'));
 const plan=routePlan(config);assert.equal(plan.filter(item=>item[1].includes('unreachable')).length,2);
 assert.ok(plan.filter(item=>item[1].includes('rule')&&!item[1].includes('fwmark')).every(item=>item[1].includes('uidrange')));
 assert.equal(plan.filter(item=>item[1].includes('main')).length,1);
});
test('出口只允许明确配对地址转发；拒绝隧道访问本机、私网及IPv6转发',()=>{
 const config={...fixture(),role:'exit',address:'10.76.0.1',peers:[{publicKey:wgKeys().publicKey,address:'10.76.0.2'}]};
 const rules=exitRules(config);assert.ok(rules.includes('iifname "vps-wg" counter reject'));assert.ok(rules.includes('ip saddr { 10.76.0.2 }'));
 assert.ok(rules.includes('meta nfproto ipv4 accept'));assert.ok(!rules.includes('flush ruleset'));
 assert.equal(wgConfig(config).includes('0.0.0.0/0'),false);
 assert.throws(()=>validateNetwork({...config,peers:[...config.peers,...config.peers]}));
 assert.throws(()=>validateNetwork({...config,physicalInterface:'eth0;id'}));
});
test('共享路由优先级或协议号不足以认领规则，还必须匹配本机UID、表和标记',()=>{
 const base={priority:11100,uid_start:900,uid_end:900,table:'51820',protocol:'196'};
 assert.equal(ownsRouteRule(base,[900,902]),true);
 assert.equal(ownsRouteRule({...base,uid_start:901},[900,902]),false);
 assert.equal(ownsRouteRule({...base,table:'main'},[900,902]),false);
 assert.equal(ownsRouteRule({priority:11000,fwmark:'0xca6d',table:'main',protocol:'196'},[900,902]),true);
 assert.equal(ownsRouteRule({priority:11000,fwmark:'0xca6d',fwmask:'0xff',table:'main',protocol:'196'},[900,902]),false);
});

test('中转访问自身面板的隧道回包配置只作用于自有WG接口，出口和全局网卡不修改',()=>{
 const config=fixture();
 assert.deepEqual(routePlan(config).filter(([command])=>command==='sysctl'),[
  ['sysctl',['-w','net.ipv4.conf.vps-wg.accept_local=1']],
  ['sysctl',['-w','net.ipv4.conf.vps-wg.rp_filter=2']]
 ]);
 assert.ok(!routePlan({...config,role:'exit',address:'10.76.0.1',peers:[{publicKey:wgKeys().publicKey,address:'10.76.0.2'}]}).some(([command])=>command==='sysctl'));
});
