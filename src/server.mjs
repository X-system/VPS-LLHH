import{updateActive,updatePage,updatePageCss}from'./update-page.mjs';
import{delegateNotification,notificationRelayStatus}from'./notification-relay.mjs';
import{createNodeHealth,publicProbeIPv4}from'./node-health.mjs';
import{networkInterfaces}from'node:os';
import{isIP}from'node:net';
import{compareVersions,parseVersion}from'./versions.mjs';
import{observeUpdateNotices,emitUpdateNotice}from'./update-notices.mjs';
import http from 'node:http';
import https from 'node:https';
import { readFileSync,writeFileSync,unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore } from './store.mjs';
import { RateLimiter, token, digest, verifyPassword, hashPassword } from './security.mjs';
import { HttpError, settings as validateSettings, user as validateUser, text } from './validation.mjs';
import { barkStatus,configureBark,sendBark,dispatchEvents,enqueueEvent } from './bark.mjs';
import { exportBackup,previewBackup,importBackup,rollbackImport } from './backup.mjs';
import { agentRequest } from './agent-client.mjs';
import { networkView,relayView,saveNetwork,saveRelay,serviceAction,liveUsers,readSecret } from './deployment.mjs';
import { clientLinks } from './core-config.mjs';
import { switchRole } from './roles.mjs';
import { diagnostics } from './diagnostics.mjs';
import { appearanceView,configureAppearance,appearanceAsset } from './appearance.mjs';
import { indexSubscriptions,subscription,subscriptionAddress } from './subscriptions.mjs';
import QRCode from 'qrcode';
import { alertRules,configureAlertRules } from './metrics.mjs';
import { peerView } from './tunnel-stats.mjs';
import { lineUsage } from './line-usage.mjs';
import {createHistorySampler,readHistory}from'./history.mjs';
import { nodeSnapshot } from './controller-contract.mjs';
import{linePermissions,saveLines}from'./line-permissions.mjs';
import{catalog,subscriptionSettings,saveSubscriptionSettings,linkPresentation}from'./line-catalog.mjs';
import{deleteUser,userUsage,deletedUsage,monthlyUserUsage}from'./user-ledger.mjs';
import{createOnboarding,resumeSetup}from'./onboarding.mjs';
import{createPairing}from'./pairing.mjs';
import{pairingPath}from'./pairing-transport.mjs';
import{connectionStates}from'./line-state.mjs';
import{notificationSettingsView,saveNotificationProfile,setNotificationEnabled,notificationTestMessage}from'./alert-settings.mjs';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const assets = new Map([['', ['index.html','text/html; charset=utf-8']],...['app.js','ui-alert-settings.mjs','ui-updates.mjs','presence.mjs','ui-kit.mjs','ui-help.mjs','ui-pages.mjs','ui-config.mjs','ui-mobile.mjs','ui-monitor.mjs','ui-feedback.mjs','ui-health.mjs','ui-user-details.mjs','ui-onboarding.mjs','ui-pairing.mjs','ui-service-settings.mjs'].map(name=>[name,[name,'text/javascript; charset=utf-8']]),...['style.css','ui-style.css','ui-mobile.css','ui-monitor.css','ui-feedback.css','ui-health.css'].map(name=>[name,[name,'text/css; charset=utf-8']]),['login-background.png',['login-background.png','image/png']]]);
const DAY = 86400_000;
const appVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;

export async function createApp(options = {}) {
  const configuredOrigins=new Map();
  for(const value of [options.origin,...(options.allowedOrigins||[])].filter(Boolean)){
    const parsed=new URL(value);
    if(!['http:','https:'].includes(parsed.protocol)||parsed.origin!==value||options.origin&&parsed.protocol!==new URL(options.origin).protocol)throw new Error('管理访问地址配置错误');
    configuredOrigins.set(parsed.host,parsed.origin);
  }
  if(!options.origin&&configuredOrigins.size)throw new Error('额外访问地址需要配置主管理地址');
  function requestOrigin(req){
    if(options.allowIpAccess===false){let host;try{host=new URL('http://'+req.headers.host).hostname.replace(/^\[|\]$/g,'');}catch{return null;}if(isIP(host))return null;}
    const configured=configuredOrigins.get(req.headers.host);if(configured)return configured;
    if(!options.origin)return null;
    // A changed host IP must work without accepting arbitrary Host headers or DNS.
    // Only literal, currently assigned public IPv4s on this actual listener qualify.
    const match=/^((?:\d{1,3}\.){3}\d{1,3})(?::([1-9]\d{0,4}))?$/.exec(req.headers.host||'');
    if(!match||!publicProbeIPv4(match[1]))return null;
    const protocol=new URL(options.origin).protocol,port=Number(match[2]||(protocol==='https:'?443:80));
    if(port!==req.socket.localPort)return null;
    const addresses=Object.values((options.networkInterfaces||networkInterfaces)()).flat();
    if(!addresses.some(address=>address&&!address.internal&&address.family==='IPv4'&&address.address===match[1]))return null;
    return new URL(protocol+'//'+req.headers.host).origin;
  }
  const store = await openStore({ directory: options.directory || resolve('data'), password: options.password, clock: options.clock || Date.now });
  const loginLimiter = new RateLimiter({ clock: store.clock });
  const subscriptionLimiter=new RateLimiter({max:30,window:60000,capacity:1024,clock:store.clock});
  const notificationTestLimiter=new RateLimiter({max:30,window:60000,capacity:16,clock:store.clock});
  indexSubscriptions(store);
  // Also bound password hashing work across source IPs.
  let pendingLogins = 0;
  const tls = options.tls;
  const systemRequest=options.systemRequest;
  if(options.onboarding===true&&!store.get('onboarded')&&!store.get('onboarding')){store.set('onboarding',{version:2,step:'account',completed:[],draft:{}});store.set('settings',{...store.get('settings'),uiVersion:2});}
  const onboarding=createOnboarding({store,request:systemRequest,fetchImpl:options.fetchImpl,allowLocalBark:!!options.allowLocalBark,resolve:options.resolveDomain});
  const pairing=createPairing({store,request:systemRequest,origin:options.origin,tls,transport:options.pairingTransport,fetchImpl:options.fetchImpl,allowLocal:!!options.allowLocalPairing,applyServices:options=>onboarding.apply({},options)});
  const pairingLimiter=new RateLimiter({max:60,window:60000,capacity:1024,clock:store.clock});
  if (options.production && !tls) { store.close(); throw new Error('生产环境必须配置 HTTPS'); }
  const json = (res, status, payload, extra = {}) => {
    const data = Buffer.from(JSON.stringify(payload));
    res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Content-Length': data.length, ...extra }); res.end(data);
  };
  async function body(req,limit=65536) {
    if (!String(req.headers['content-type']).startsWith('application/json')) throw new HttpError(415, '请求必须为 JSON');
    const parts = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw new HttpError(413, '请求过大'); parts.push(chunk); }
    try { const value = JSON.parse(Buffer.concat(parts)); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
    catch { throw new HttpError(400, 'JSON格式错误'); }
  }
  function userRows() {
    return liveUsers(store,store.db.prepare(`SELECT u.id,u.name,u.enabled,u.protocols,u.exits,u.quota,u.expires,u.created,
      COALESCE(t.up,0) AS up,COALESCE(t.down,0) AS down,t.last_activity,p.seen AS last_online FROM users u LEFT JOIN totals t ON t.user_id=u.id LEFT JOIN user_presence p ON p.user_id=u.id ORDER BY u.created DESC`).all().map(row => ({ ...row, enabled: !!row.enabled, protocols: JSON.parse(row.protocols), exits: JSON.parse(row.exits),lines:linePermissions(store,row.id), online: null, speedUp: null, speedDown: null, deployment:'未部署' })));
  }
  function metadata() {
    const config = store.get('settings');
    return { version:appVersion,serverName: config.serverName, role: config.role, setupComplete: !!store.get('onboarded'),onboarding:{active:onboarding.view().active},uiVersion:config.uiVersion||1,systemChangesEnabled:!!systemRequest,appearance:appearanceView(store) };
  }
  let updateStatusCache=null,updateStatusAt=0,updateStatusPending=null;
  async function updateView(){if(!systemRequest)return null;if(Date.now()-updateStatusAt<500)return updateStatusCache;if(updateStatusPending)return updateStatusPending;updateStatusPending=systemRequest('update-status').then(value=>{updateStatusCache=value;updateStatusAt=Date.now();return value;}).catch(()=>null).finally(()=>{updateStatusPending=null;});return updateStatusPending;}
  function requiredUpdate(value){
    if(value){observeUpdateNotices(store,value);if(value.required&&value.hasUpdate&&value.available)store.set('required-update',{currentVersion:appVersion,hasUpdate:true,required:true,available:{version:value.available.version,requiredVersion:value.available.requiredVersion||value.available.version,notes:value.available.notes||''}});else if(value.required===false||value.hasUpdate===false)store.set('required-update',null);}
    const cached=store.get('required-update'),minimum=cached?.available?.requiredVersion;if(!parseVersion(minimum)||compareVersions(appVersion,minimum)>=0){if(cached)store.set('required-update',null);return null;}return cached;
  }
  const handler = async (req, res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (tls) res.setHeader('Strict-Transport-Security','max-age=31536000');
    try {
      const entrance = store.get('entrance');
      const prefix = `/${entrance.value}/`;
      const pathname = String(req.url || '').split('?')[0];
      if(pathname===pairingPath){
        if(req.method!=='POST'||options.origin&&!requestOrigin(req)||!pairingLimiter.allow(req.socket.remoteAddress))return json(res,404,{error:'Not found'});
        const match=/^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(req.headers.authorization||'');if(!match)return json(res,404,{error:'Not found'});
        return json(res,200,await pairing.machine(match[1],await body(req,16384)));
      }
      const internalUpdateProbe=pathname===prefix+'api/meta'&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)&&req.headers['x-panel-update-probe']==='1';
      if(!internalUpdateProbe&&pathname.startsWith(prefix)&&(pathname===prefix||pathname===prefix+'index.html'||pathname===prefix+'maintenance.css'||pathname===prefix+'api/meta'||!['GET','HEAD'].includes(req.method)||updateActive(updateStatusCache?.job))&&!pathname.endsWith('/api/updates')&&!pathname.endsWith('/api/updates/logs')){
        const view=await updateView();if(updateActive(view?.job)){
          if(req.method==='GET'&&(pathname===prefix||pathname===prefix+'index.html'||pathname===prefix+'maintenance.css')){const css=pathname.endsWith('maintenance.css');res.writeHead(css?200:503,{'Content-Type':css?'text/css; charset=utf-8':'text/html; charset=utf-8','Retry-After':'3'});return res.end(css?updatePageCss:updatePage(entrance.value));}
          return json(res,503,{updating:true,error:'升级中，请等待'});
        }
      }
      const subscriptionMatch=/^\/sub\/([A-Za-z0-9_-]{24,128})$/.exec(pathname);
      if(req.method==='GET'&&subscriptionMatch){
        if(options.origin&&!requestOrigin(req))return json(res,404,{error:'Not found'});
        if(!subscriptionLimiter.allow(req.socket.remoteAddress))return json(res,429,{error:'请求过于频繁'});
        const result=subscription(store,subscriptionMatch[1]);if(!result)return json(res,404,{error:'Not found'});
        res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','subscription-userinfo':result.userinfo,'profile-title':'base64:'+Buffer.from(result.title).toString('base64'),'Content-Disposition':"attachment; filename=subscription.txt; filename*=UTF-8''"+encodeURIComponent(result.title+'.txt').replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase())});return res.end(result.body);
      }
      // Deliberately do not normalize or redirect malformed/escaped paths.
      if (!pathname.startsWith(prefix) || /%|\\|\/\//.test(pathname) || pathname.split('/').some(part => part === '.' || part === '..')) return json(res,404,{ error:'Not found' });
      const suffix = pathname.slice(prefix.length);
      const origin = options.origin ? requestOrigin(req) : `${tls ? 'https':'http'}://${req.headers.host}`;
      if (!options.origin) {
        let host; try { host = new URL(origin).hostname; } catch { throw new HttpError(400,'请求地址错误'); }
        if (!['127.0.0.1','localhost','[::1]'].includes(host)) throw new HttpError(421,'需要配置管理域名');
      } else if (!origin) throw new HttpError(421,'请求地址错误');
      if (req.headers.origin && req.headers.origin !== origin) throw new HttpError(403,'请求来源错误');
      if(req.method==='GET'&&suffix==='maintenance.css'){res.writeHead(200,{'Content-Type':'text/css; charset=utf-8'});return res.end(updatePageCss);}
      if(req.method==='GET'&&suffix==='appearance.css'){
        const value=appearanceView(store),css=value.hasBackground?`.login-page{background-image:linear-gradient(90deg,#14294a44,#14294a11),url('${prefix}appearance/background.png')}`:'';
        res.writeHead(200,{'Content-Type':'text/css; charset=utf-8'});return res.end(css);
      }
      if(req.method==='GET'&&/^appearance\/(logo|background)\.png$/.test(suffix)){
        const data=appearanceAsset(store,options.directory||resolve('data'),suffix.includes('logo')?'logo':'background');
        if(!data)return json(res,404,{error:'Not found'});res.writeHead(200,{'Content-Type':'image/png','Content-Length':data.length});return res.end(data);
      }
      if (req.method === 'GET' && assets.has(suffix)) {
        const [file, type] = assets.get(suffix);
        const data = readFileSync(join(publicDirectory,file));
        res.writeHead(200,{'Content-Type':type,'Content-Length':data.length}); return res.end(data);
      }
      if (req.method === 'GET' && suffix === 'api/meta') return json(res,200,metadata());
      if(req.method==='POST'&&suffix==='api/bootstrap'){
        if(!loginLimiter.allow(req.socket.remoteAddress))throw new HttpError(429,'请求过于频繁，请稍后再试');
        const data=await body(req),access=store.get('bootstrap-access');
        if(!['welcome','account'].includes(onboarding.view().step)||!access||access.expires<=store.clock()||typeof data.token!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(data.token)||digest(data.token)!==access.hash)throw new HttpError(401,'首次激活链接已失效，请在SSH输入llhh，选择查看入口重新获取');
        const raw=token(),csrf=token();store.transaction(()=>{store.set('bootstrap-access',null);store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(raw),csrf,store.clock()+10*3600000);store.audit('使用首次设置链接');});
        return json(res,200,{csrf,...metadata()},{'Set-Cookie':`vps_session=${raw}; Path=${prefix}; HttpOnly; SameSite=Strict; Max-Age=36000${tls?'; Secure':''}`});
      }
      if (req.method === 'POST' && suffix === 'api/login') {
        if (!loginLimiter.allow(req.socket.remoteAddress) || pendingLogins >= 4) {
          enqueueEvent(store,'login.failures',{body:'管理登录尝试过于频繁，已触发限速。'});
          throw new HttpError(429,'尝试过于频繁，请稍后重试');
        }
        const data = await body(req);
        if (typeof data.username !== 'string' || typeof data.password !== 'string' || data.username.length > 80 || data.password.length===0) throw new HttpError(400,'账户格式错误');
        const admin = store.db.prepare('SELECT * FROM admin WHERE id=1').get();
        pendingLogins++;
        let valid;
        try { valid = await verifyPassword(data.password,admin.password); } finally { pendingLogins--; }
        if (!valid || data.username !== admin.username) { store.audit('登录失败'); throw new HttpError(401,'用户名或密码不正确'); }
        try {unlinkSync(join(options.directory||resolve('data'),'.bootstrap.json'));} catch(error) {if(error.code!=='ENOENT')store.audit('首次凭证文件清理失败');}
        const raw = token(), csrf = token();
        const ttl = data.remember === true ? 7 * DAY : 10 * 3600000;
        store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(raw),csrf,store.clock()+ttl);
        store.audit('登录成功');
        return json(res,200,{ csrf, ...metadata(),username:admin.username },{'Set-Cookie':`vps_session=${raw}; Path=${prefix}; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttl/1000)}${tls ? '; Secure':''}`});
      }
      const cookie = String(req.headers.cookie || '').split(';').map(item=>item.trim()).find(item=>item.startsWith('vps_session='))?.slice(12);
      const session = store.session(cookie);
      if (!session) throw new HttpError(401,'请先登录');
      if (!['GET','HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== session.csrf) throw new HttpError(403,'操作验证失败，请刷新后重试');
      if (req.method === 'GET' && suffix === 'api/session') return json(res,200,{ csrf:session.csrf,...metadata(),username:store.db.prepare('SELECT username FROM admin WHERE id=1').get().username });
      const mandatory=requiredUpdate(await updateView());
      if(mandatory&&!['api/updates','api/updates/logs','api/logout'].includes(suffix))return json(res,423,{error:'发现紧急安全更新，请先完成更新',mandatoryUpdate:true,update:mandatory});
      if(suffix==='api/onboarding'){
        if(req.method==='GET')return json(res,200,{...onboarding.view(),meta:metadata()});
        if(req.method==='POST'){
          const result=await onboarding.advance(await body(req)),issued=result.session;delete result.session;
          if(issued)try{unlinkSync(join(options.directory||resolve('data'),'.bootstrap.json'));}catch(error){if(error.code!=='ENOENT')store.audit('首次凭证文件清理失败');}
          return json(res,result.job?.state==='running'?202:200,{...result,meta:metadata(),...(issued?{csrf:issued.csrf}:{})},issued?{'Set-Cookie':`vps_session=${issued.raw}; Path=${prefix}; HttpOnly; SameSite=Strict; Max-Age=36000${tls?'; Secure':''}`}:{ });
        }
      }
      if(req.method==='POST'&&suffix==='api/service-setup'){
        if(!systemRequest)throw new HttpError(501,'服务配置需要连接服务器管理器');
        return json(res,202,await onboarding.apply(await body(req)));
      }
      if(suffix==='api/pairing'){
        if(req.method==='GET')return json(res,200,pairing.view());
        if(req.method==='POST'){if(!systemRequest)throw new HttpError(501,'配对需要连接服务器管理器');return json(res,200,await pairing.action(await body(req,8192)));}
      }
      if (req.method === 'POST' && suffix === 'api/logout') {
        store.db.prepare('DELETE FROM sessions WHERE token=?').run(session.token);
        return json(res,200,{ ok:true },{'Set-Cookie':`vps_session=; Path=${prefix}; HttpOnly; SameSite=Strict; Max-Age=0${tls ? '; Secure':''}`});
      }
      if(req.method==='POST'&&suffix==='api/entrance/rotate'){const data=await body(req);if(data.confirmed!==true)throw new HttpError(409,'请确认立即更换入口，当前登录将失效');if(updateActive((await updateView())?.job))throw new HttpError(409,'更新期间不能更换入口');const next=store.rotateEntrance();return json(res,200,{url:origin+'/'+next.value+'/'});}
      if (req.method === 'GET' && suffix === 'api/settings') return json(res,200,{ ...store.get('settings'), nextRotation: store.get('entrance').changed + store.get('settings').rotationDays*DAY });
      if(req.method==='GET'&&suffix==='api/appearance')return json(res,200,appearanceView(store));
      if(req.method==='PUT'&&suffix==='api/appearance')return json(res,200,configureAppearance(store,options.directory||resolve('data'),await body(req,4*1024*1024)));
      if (req.method === 'PATCH' && suffix === 'api/settings') {
        const next = validateSettings(await body(req),store.get('settings'));
        store.transaction(()=>{ store.set('settings',next); store.audit('修改面板设置'); });
        return json(res,200,next);
      }
      if (req.method === 'POST' && suffix === 'api/setup') {
        if(onboarding.view().active)throw new HttpError(409,'请继续完成首次引导');
        if (store.get('onboarded')) throw new HttpError(409,'初始配置已经完成');
        const data = await body(req);
        if (!['relay','exit'].includes(data.role) || Object.keys(data).some(key=>!['role','serverName'].includes(key))) throw new HttpError(400,'角色配置错误');
        const name = text(data.serverName,'服务器名称',{ max:48 });
        // The first-use role must also reach the privileged configuration before onboarding completes.
        if(systemRequest&&store.get('settings').role!==data.role)await switchRole(store,{role:data.role,confirmed:true},systemRequest);
        store.transaction(()=>{ store.set('settings',{...store.get('settings'),role:data.role,serverName:name}); store.set('onboarded',true); store.audit('完成初始化',{ role:data.role }); });
        return json(res,200,metadata());
      }
      if (req.method === 'POST' && suffix === 'api/account') {
        const data = await body(req);
        const admin = store.db.prepare('SELECT * FROM admin WHERE id=1').get();
        if (typeof data.currentPassword !== 'string' || !await verifyPassword(data.currentPassword,admin.password)) throw new HttpError(403,'当前密码不正确');
        const username = text(data.username,'管理员名称',{ max:48 });
        if (typeof data.password !== 'string' || data.password.length===0) throw new HttpError(400,'新密码不能为空');
        const password = await hashPassword(data.password);
        store.transaction(()=>{store.db.prepare('UPDATE admin SET username=?,password=? WHERE id=1').run(username,password);store.db.exec('DELETE FROM sessions');store.audit('管理员凭证已修改');});
        return json(res,200,{ ok:true, loginRequired:true });
      }
      if (req.method === 'GET' && suffix === 'api/overview') {
        const users = userRows();
        const status=store.get('service-status'),fresh=status&&store.clock()-status.at<=20000;
        return json(res,200,{ ...metadata(), runtime:store.get('runtime'), users:users.length, activeUsers:users.some(user=>user.online!==null)?users.filter(user=>user.online).length:null,
          traffic:store.db.prepare('SELECT COALESCE(SUM(up+down),0) AS total FROM line_periods').get().total, speedUp:users.some(user=>user.speedUp!==null)?users.reduce((sum,user)=>sum+(user.speedUp||0),0):null,speedDown:users.some(user=>user.speedDown!==null)?users.reduce((sum,user)=>sum+(user.speedDown||0),0):null,
          cores:['vmess.att','vmess.direct','hy2.att','hy2.direct'].map(id=>({id,name:`${id.startsWith('hy2')?'Hy2':'TCP'} · ${id.endsWith('att')?'ATT':'直出'}`,status:fresh?(status.profiles[id]?.active?'运行中':'已停止'):'状态未知'})),
          host:{ adapter:systemRequest?'Linux管理器':'本地开发',systemChangesEnabled:!!systemRequest }, deploymentReady:!!readSecret(store,'relay-config'),configuration:relayView(store),telemetry:store.get('host-telemetry')||null,trend:store.get('traffic-samples')||[] });
      }
      if (req.method === 'GET' && suffix === 'api/users') return json(res,200,{ users:userRows(),deleted:deletedUsage(store),monthlyUsage:monthlyUserUsage(store) });
      if(req.method==='GET'&&suffix==='api/line-catalog')return json(res,200,{lines:catalog(store)});
      if(suffix==='api/subscription-settings'){
        if(req.method==='GET')return json(res,200,subscriptionSettings(store));
        if(req.method==='PUT')return json(res,200,saveSubscriptionSettings(store,await body(req)));
      }
      if (req.method === 'GET' && suffix === 'api/line-usage') return json(res,200,lineUsage(store));
      if(req.method==='GET'&&suffix==='api/health')return json(res,200,health.view());
      if(req.method==='GET'&&suffix==='api/notification-relay')return json(res,200,notificationRelayStatus(store));
      if(req.method==='GET'&&suffix==='api/history')return json(res,200,readHistory(store,new URL(req.url,'http://localhost').searchParams.get('range')||'5m'));
      if (req.method === 'GET' && suffix === 'api/integration') return json(res,200,nodeSnapshot(store));
      if (req.method === 'POST' && suffix === 'api/users') {
        if (store.get('settings').role !== 'relay') throw new HttpError(409,'出口机不管理代理用户');
        if (!store.get('onboarded')) throw new HttpError(409,'请先完成初始配置');
        const value = validateUser(await body(req));
        const id = randomUUID();
        const credentials = store.seal(JSON.stringify({ vmess:randomUUID(),hy2:token(),subscription:token() }));
        store.transaction(()=>{store.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)').run(id,value.name,Number(value.enabled),JSON.stringify(value.protocols),JSON.stringify(value.exits),value.quota,value.expires,credentials,store.clock());saveLines(store,id,value.lines);store.audit('添加用户',{ id });});
        indexSubscriptions(store);
        return json(res,201,{ user:userRows().find(user=>user.id===id), message:readSecret(store,'relay-config')?'用户已保存，运行线路的权限由后台同步':'用户已保存，请配置协议线路后再生成链接' });
      }
      const userMatch = /^api\/users\/([a-f0-9-]{36})$/.exec(suffix);
      if(userMatch&&req.method==='GET'){
        const user=userRows().find(user=>user.id===userMatch[1]);if(!user)throw new HttpError(404,'用户不存在');
        return json(res,200,{user,usage:userUsage(store,user.id),lines:catalog(store)});
      }
      if(userMatch&&req.method==='DELETE'){
        if(store.get('settings').role!=='relay')throw new HttpError(409,'出口机不管理代理用户');
        if((await body(req)).confirmed!==true)throw new HttpError(409,'删除后原订阅失效，请确认');
        return json(res,202,deleteUser(store,userMatch[1]));
      }
      if (userMatch && req.method === 'PATCH') {
        if (store.get('settings').role !== 'relay') throw new HttpError(409,'出口机不管理代理用户');
        const prior=store.db.prepare('SELECT * FROM users WHERE id=?').get(userMatch[1]);
        if (!prior) throw new HttpError(404,'用户不存在');
        const data=await body(req);
        const priorLines=linePermissions(store,prior.id),merged={name:prior.name,enabled:!!prior.enabled,protocols:JSON.parse(prior.protocols),exits:JSON.parse(prior.exits),quota:prior.quota,expires:prior.expires,...data};
        if(!('lines'in data)&&priorLines!==undefined)merged.lines=priorLines.filter(id=>merged.protocols.includes(id.split('.')[0])&&merged.exits.includes(id.split('.')[1]));
        const value=validateUser(merged);
        store.transaction(()=>{store.db.prepare('UPDATE users SET name=?,enabled=?,protocols=?,exits=?,quota=?,expires=? WHERE id=?').run(value.name,Number(value.enabled),JSON.stringify(value.protocols),JSON.stringify(value.exits),value.quota,value.expires,prior.id);saveLines(store,prior.id,value.lines);store.audit('修改用户',{id:prior.id});});
        return json(res,200,{ user:userRows().find(user=>user.id===prior.id) });
      }
      const linksMatch=/^api\/users\/([a-f0-9-]{36})\/links$/.exec(suffix);
      const resetMatch=/^api\/users\/([a-f0-9-]{36})\/reset-credentials$/.exec(suffix);
      if(req.method==='POST'&&resetMatch){
        const data=await body(req);if(data.confirmed!==true)throw new HttpError(409,'重置后旧线路和订阅立即失效，请确认');
        const user=store.db.prepare('SELECT id FROM users WHERE id=?').get(resetMatch[1]);if(!user)throw new HttpError(404,'用户不存在');
        store.db.prepare('UPDATE users SET credentials=? WHERE id=?').run(store.seal(JSON.stringify({vmess:randomUUID(),hy2:token(),subscription:token()})),user.id);
        indexSubscriptions(store);store.audit('重置用户凭证',{id:user.id});return json(res,200,{ok:true});
      }
      if(req.method==='GET'&&linksMatch){
        const user=userRows().find(user=>user.id===linksMatch[1]),config=readSecret(store,'relay-config');
        if(!user)throw new HttpError(404,'用户不存在');if(!config)throw new HttpError(409,'请先配置线路');
        const row=store.db.prepare('SELECT credentials FROM users WHERE id=?').get(user.id);
        const credentials=JSON.parse(store.unseal(row.credentials)),origin=options.origin||`${tls?'https':'http'}://${req.headers.host}`;
        const links=await Promise.all(clientLinks(config,{...user,credentials},linkPresentation(store)).map(async link=>({...link,qr:await QRCode.toDataURL(link.url,{width:260,margin:1,errorCorrectionLevel:'M'})})));
        const title=subscriptionSettings(store).title;
        return json(res,200,{links,subscriptionName:title,subscriptionUrl:subscriptionAddress(origin,credentials.subscription,title),enabled:user.enabled});
      }
      if(req.method==='GET'&&suffix==='api/network')return json(res,200,networkView(store));
      if(req.method==='GET'&&suffix==='api/peers')return json(res,200,peerView(store));
      if(req.method==='GET'&&suffix==='api/relay')return json(res,200,relayView(store));
      if(req.method==='POST'&&suffix==='api/uninstall'){
        if(!systemRequest)throw new HttpError(501,'此实例没有系统卸载权限');
        const data=await body(req);if(data.confirmed!==true||typeof data.purgeData!=='boolean')throw new HttpError(409,'请确认卸载和数据保留方式');
        store.set('runtime',{maintenance:true,emergencyStop:true});store.audit('请求卸载面板',{purgeData:data.purgeData});
        return json(res,202,await systemRequest('uninstall',{confirmed:true,purgeData:data.purgeData}));
      }
      if(req.method==='GET'&&suffix==='api/updates/logs'){if(!systemRequest)throw new HttpError(501,'未连接系统管理器');return json(res,200,await systemRequest('update-logs'));}
      if(suffix==='api/updates'){
        if(!systemRequest)throw new HttpError(501,'更新功能需要Linux系统管理器');
        if(req.method==='GET'){let status;try{status=await systemRequest('update-status');}catch(error){if(mandatory)return json(res,200,mandatory);throw error;}const required=requiredUpdate(status);return json(res,200,required?{...status,...required}:status);}
        if(req.method==='PUT')throw new HttpError(405,'更新来源已内置，无需配置');
        if(req.method==='POST'){
          const data=await body(req);if(!['check','update','rollback','reserve','cancel'].includes(data.action))throw new HttpError(400,'更新操作错误');
          if(mandatory&&!['check','update'].includes(data.action))return json(res,423,{error:'紧急安全更新不能跳过或预约',mandatoryUpdate:true,update:mandatory});
          const result=await systemRequest(data.action==='check'?'update-status':data.action==='update'?'update-start':data.action==='reserve'?'update-reserve':data.action==='cancel'?'update-cancel':'update-rollback',{check:true,confirmed:data.confirmed,at:data.at});
          updateStatusAt=0;if(data.action==='update')updateStatusCache={job:{step:'queued'}};
          if(data.action==='check')requiredUpdate(result);else if(data.action==='update')emitUpdateNotice(store,'upcoming',result.at||Date.now(),{version:result.version||'',detail:'更新即将开始，线路会短暂暂停。'});else if(data.action==='reserve')emitUpdateNotice(store,'upcoming',data.at+':'+result.version,{version:result.version||'',at:data.at});
          store.audit('执行面板更新操作',{action:data.action});return json(res,data.action==='check'?200:202,result);
        }
      }
      if(suffix==='api/panel-network'){
        if(!systemRequest)throw new HttpError(501,'管理连接设置需要Linux系统管理器');
        if(req.method==='GET')return json(res,200,await systemRequest('panel-status'));
        if(req.method==='PUT'){
          const result=await systemRequest('panel-configure',await body(req));
          store.audit('请求变更管理连接');return json(res,202,{...result,url:result.origin+'/'+store.get('entrance').value+'/'});
        }
      }
      if(req.method==='POST'&&suffix==='api/role'){
        if(!systemRequest)throw new HttpError(501,'此实例未连接Linux系统管理器');
        const result=await switchRole(store,await body(req),systemRequest);
        if(result.changed&&store.get('settings').uiVersion>=2){
          if(store.get('relay-config'))store.set('relay-pending',store.get('relay-config'));
          for(const key of['relay-config','network-config','auth-services','access-applied','service-status','live-traffic'])store.set(key,null);
          resumeSetup(store);
        }
        indexSubscriptions(store);
        return json(res,200,{...result,...metadata()});
      }
      if(suffix==='api/certificate'){
        if(!systemRequest)throw new HttpError(501,'证书功能需要Linux系统管理器');
        if(req.method==='GET'){
          const status=await systemRequest('certificate-status'),saved=readSecret(store,'certificate-settings');
          return json(res,200,saved&&!status.configured?{...status,configured:true,importPending:true,domain:saved.domain,email:saved.email,zoneId:saved.zoneId,staging:saved.staging}:status);
        }
        if(req.method==='PUT'){
          const data=await body(req),saved=readSecret(store,'certificate-settings');
          data.domain=text(data.domain,'代理域名',{max:253}).toLowerCase();for(const key of['token','email','zoneId'])if(typeof data[key]==='string')data[key]=data[key].trim();
          if(!data.zoneId)data.zoneId=saved?.domain===data.domain?saved.zoneId:await onboarding.zone(data.domain,data.token||saved?.token);
          const result=await systemRequest('certificate-configure',{...data,token:data.token||saved?.token});
          // CF token remains encrypted on both sides and is never returned to the browser.
          const previous=readSecret(store,'certificate-settings')||{};
          store.set('certificate-settings',store.seal(JSON.stringify({...previous,...data,token:data.token||previous.token})));
          store.audit('保存自动证书设置');return json(res,200,result);
        }
        if(req.method==='POST'){store.audit('请求签发证书');return json(res,202,await systemRequest('certificate-issue'));}
      }
      if(suffix==='api/tcp-acceleration'){
        if(!systemRequest)throw new HttpError(501,'此实例未连接Linux系统管理器');
        if(req.method==='GET')return json(res,200,await systemRequest('tcp-acceleration-status'));
        if(req.method==='PUT'){const data=await body(req);if(Object.keys(data).length!==1||!['off','bbr','bbrx'].includes(data.mode))throw new HttpError(400,'请选择关闭、BBR或BBRX');store.audit('切换TCP加速',{mode:data.mode});return json(res,202,await systemRequest('tcp-acceleration-set',data));}
      }
      if(['api/network','api/relay','api/services','api/system/inspect'].includes(suffix)){
        if(!systemRequest)throw new HttpError(501,'此实例未连接Linux系统管理器');
        if(req.method==='GET'&&suffix==='api/system/inspect')return json(res,200,await systemRequest('inspect'));
        if(req.method==='GET'&&suffix==='api/services'){const status=await systemRequest('status');return json(res,200,{...status,connections:connectionStates(store,status),runtime:store.get('runtime'),autoStart:store.get('settings').autoStart,autoRepair:store.get('settings').autoRepair});}
        if(req.method==='PUT'&&suffix==='api/network'){const result=await saveNetwork(store,await body(req),systemRequest);health.sample(true);return json(res,200,result);}
        if(req.method==='PUT'&&suffix==='api/relay'){const result=await saveRelay(store,await body(req),systemRequest);health.sample(true);return json(res,200,result);}
        if(req.method==='POST'&&suffix==='api/services'){const input=await body(req);if(Object.hasOwn(input,'expectedAutomationToken'))throw new HttpError(400,'此字段仅供本机自动配置使用');const result=await serviceAction(store,input,systemRequest);health.sample(true);return json(res,200,result);}
      }
      if (req.method === 'GET' && suffix === 'api/audit') return json(res,200,{ entries:store.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 100').all().map(row=>({...row,detail:JSON.parse(row.detail)})) });
      if(req.method==='GET'&&suffix==='api/diagnostics'){
        if(!systemRequest)throw new HttpError(501,'系统日志需要Linux系统管理器');
        return json(res,200,await diagnostics(store,systemRequest));
      }
      if (req.method==='GET'&&suffix==='api/bark') return json(res,200,barkStatus(store));
      if(req.method==='GET'&&suffix==='api/notification-settings')return json(res,200,notificationSettingsView(store));
      if(req.method==='PUT'&&suffix==='api/notification-settings')return json(res,200,saveNotificationProfile(store,await body(req)));
      if(req.method==='POST'&&suffix==='api/notification-control')return json(res,200,setNotificationEnabled(store,await body(req)));
      if(req.method==='POST'&&suffix==='api/notification-test'){
        if(!notificationTestLimiter.allow('manual-tests'))throw new HttpError(429,'测试发送过于频繁，请稍后再试');
        const message=notificationTestMessage(store,await body(req)),encoded=store.get('bark');if(!encoded)throw new HttpError(409,'请先保存上方Bark推送链接');
        try{await sendBark(JSON.parse(store.unseal(encoded)),message,{fetchImpl:options.fetchImpl});}catch{throw new HttpError(502,'测试通知未被Bark受理，请检查推送链接后重试');}
        store.audit('手动发送通知项目测试');return json(res,200,{accepted:true});
      }
      if(req.method==='GET'&&suffix==='api/alert-rules')return json(res,200,alertRules(store));
      if(req.method==='PUT'&&suffix==='api/alert-rules'){
        try{return json(res,200,configureAlertRules(store,await body(req)));}catch(error){if(error instanceof HttpError)throw error;throw new HttpError(400,error.message);}
      }
      if (req.method==='PUT'&&suffix==='api/bark') return json(res,200,configureBark(store,await body(req),{allowLocalHttp:!!options.allowLocalBark}));
      if (req.method==='POST'&&suffix==='api/bark/test') {
        const encoded=store.get('bark');if(!encoded)throw new HttpError(409,'请先保存 Bark 配置');
        try {await sendBark(JSON.parse(store.unseal(encoded)),{title:`【${store.get('settings').serverName}】推送通道测试`,body:'本条消息用于验证 Bark 通道。服务受理不代表设备已收到。'},{fetchImpl:options.fetchImpl});}
        catch {throw new HttpError(502,'Bark 未受理测试消息，请检查配置');}
        store.audit('Bark 测试消息已受理');return json(res,200,{accepted:true});
      }
      if (req.method==='GET'&&suffix==='api/events') return json(res,200,{events:store.db.prepare('SELECT id,at,type,status,attempts FROM events ORDER BY at DESC LIMIT 100').all()});
      if(req.method==='POST'&&suffix==='api/backup/export') {
        const data=await body(req);return json(res,200,exportBackup(store,{full:data.full===true,password:data.password}));
      }
      if(req.method==='POST'&&suffix==='api/backup/preview') {
        const data=await body(req,8*1024*1024);return json(res,200,previewBackup(data.backup,{password:data.password}));
      }
      if(req.method==='POST'&&suffix==='api/backup/import') {
        const data=await body(req,8*1024*1024);
        const prepared=importBackup(store,data.backup,{password:data.password,mode:data.mode,confirmed:data.confirmed,allowLocalHttp:!!options.allowLocalBark,validateOnly:true});
        // Stop actual processes before the import transaction; a stopped intention alone is insufficient.
        if(systemRequest&&data.confirmed===true){
          store.set('runtime',{...store.get('runtime'),maintenance:true});await systemRequest('emergency-stop');
          if(prepared.role!==store.get('settings').role)await systemRequest('switch-role',{role:prepared.role,confirmed:true});
        }
        const result=importBackup(store,data.backup,{password:data.password,mode:data.mode,confirmed:data.confirmed,allowLocalHttp:!!options.allowLocalBark});
        if(systemRequest)store.set('runtime',{maintenance:true,emergencyStop:true});
        for(const key of['relay-config','relay-pending','network-config','auth-services','access-applied','service-status','live-traffic'])store.set(key,null);
        if(store.get('settings').uiVersion>=2)resumeSetup(store);
        indexSubscriptions(store);
        return json(res,200,{...result,...metadata()});
      }
      if(req.method==='POST'&&suffix==='api/backup/rollback'){
        const data=await body(req),prepared=rollbackImport(store,{confirmed:data.confirmed,validateOnly:true});
        if(systemRequest){await systemRequest('emergency-stop');if(prepared.role!==store.get('settings').role)await systemRequest('switch-role',{role:prepared.role,confirmed:true});}
        const result=rollbackImport(store,{confirmed:true});
        // Local root configuration may have changed since the import. Require fresh confirmation.
        for(const key of['relay-config','relay-pending','network-config','auth-services','access-applied','service-status','live-traffic'])store.set(key,null);
        if(store.get('settings').uiVersion>=2)resumeSetup(store);
        indexSubscriptions(store);return json(res,200,{...result,requiresPairing:true,...metadata()});
      }
      // Never fake successful deployment or system actions in development mode.
      if (['api/services','api/pairing','api/role'].some(path=>suffix===path || suffix.startsWith(path+'/'))) throw new HttpError(501,'此功能正在开发，尚未接入系统管理器');
      return json(res,404,{ error:'Not found' });
    } catch (error) {
      if (res.headersSent) return res.destroy();
      json(res,error instanceof HttpError ? error.status : error.code==='AGENT_ERROR'?502:500,{ error:error instanceof HttpError||error.code==='AGENT_ERROR' ? error.message : '操作未完成，请查看诊断记录' });
    }
  };
  const server = tls ? https.createServer(tls,handler) : http.createServer(handler);
  server.requestTimeout=15000; server.headersTimeout=10000;
  function maintenance() {
    const config = store.get('settings'), entrance=store.get('entrance');
    if (store.clock()>=entrance.changed+config.rotationDays*DAY) store.rotateEntrance();
    store.db.prepare('DELETE FROM sessions WHERE expires<=?').run(store.clock());
    store.db.prepare('DELETE FROM audit WHERE at<?').run(store.clock()-config.logRetentionDays*DAY);
  }
  let dispatching=false;
  function flushEvents(){if(dispatching)return;dispatching=true;return dispatchEvents(store,{fetchImpl:options.fetchImpl,origin:options.origin,...(options.notificationTransport?{delegate:event=>delegateNotification(store,event,{transport:options.notificationTransport,allowLocal:!!options.allowLocalPairing})}:{})}).catch(()=>{}).finally(()=>{dispatching=false;});}
  const timer=setInterval(()=>{
    try { maintenance(); } catch { /* Keep authentication fail-closed on maintenance errors. */ }
    onboarding.syncCertificate().catch(()=>{});
    flushEvents();
  },30000);
  timer.unref();const history=createHistorySampler(store);const health=createNodeHealth({store,request:systemRequest,enabled:options.healthEnabled??(options.production===true&&!!systemRequest),...options.healthOptions});
  return { server,store,maintenance,history,health,onboarding,pairing, async close() { clearInterval(timer);history.close();await health.close(); await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())); while(dispatching)await new Promise(resolve=>setTimeout(resolve,20));await onboarding.wait();store.close(); } };
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const cert=process.env.VPS_TLS_CERT, key=process.env.VPS_TLS_KEY;
  if (!!cert!==!!key) throw new Error('证书和私钥必须同时配置');
  const directory=resolve(process.env.VPS_DATA_DIR || 'data');
  const app=await createApp({ directory,production:process.env.NODE_ENV==='production',origin:process.env.VPS_ORIGIN,
    allowedOrigins:process.env.VPS_ALLOWED_ORIGINS?process.env.VPS_ALLOWED_ORIGINS.split(','):[],
    allowIpAccess:process.env.VPS_ALLOW_IP_ACCESS!=='0',
    systemRequest:process.env.VPS_AGENT_ENABLED==='1'?agentRequest:undefined,
    tls:cert?{cert:readFileSync(cert),key:readFileSync(key)}:undefined });
  const host=process.env.VPS_HOST || '127.0.0.1', port=Number(process.env.VPS_PORT || 18443);
  if (!cert && !['127.0.0.1','localhost','::1'].includes(host)) throw new Error('明文开发服务只能监听回环地址');
  app.server.listen(port,host,()=>{
    console.log(`管理服务已监听 ${cert?'https':'http'}://${host}:${app.server.address().port}；请通过本机应急命令查看完整入口。`);
    if (app.store.bootstrapPassword) {
      writeFileSync(join(directory,'.bootstrap.json'),JSON.stringify({username:'admin',password:app.store.bootstrapPassword}),{mode:0o600,flag:'wx'});
      console.log('首次凭证已保存到运行目录的 .bootstrap.json（仅本机账户可读），不会写入日志。');
      app.store.bootstrapPassword=undefined;
    }
  console.log(process.env.VPS_AGENT_ENABLED==='1'?'开发版本：系统管理已启用，代理默认停止；请完成网页配置后手动启动。':'开发预览：本机系统管理未启用。');
  });
  for (const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>{app.close().then(()=>process.exit(0));});
}
