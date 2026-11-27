import test from'node:test';
import assert from'node:assert/strict';
import{mkdtempSync,rmSync,writeFileSync,readFileSync}from'node:fs';
import{join}from'node:path';
import{tmpdir}from'node:os';
import{createServer}from'node:net';
import{createSystemDriver}from'../src/system-driver.mjs';
async function fixture(t,panelPort=18443,readInterfaces=()=>({})){
 const directory=mkdtempSync(join(tmpdir(),'vps-auto-ports-')),calls=[];t.after(()=>rmSync(directory,{recursive:true,force:true}));
 writeFileSync(join(directory,'system.json'),JSON.stringify({role:'relay',desired:{},networkDesired:false}));writeFileSync(join(directory,'identities.json'),JSON.stringify({'vmess.att':900,'vmess.direct':901,'hy2.att':902,'hy2.direct':903}));writeFileSync(join(directory,'accounts.json'),JSON.stringify({'vps-panel':{uid:999}}));writeFileSync(join(directory,'web.env'),`VPS_ORIGIN=https://11.0.0.2:${panelPort}
VPS_PORT=${panelPort}
`);
 const driver=createSystemDriver({directory,readInterfaces,runner:async(binary,args)=>{calls.push({binary,args});if(args.join(' ')==='-j -4 route show default')return{stdout:'[{"dev":"eth0"}]'};throw new Error('Unexpected command during read-only planning');}});return{directory,driver,calls};
}
test('自动规划跳过占用端口、保留内部端口和管理端口；规划不启动或停止服务',async t=>{
 const occupied=createServer();await new Promise((resolve,reject)=>{occupied.once('error',reject);occupied.listen({port:18001,host:'0.0.0.0',exclusive:true},resolve);});t.after(()=>new Promise(resolve=>occupied.close(resolve)));
 const f=await fixture(t),before=readFileSync(join(f.directory,'system.json'),'utf8'),plan=await f.driver.action('plan-relay');assert.notEqual(plan.ports.vmess.att,18001);const ports=Object.values(plan.ports).flatMap(group=>Object.values(group));assert.equal(new Set(ports).size,4);assert.ok(ports.every(value=>![18443,18444,19001,19002,19003,19004].includes(value)));assert.equal(plan.publicIPv4,'11.0.0.2');assert.equal(plan.physicalInterface,'eth0');assert.equal(readFileSync(join(f.directory,'system.json'),'utf8'),before);assert.equal(f.calls.length,1);
});
test('自动隧道端口不占用面板端口；已有配对保持原端口',async t=>{
 const f=await fixture(t,51820),plan=await f.driver.action('plan-network');assert.notEqual(plan.listenPort,51820);assert.ok(plan.listenPort>=49152&&plan.listenPort<=65535);
 writeFileSync(join(f.directory,'system.json'),JSON.stringify({role:'relay',network:{listenPort:51823}}));assert.equal((await f.driver.action('plan-network')).listenPort,51823);
});

test("自动检测优先采用当前网卡公网地址，不使用旧面板地址",async t=>{
 const f=await fixture(t,18443,()=>({eth0:[{family:"IPv4",address:"10.0.0.2"},{family:"IPv4",address:"11.0.0.3"}]}));
 assert.equal((await f.driver.action("plan-relay")).publicIPv4,"11.0.0.3");
});
