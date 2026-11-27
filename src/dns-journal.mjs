import{readFile}from'node:fs/promises';
import{join}from'node:path';
import{randomBytes}from'node:crypto';
import{encrypt,decrypt}from'./security.mjs';
import{atomicWrite}from'./system-driver.mjs';

// Keep the original scoped credential encrypted until our own validation records are removed.
export function createDnsJournal({directory,master,createDns}){
 const path=join(directory,'dns-cleanup.enc');
 async function load(){try{return JSON.parse(decrypt(await readFile(path,'utf8'),await master()));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
 const save=async value=>atomicWrite(path,encrypt(JSON.stringify(value.records.length?value:{records:[]}),await master()));
 async function cleanup(){
  const value=await load();if(!value?.records.length)return;
  const dns=createDns(value);let failed=false;
  for(const record of[...value.records]){
   try{
    const ids=record.id?[record.id]:await dns.findOwned(record);
    for(const id of ids)await dns.remove(id);
    value.records=value.records.filter(item=>item.marker!==record.marker);await save(value);
   }catch{failed=true;}
  }
  if(failed)throw new Error('本次DNS验证记录尚未清理，将在后续任务重试');
 }
 return{
  cleanup,
  async refresh(settings){const value=await load();if(value?.records.length&&value.zoneId===settings.zoneId){value.token=settings.token;await save(value);}},
  async intent(settings,name,content){
   const current=await load();if(current?.records.length&&current.zoneId!==settings.zoneId)throw new Error('请先完成旧区域验证记录清理');
   const record={marker:'vps-panel-acme-'+randomBytes(16).toString('hex'),name,content};
   await save({zoneId:settings.zoneId,token:settings.token,records:[...(current?.records||[]),record]});return record;
  },
  async created(marker,id){const value=await load(),record=value?.records.find(item=>item.marker===marker);if(!record)throw new Error('DNS验证记录日志缺失');record.id=id;await save(value);},
  async removed(marker){const value=await load();if(value){value.records=value.records.filter(record=>record.marker!==marker);await save(value);}}
 };
}
