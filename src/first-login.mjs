import{readFileSync,existsSync}from'node:fs';
import{resolve,join}from'node:path';
import{fileURLToPath}from'node:url';
import{DatabaseSync}from'node:sqlite';

export function firstLoginAddress(origin,entrance,setupToken){
 const url=new URL(origin);if(url.protocol!=='https:'||url.username||url.password||!/^[A-Za-z0-9_~-]{20}$/.test(entrance)||!/^[A-Za-z0-9_-]{32,128}$/.test(setupToken))throw new Error('首次设置地址无效');
 url.pathname='/'+entrance+'/';url.search='';url.hash='setup='+setupToken;return url.href;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const directory=process.env.VPS_DATA_DIR||'/var/lib/vps-panel',path=join(directory,'.bootstrap.json');
 if(!existsSync(path)){console.log('继续使用原管理员账户登录。');}
 else{
  const bootstrap=JSON.parse(readFileSync(path)),db=new DatabaseSync(join(directory,'panel.sqlite'),{readOnly:true});
  try{
   const entrance=JSON.parse(db.prepare("SELECT value FROM config WHERE key='entrance'").get().value).value;
   if(bootstrap.setupToken)console.log('\n复制下面的地址到浏览器，直接开始首次设置：\n'+firstLoginAddress(process.env.VPS_ORIGIN,entrance,bootstrap.setupToken)+'\n首次设置链接仅可使用一次，24小时内有效，请勿转发。');
   console.log('\n备用临时用户名：'+bootstrap.username+'\n备用临时密码：'+bootstrap.password+'\n进入网页后，请按引导设置自己的账户。');
  }finally{db.close();}
 }
}
