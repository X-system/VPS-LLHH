import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { decrypt,RateLimiter } from './security.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function createAuthService({directory,clock=Date.now}){
  const db=new DatabaseSync(join(directory,'panel.sqlite'),{readOnly:true});
  const key=readFileSync(join(directory,'master.key'));
  const limiter=new RateLimiter({max:200,window:1000,capacity:16,clock});
  function get(name){const row=db.prepare('SELECT value FROM config WHERE key=?').get(name);return row?JSON.parse(row.value):undefined;}
  const server=http.createServer(async(req,res)=>{
    const answer=(ok,id='')=>{res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({ok,id}));};
    try{
      if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!limiter.allow('local'))return answer(false);
      const route=/^\/hy2\/(att|direct)\/([A-Za-z0-9_-]{32,128})$/.exec(req.url||'');
      if(req.method!=='POST'||!route||!String(req.headers['content-type']).startsWith('application/json'))return answer(false);
      const encoded=get('auth-services');if(!encoded)return answer(false);
      const services=JSON.parse(decrypt(encoded,key));
      const expected=services['hy2.'+route[1]];
      if(typeof expected!=='string'||expected.length!==route[2].length||!timingSafeEqual(Buffer.from(expected),Buffer.from(route[2])))return answer(false);
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>4096)return answer(false);chunks.push(chunk);}
      const payload=JSON.parse(Buffer.concat(chunks));
      if(typeof payload.auth!=='string'||payload.auth.length>256)return answer(false);
      const separator=payload.auth.indexOf(':');
      let id=payload.auth.slice(0,separator),password=payload.auth.slice(separator+1);
      // Only explicitly imported accounts accept the previous single-password links.
      // Resolve to a user first so quotas, revocation and accounting remain identical.
      if(separator<0){
        if(!/^[A-Za-z0-9_-]{24,128}$/.test(payload.auth))return answer(false);
        const matches=[];
        for(const row of db.prepare('SELECT id,credentials FROM users').all()){
          const credentials=JSON.parse(decrypt(row.credentials,key));
          if(credentials.hy2LegacyAuth!==true)continue;
          const actual=Buffer.from(payload.auth),expected=Buffer.from(credentials.hy2);
          if(actual.length===expected.length&&timingSafeEqual(actual,expected))matches.push(row.id);
        }
        if(matches.length!==1)return answer(false);
        id=matches[0];password=payload.auth;
      }
      if(!uuid.test(id)||!password)return answer(false);
      const runtime=get('runtime');if(!runtime||runtime.maintenance||runtime.emergencyStop||get('settings')?.role!=='relay')return answer(false);
      const user=db.prepare('SELECT * FROM users WHERE id=?').get(id);
      if(!user||!user.enabled||(user.expires!==null&&user.expires<=clock())||!JSON.parse(user.protocols).includes('hy2')||!JSON.parse(user.exits).includes(route[1]))return answer(false);
      const permissions=db.prepare('SELECT lines FROM user_lines WHERE user_id=?').get(id);
      if(permissions&&!JSON.parse(permissions.lines).includes('hy2.'+route[1]))return answer(false);
      const total=db.prepare('SELECT up,down FROM totals WHERE user_id=?').get(id);
      if(user.quota!==null&&(total?.up||0)+(total?.down||0)>=user.quota)return answer(false);
      const credentials=JSON.parse(decrypt(user.credentials,key));
      const actual=Buffer.from(password),secret=Buffer.from(credentials.hy2);
      if(actual.length!==secret.length||!timingSafeEqual(actual,secret))return answer(false);
      answer(true,id);
    }catch{if(!res.headersSent)answer(false);else res.destroy();}
  });
  server.requestTimeout=5000;server.headersTimeout=3000;
  // Listener must always be bound explicitly to loopback by the launcher.
  return{server,async close(){await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));key.fill(0);db.close();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const service=createAuthService({directory:resolve(process.env.VPS_DATA_DIR||'data')});
  const port=Number(process.env.VPS_AUTH_PORT||18444);
  service.server.listen(port,'127.0.0.1',()=>console.log('独立协议认证服务已启动，仅监听回环地址。'));
  for(const signal of['SIGINT','SIGTERM'])process.once(signal,()=>service.close().then(()=>process.exit(0)));
}
