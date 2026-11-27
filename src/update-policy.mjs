export const policyPrefix='<!-- llhh:update-policy ';
export function releasePolicy(body){
 const text=typeof body==='string'?body:'';let required=false;
 for(const match of text.matchAll(/<!-- llhh:update-policy ([^\n]{1,1000}?) -->/g))try{if(JSON.parse(match[1]).required===true)required=true;}catch{}
 return{required,notes:text.replace(/<!-- llhh:update-policy [^\n]*? -->/g,'').slice(0,20000).trim()};
}
