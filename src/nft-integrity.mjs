import{createHash}from'node:crypto';

function stable(value,parent=''){
 if(Array.isArray(value))return value.map(item=>stable(item,parent));
 if(!value||typeof value!=='object')return value;
 return Object.fromEntries(Object.keys(value).sort().filter(key=>key!=='handle'&&!(parent==='counter'&&['packets','bytes'].includes(key))).map(key=>[key,stable(value[key],key)]));
}
export function nftFingerprint(json){
 const value=typeof json==='string'?JSON.parse(json):json;
 if(!value||!Array.isArray(value.nftables))throw new Error('内核规则状态格式错误');
 const definitions=value.nftables.filter(item=>!Object.hasOwn(item,'metainfo'));
 return createHash('sha256').update(JSON.stringify(stable(definitions))).digest('hex');
}
