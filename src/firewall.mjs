import{execFile}from'node:child_process';
import{promisify}from'node:util';
import{port,interfaceName}from'./core-config.mjs';

const execute=promisify(execFile);
const ownedTags=new Set(['vps-panel-web','vps-panel-ip-certificate','vps-panel-wireguard','vps-panel-forward','vps-panel-vmess-att','vps-panel-vmess-direct','vps-panel-hy2-att','vps-panel-hy2-direct']);
export function addedRules(text){
 return text.split('\n').filter(line=>line.startsWith('ufw ')).map(line=>{
  const at=line.indexOf(' comment '),spec=(at<0?line.slice(4):line.slice(4,at)).trim(),comment=at<0?'':line.slice(at+9).trim();
  const tag=/^'([a-z0-9-]+)'$/.exec(comment)?.[1]||/^[a-z0-9-]+$/.exec(comment)?.[0]||null;
  return{args:spec.split(/\s+/),spec,tag};
 });
}
export function createFirewall({runner=execute}={}){
 const call=async args=>{try{return await runner('/usr/sbin/ufw',args,{timeout:15000,maxBuffer:1024*1024,windowsHide:true,env:{...process.env,LC_ALL:'C'}});}catch(error){error.operation='ufw.'+String(args[0]).replace(/[^A-Za-z0-9_-]/g,'').slice(0,32);throw error;}};
 async function active(){try{return/^Status: active\s*$/m.test((await call(['status'])).stdout);}catch(error){if(error.code==='ENOENT')return false;throw error;}}
 return{
  active,
  async allowPort(value,protocol,tag){
   port(value);if(!['tcp','udp'].includes(protocol)||!ownedTags.has(tag))throw new Error('防火墙规则参数错误');
   if(!await active())return{managed:false};
   const spec='allow '+String(value)+'/'+protocol,existing=addedRules((await call(['show','added'])).stdout).find(rule=>rule.spec===spec);
   if(existing)return{managed:existing.tag===tag,existing:true};
   await call(['allow',String(value)+'/'+protocol,'comment',tag]);return{managed:true};
  },
  async allowForward(input,output){
   interfaceName(input);interfaceName(output);if(input!=='vps-wg'||input===output)throw new Error('只允许管理本程序的隧道转发');
   if(!await active())return{managed:false};
   const spec=`route allow in on ${input} out on ${output} from 10.76.0.0/24`;
   const existing=addedRules((await call(['show','added'])).stdout).find(rule=>rule.spec===spec);if(existing)return{managed:existing.tag==='vps-panel-forward',existing:true};
   await call(['route','allow','in','on',input,'out','on',output,'from','10.76.0.0/24','comment','vps-panel-forward']);return{managed:true};
  },
  async removeOwned(tags=[...ownedTags],{keepPorts=[]}={}){
   if(!Array.isArray(tags)||tags.some(tag=>!ownedTags.has(tag)))throw new Error('防火墙标签错误');
   if(!Array.isArray(keepPorts))throw new Error('保留端口格式错误');for(const value of keepPorts)port(value);
   if(!await active())return{managed:false};
   // UFW's exact rule deletion includes the nonempty comment. Never use unstable row numbers.
   const rules=addedRules((await call(['show','added'])).stdout).filter(rule=>tags.includes(rule.tag));
   if(rules.length>100)throw new Error('本程序的防火墙规则数量异常，停止自动清理');
   for(const rule of rules){
    if(rule.tag==='vps-panel-web'&&rule.args.length===2&&rule.args[0]==='allow'&&keepPorts.some(value=>rule.args[1]===value+'/tcp'))continue;
    if(!rule.args.every(value=>/^[A-Za-z0-9_./,:-]+$/.test(value))||!(rule.args[0]==='allow'||rule.args[0]==='route'&&rule.args[1]==='allow'))throw new Error('本程序防火墙规则发生意外变更，停止清理');
    const args=rule.args[0]==='route'?['--force','route','delete',...rule.args.slice(1)]:['--force','delete',...rule.args];
    await call([...args,'comment',rule.tag]);
   }
   return{managed:true};
  }
 };
}
