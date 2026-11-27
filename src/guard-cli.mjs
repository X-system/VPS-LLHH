import{createSystemDriver}from'./system-driver.mjs';
if(process.platform!=='linux'||process.getuid()!==0)throw new Error('内核保护必须由root服务运行');
await createSystemDriver().guardUp();
console.log('协议身份、统计接口与断线保护规则已恢复');
