import{mkdirSync,readFileSync,writeFileSync,readdirSync,statSync,unlinkSync}from'node:fs';
import{join}from'node:path';
import{randomBytes}from'node:crypto';
import{HttpError,text}from'./validation.mjs';

export function appearanceView(store){const value=store.get('appearance')||{};return{loginName:value.loginName||'',panelTitle:value.panelTitle||'',hasLogo:!!value.logo,hasBackground:!!value.background};}
export function pngUpload(value,kind){
 if(typeof value!=='string'||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))throw new HttpError(400,'图片必须是PNG格式');
 const data=Buffer.from(value.slice(22),'base64'),limit=kind==='logo'?256*1024:2*1024*1024;
 if(data.length<33||data.length>limit||!data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))||data.toString('ascii',12,16)!=='IHDR')throw new HttpError(400,'PNG图片损坏或超过大小限制');
 const width=data.readUInt32BE(16),height=data.readUInt32BE(20),maximum=kind==='logo'?2048:4096;
 if(!width||!height||width>maximum||height>maximum)throw new HttpError(400,'图片尺寸超出范围');return data;
}
export function validateAppearance(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['loginName','panelTitle','logo','background'].includes(key)))throw new HttpError(400,'外观设置字段错误');
 for(const key of['loginName','panelTitle'])if(key in input&&input[key]!=='')text(input[key],key==='loginName'?'登录页名称':'网页标题',{max:48});
 for(const kind of['logo','background'])if(kind in input&&input[kind]!==null)pngUpload(input[kind],kind);
 return input;
}
export function exportAppearance(store){
 const current=store.get('appearance');if(!current)return null;
 return{loginName:current.loginName||'',panelTitle:current.panelTitle||'',...Object.fromEntries(['logo','background'].map(kind=>[kind,current[kind]?'data:image/png;base64,'+appearanceAsset(store,store.directory,kind).toString('base64'):null]))};
}
export function configureAppearance(store,directory,input){
 validateAppearance(input);
 const next={...store.get('appearance')};
 for(const key of['loginName','panelTitle'])if(key in input)next[key]=input[key]===''?'':text(input[key],key==='loginName'?'登录页名称':'网页标题',{max:48});
 const uploads=[];
 for(const kind of['logo','background'])if(kind in input){if(input[kind]===null)next[kind]=null;else uploads.push({kind,data:pngUpload(input[kind],kind)});}
 const target=join(directory,'appearance');mkdirSync(target,{recursive:true,mode:0o700});
 for(const{kind,data}of uploads){const name=kind+'-'+randomBytes(12).toString('hex')+'.png';writeFileSync(join(target,name),data,{mode:0o600,flag:'wx'});next[kind]=name;}
 store.set('appearance',next);store.audit('更新面板外观');
 for(const kind of['logo','background']){
  const files=readdirSync(target).filter(name=>new RegExp('^'+kind+'-[a-f0-9]{24}\\.png$').test(name)).sort((a,b)=>statSync(join(target,b)).mtimeMs-statSync(join(target,a)).mtimeMs);
  const keep=new Set([next[kind],...files.filter(name=>name!==next[kind]).slice(0,2)]);
  for(const name of files)if(!keep.has(name))unlinkSync(join(target,name));
 }
 return appearanceView(store);
}
export function appearanceAsset(store,directory,kind){
 if(!['logo','background'].includes(kind))throw new HttpError(404,'Not found');
 const name=store.get('appearance')?.[kind];if(typeof name!=='string'||!new RegExp('^'+kind+'-[a-f0-9]{24}\\.png$').test(name))return null;
 return readFileSync(join(directory,'appearance',name));
}
