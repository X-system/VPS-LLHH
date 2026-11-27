import test from'node:test';
import assert from'node:assert/strict';
import net from'node:net';
import{createFirewall}from'../src/firewall.mjs';
import{probeBindings}from'../src/bindings.mjs';

test('UFW规则按本程序标签清理，端口相同的用户规则仍保留；不启用或重置防火墙',async()=>{
 const calls=[];let deleted=false;
 const firewall=createFirewall({runner:async(binary,args,options)=>{
  assert.equal(binary,'/usr/sbin/ufw');assert.equal(options.shell,undefined);calls.push(args);
  if(args.join(' ')==='status')return{stdout:'Status: active\n'};
  if(args.join(' ')==='show added')return{stdout:"ufw allow 443/udp comment 'personal-rule'\n"+(deleted?'':"ufw allow 18004/udp comment 'vps-panel-hy2-direct'\n")+"ufw allow 22/tcp comment 'vps-panel-custom'\n"};
  if(args.join(' ')==='--force delete allow 18004/udp comment vps-panel-hy2-direct'){deleted=true;return{stdout:'Rule deleted'};}
  return{stdout:'Rule added'};
 }});
 await firewall.allowPort(443,'udp','vps-panel-hy2-direct');await firewall.removeOwned(['vps-panel-hy2-direct']);
 assert.ok(calls.some(args=>args.join(' ')==='--force delete allow 18004/udp comment vps-panel-hy2-direct'));
 assert.ok(!calls.some(args=>args.includes('enable')||args.includes('reset')||args[0]==='allow'||args.includes('443/udp')&&args.includes('delete')),'不认领或删除个人已有的相同端口规则');
 await assert.rejects(firewall.allowPort(22,'tcp','arbitrary-rule'));
});
test('配置前检测端口占用，不终止占用者或静默改端口',async t=>{
 const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 await assert.rejects(probeBindings([{port:server.address().port,protocol:'tcp',host:'127.0.0.1'}]),/占用/);
 assert.ok(server.listening);
});

test('切换管理端口只清理旧的自有规则，保留新端口和个人规则',async()=>{
 const calls=[];
 const firewall=createFirewall({runner:async(binary,args)=>{
  calls.push(args);
  if(args[0]==='status')return{stdout:'Status: active\n'};
  if(args[0]==='show')return{stdout:"ufw allow 18443/tcp comment 'vps-panel-web'\nufw allow 18445/tcp comment 'vps-panel-web'\nufw allow 22/tcp comment 'personal-rule'\n"};
  return{stdout:''};
 }});
 await firewall.removeOwned(['vps-panel-web'],{keepPorts:[18445]});
 assert.deepEqual(calls.filter(args=>args.includes('delete')),[['--force','delete','allow','18443/tcp','comment','vps-panel-web']]);
});
