import test from'node:test';
import assert from'node:assert/strict';
import{createTcpAcceleration}from'../src/tcp-acceleration.mjs';
function fixture({kernel='6.1.0-test',fail=false}={}){
 const files=new Map([['/etc/os-release','ID=debian\nVERSION_ID="12"\n']]),values={'net.ipv4.tcp_congestion_control':'cubic','net.core.default_qdisc':'fq_codel','net.ipv4.tcp_mtu_probing':'0','net.ipv4.tcp_available_congestion_control':'reno cubic bbr'},calls=[];
 const missing=()=>Object.assign(new Error('missing'),{code:'ENOENT'});let failed=false;
 const manager=createTcpAcceleration({kernel:()=>kernel,
  read:async path=>{if(!files.has(path))throw missing();return files.get(path);},
  write:async(path,value)=>files.set(path,value),move:async(from,to)=>{files.set(to,files.get(from));files.delete(from);},remove:async path=>{if(!files.delete(path))throw missing();},stat:async path=>{if(!files.has(path))throw missing();return{isFile:()=>true,isSymbolicLink:()=>false,uid:0,mode:0o100644};},
  runner:async(binary,args)=>{calls.push([binary,args]);if(binary.endsWith('sysctl')){if(args[0]==='-n')return{stdout:values[args[1]]+'\n'};const at=args[1].indexOf('='),key=args[1].slice(0,at),value=args[1].slice(at+1);if(fail&&!failed&&value==='bbrx'){failed=true;throw new Error('kernel refused');}values[key]=value;}
   if(binary==='/bin/bash')values['net.ipv4.tcp_available_congestion_control']+=' bbrx';return{stdout:''};}
 });return{manager,files,values,calls};
}
test('TCP加速三选一、BBRX实验性状态、关闭切回CUBIC，未改代理或路由',async()=>{
 const f=fixture();await f.manager.execute('bbr');assert.equal((await f.manager.status()).effective,'bbr');
 await f.manager.execute('bbrx');let state=await f.manager.status();assert.equal(state.mode,'bbrx');assert.equal(state.effective,'bbrx');assert.equal(state.experimental,true);
 await f.manager.execute('bbr');assert.equal((await f.manager.status()).effective,'bbr');await f.manager.execute('off');state=await f.manager.status();assert.equal(state.mode,'off');assert.equal(state.effective,'cubic');assert.equal(f.values['net.core.default_qdisc'],'fq_codel');assert.equal(f.values['net.ipv4.tcp_mtu_probing'],'0');
 assert.ok(!f.calls.some(([b,a])=>b.endsWith('/ip')||a.some(v=>v.includes('vmess')||v.includes('hy2-att'))));
});
test('不兼容的BBRX不执行安装；拒绝非法模式，任务不可并行',async()=>{
 const bad=fixture({kernel:'6.12.0'});await assert.rejects(bad.manager.configure('bbrx'),/仅支持/);assert.equal(bad.calls.length,0);await assert.rejects(bad.manager.configure('bbr;reboot'),/请选择/);
 const f=fixture();const status=await f.manager.configure('bbrx');assert.equal(status.job.state,'running');await assert.rejects(f.manager.configure('off'),/等待/);assert.ok(f.calls.some(([b,a])=>b.endsWith('/systemd-run')&&a.includes('bbrx')));
});
test('切换失败恢复上次算法，第三方配置不覆盖',async()=>{
 const f=fixture({fail:true});await f.manager.execute('bbr');await assert.rejects(f.manager.execute('bbrx'));const s=await f.manager.status();assert.equal(s.mode,'bbr');assert.equal(s.effective,'bbr');assert.equal(s.job.state,'failed');
 const external=fixture();external.files.set('/etc/sysctl.d/99-vps-panel-tcp.conf','another tool');await assert.rejects(external.manager.execute('bbr'),/同名/);assert.equal(external.files.get('/etc/sysctl.d/99-vps-panel-tcp.conf'),'another tool');
});
test('重启恢复已选模式，中断任务按旧选择恢复而不是擅自启用新算法',async()=>{
 const f=fixture();await f.manager.execute('bbr');await f.manager.configure('bbrx');f.values['net.ipv4.tcp_congestion_control']='cubic';await f.manager.execute('off',{boot:true});const s=await f.manager.status();assert.equal(s.mode,'bbr');assert.equal(s.effective,'bbr');assert.equal(s.job.state,'failed');
});

test('关闭明确退出原有BBR，卸载则恢复启用前的BBR与队列',async()=>{const f=fixture();f.values['net.ipv4.tcp_congestion_control']='bbr';await f.manager.execute('bbrx');await f.manager.execute('off');assert.equal((await f.manager.status()).effective,'cubic');await f.manager.restore();assert.equal(f.values['net.ipv4.tcp_congestion_control'],'bbr');assert.equal(f.files.has('/etc/sysctl.d/99-vps-panel-tcp.conf'),false);});
