import{createSystemDriver}from'./system-driver.mjs';
if(process.platform!=='linux'||process.getuid()!==0)throw new Error('网络管理必须由root服务运行');
await createSystemDriver().networkUp();
console.log('WireGuard和断线保护已配置');
