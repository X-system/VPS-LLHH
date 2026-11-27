import{readFile,statfs}from'node:fs/promises';
import{cpus,totalmem,freemem}from'node:os';
import{interfaceName}from'./core-config.mjs';
import{evaluateRules}from'./metrics.mjs';

export function parseNetDev(text,name){
 interfaceName(name);const line=text.split('\n').find(line=>line.trim().startsWith(name+':'));if(!line)return null;
 const fields=line.split(':')[1].trim().split(/\s+/).map(Number);
 if(fields.length<16||![fields[0],fields[8]].every(value=>Number.isSafeInteger(value)&&value>=0))throw new Error('网卡计数格式错误');
 return{down:fields[0],up:fields[8]};
}
export function counterRate(prior,next,elapsed){
 if(!prior||!next||elapsed<=0||elapsed>60000||next.up<prior.up||next.down<prior.down)return{up:null,down:null};
 return{up:(next.up-prior.up)*1000/elapsed,down:(next.down-prior.down)*1000/elapsed};
}
export async function collectHost(store,{physicalInterface,wireguardInterface='vps-wg',directory='/var/lib/vps-panel',read=readFile,disk=statfs,cpu=cpus}={}){
 const now=store.clock(),prior=store.get('host-counters');
 const times=cpu().reduce((sum,item)=>{for(const[key,value]of Object.entries(item.times)){sum.total+=value;if(key==='idle')sum.idle+=value;}return sum;},{total:0,idle:0});
 const net=await read('/proc/net/dev','utf8');const physical=physicalInterface?parseNetDev(net,physicalInterface):null,wg=parseNetDev(net,wireguardInterface);
 const elapsed=prior?now-prior.at:0,totalDelta=prior?times.total-prior.cpu.total:0,idleDelta=prior?times.idle-prior.cpu.idle:0;
 const physicalRate=counterRate(prior?.physical,physical,elapsed),wgRate=counterRate(prior?.wg,wg,elapsed);
 const memory=await read('/proc/meminfo','utf8');const available=/^MemAvailable:\s+(\d+) kB/m.exec(memory);
 const size=await disk(directory),diskTotal=Number(size.blocks)*Number(size.bsize),diskFree=Number(size.bavail)*Number(size.bsize);
 const sample={memoryPercent:100*(1-(available?Number(available[1])*1024:freemem())/totalmem()),diskPercent:diskTotal?100*(1-diskFree/diskTotal):0};
 if(elapsed>0&&elapsed<=60000&&totalDelta>0&&idleDelta>=0)sample.cpuPercent=Math.max(0,Math.min(100,100*(1-idleDelta/totalDelta)));
 if(physicalRate.up!==null){sample.uploadMbps=physicalRate.up*8/1e6;sample.downloadMbps=physicalRate.down*8/1e6;}
 const telemetry={at:now,...sample,physical:{interface:physicalInterface,...physicalRate},wireguard:{interface:wireguardInterface,...wgRate}};
 store.set('host-counters',{at:now,cpu:times,physical,wg});store.set('host-telemetry',telemetry);
 evaluateRules(store,sample);return telemetry;
}
