import https from'node:https';
import{networkInterfaces}from'node:os';
import{publicProbeIPv4}from'./node-health.mjs';
import{isIP}from'node:net';
import{readFile}from'node:fs/promises';
import{DatabaseSync}from'node:sqlite';
import{updatePage,updatePageCss}from'./update-page.mjs';
if(process.platform!=='linux'||process.getuid()!==0)throw new Error('更新等待服务只能由服务器维护程序启动');
const env=Object.fromEntries((await readFile('/etc/vps-panel/web.env','utf8')).split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const at=l.indexOf('=');return[l.slice(0,at),l.slice(at+1)];}));
const db=new DatabaseSync('/var/lib/vps-panel/panel.sqlite',{readOnly:true});const entrance=JSON.parse(db.prepare("SELECT value FROM config WHERE key='entrance'").get().value).value;db.close();
const origin=new URL(env.VPS_ORIGIN),allowed=new Set([origin.host]);
if(env.VPS_ALLOW_IP_ACCESS!=='0'){allowed.add('127.0.0.1:'+env.VPS_PORT);for(const rows of Object.values(networkInterfaces()))for(const row of rows||[])if(publicProbeIPv4(row.address))allowed.add(row.address+':'+env.VPS_PORT);}
const server=https.createServer({cert:await readFile('/etc/vps-panel/certs/panel-fullchain.pem'),key:await readFile('/etc/vps-panel/certs/panel-privkey.pem')},(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'");
 const path=String(req.url).split('?')[0];
 let host;try{host=new URL('http://'+req.headers.host).hostname.replace(/^\[|\]$/g,'');}catch{}if(!allowed.has(req.headers.host)||env.VPS_ALLOW_IP_ACCESS==='0'&&isIP(host||'')){res.writeHead(404);return res.end('Not found');}
 if(path.startsWith('/'+entrance+'/api/')){res.writeHead(503,{'Content-Type':'application/json','Retry-After':'3'});return res.end(JSON.stringify({updating:true,error:'升级中，请等待'}));}
 if(req.method!=='GET'||!['/'+entrance+'/','/'+entrance+'/maintenance.css'].includes(path)){res.writeHead(404);return res.end('Not found');}
 const css=path.endsWith('/maintenance.css');res.writeHead(css?200:503,{'Content-Type':css?'text/css; charset=utf-8':'text/html; charset=utf-8',...(css?{}:{'Retry-After':'3'})});res.end(css?updatePageCss:updatePage(entrance));
});
server.listen(Number(env.VPS_PORT),env.VPS_HOST||'0.0.0.0',()=>process.send?.({ready:true}));
const close=()=>{server.close();server.closeAllConnections();process.exit(0);};
process.on('SIGTERM',close);process.on('SIGINT',close);
setTimeout(close,10*60000).unref();
