import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { buildRelayConfigs,buildFailClosed,clientLinks,validateRelay } from '../src/core-config.mjs';
import { newCredentials } from '../src/backup.mjs';

function fixture(){return {publicIPv4:'192.0.2.20',physicalInterface:'eth0',wireguardInterface:'vps-wg',domain:'relay.example.test',endpointIPv4:'198.51.100.25',endpointPort:51874,endpointPublicKey:randomBytes(32).toString('base64'),ports:{vmess:{att:18001,direct:18002},hy2:{att:443,direct:8443}},uids:{'vmess.att':900,'vmess.direct':901,'hy2.att':902,'hy2.direct':903},stats:{'vmess.att':{port:19001},'vmess.direct':{port:19002},'hy2.att':{port:19003,secret:'abcdefghijklmnopqrstuvwx'},'hy2.direct':{port:19004,secret:'abcdefghijklmnopqrstuvwy'}}};}
function user(values={}){return {id:randomUUID(),name:'独立用户',credentials:newCredentials(),enabled:true,expires:null,quota:null,up:0,down:0,protocols:['vmess','hy2'],exits:['att'],...values};}
test('未授权、停用、过期及额度耗尽用户不进入核心配置',()=>{
  const config=fixture(),now=1700000000000;
  const good=user(),disabled=user({enabled:false}),expired=user({expires:now-1}),quota=user({quota:100,up:100}),direct=user({exits:['direct']});
  const built=buildRelayConfigs(config,[good,disabled,expired,quota,direct],now);
  assert.deepEqual(Object.keys(built['hy2.att'].auth.userpass),[good.id]);
  assert.deepEqual(built['vmess.att'].inbounds[0].settings.clients.map(user=>user.email),[good.id]);
  assert.deepEqual(Object.keys(built['hy2.direct'].auth.userpass),[direct.id]);
  assert.equal(built['hy2.att'].outbounds[0].direct.bindDevice,'vps-wg');
  assert.equal(built['hy2.direct'].outbounds[0].direct.bindDevice,'eth0');
  assert.equal(built['vmess.att'].inbounds[0].streamSettings.security,'none');
  assert.equal(built['hy2.att'].tls.sniGuard,'strict');
  assert.equal(built['hy2.att'].trafficStats.listen,'127.0.0.1:19003');
  assert.ok(!built['hy2.att'].acl.inline.includes('reject(::/0)'),'不要因域名同时有AAAA记录而拒绝整个域名');
  assert.equal(built['hy2.att'].outbounds[0].direct.mode,'4');
  assert.equal(built['vmess.att'].inbounds[1].listen,'127.0.0.1');
});
test('入口参数防命令注入，拒绝共享UID和端口冲突',()=>{
  const config=fixture();
  assert.throws(()=>validateRelay({...config,physicalInterface:'eth0; reboot'}));
  assert.throws(()=>validateRelay({...config,endpointIPv4:'198.51.100.25;id'}));
  assert.throws(()=>validateRelay({...config,domain:'example.test/path'}));
  assert.throws(()=>validateRelay({...config,uids:{...config.uids,'hy2.att':900}}));
  assert.throws(()=>validateRelay({...config,ports:{...config.ports,vmess:{att:18001,direct:18001}}}));
});
test('ATT UID只有指定回复、本机统计回复及WG出站被允许，其他IPv4/IPv6拒绝',()=>{
  const config=fixture(),rules=buildFailClosed(config);
  assert.ok(rules.includes('meta skuid 900 counter reject'));
  assert.ok(rules.includes('meta skuid 902 counter reject'));
  assert.ok(rules.includes('meta skuid 901 oifname "eth0" accept'));
  assert.ok(rules.includes('meta skuid 901 counter reject'));
  assert.ok(rules.includes('oifname "lo" ct direction reply tcp sport 19003 accept'));
  assert.ok(rules.includes('ip daddr 198.51.100.25 udp dport 51874 accept'));
  assert.ok(!rules.includes('ct state established accept'));
});

test('本机面板回环只允许直出身份、当前管理端口和本机公网地址，ATT保持WG约束',()=>{
 const config=fixture(),rules=buildFailClosed(config,{panelPort:18445});
 for(const uid of[901,903]){
  const exception=`meta skuid ${uid} oifname "lo" fib daddr type local ct direction original tcp dport 18445 accept`;
  assert.ok(rules.includes(exception));
  assert.ok(rules.indexOf(`meta skuid ${uid} ip daddr {`)<rules.indexOf(exception),'先拒绝内网与保留地址');
 }
 for(const uid of[900,902])assert.ok(!rules.includes(`meta skuid ${uid} oifname "lo" fib daddr`));
 assert.ok(!rules.includes(config.publicIPv4),'地址由内核判断，不固定为配置时的旧IP');
 assert.ok(!rules.includes('tcp dport 18443'));
 assert.ok(!buildFailClosed(config).includes('fib daddr'));
 assert.throws(()=>buildFailClosed(config,{panelPort:19001}));
 assert.throws(()=>buildFailClosed(config,{panelPort:0}));
});
test('链接仅包含授权出口，Hy2证书校验开启，VMess保持原始TCP',()=>{
  const config=fixture(),account=user();
  const links=clientLinks(config,account);
  assert.equal(links.length,2);assert.ok(links.every(link=>link.exit==='att'));
  const hy=links.find(link=>link.protocol==='hy2').url;
  assert.ok(hy.includes('insecure=0'));assert.ok(hy.includes(encodeURIComponent(account.id+':'+account.credentials.hy2)));
  const vm=JSON.parse(Buffer.from(links.find(link=>link.protocol==='vmess').url.slice(8),'base64').toString());
  assert.equal(vm.net,'tcp');assert.equal(vm.tls,'');assert.equal(vm.id,account.credentials.vmess);
});

test('明确导入的旧Hy2用户链接保留单密码，普通用户继续独立用户认证',()=>{
 const config=fixture(),account=user({protocols:['hy2']});
 account.credentials.hy2LegacyAuth=true;
 const link=clientLinks(config,account)[0].url;
 assert.equal(decodeURIComponent(new URL(link).username),account.credentials.hy2);
 assert.ok(!link.includes(encodeURIComponent(account.id+':')));
 account.credentials=newCredentials();
 assert.ok(clientLinks(config,account)[0].url.includes(encodeURIComponent(account.id+':'+account.credentials.hy2)));
});
