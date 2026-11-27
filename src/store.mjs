import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword, newEntrance, token, digest, encrypt, decrypt } from './security.mjs';
import { addLineUsage } from './line-usage.mjs';
import { addUserUsage } from './user-ledger.mjs';

export async function openStore({ directory, password, clock = Date.now }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = join(directory, 'master.key');
  const path = join(directory, 'panel.sqlite');
  if(existsSync(path)&&!existsSync(keyPath))throw new Error('数据库存在但主密钥缺失，请恢复备份；不会生成新密钥覆盖原身份');
  if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error('主密钥格式错误，不能自动覆盖');
  const db = new DatabaseSync(path);
  if(db.prepare('PRAGMA user_version').get().user_version>2){db.close();throw new Error('数据库来自更新的版本，请使用匹配版本；不会降级修改数据');}
  chmodSync(path, 0o600);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, protocols TEXT NOT NULL, exits TEXT NOT NULL, quota INTEGER, expires INTEGER, credentials TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS subscriptions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS user_presence (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS user_lines (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, lines TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_days (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,day TEXT NOT NULL,period TEXT NOT NULL,up INTEGER NOT NULL,down INTEGER NOT NULL,PRIMARY KEY(user_id,day));
    CREATE TABLE IF NOT EXISTS deleted_days (day TEXT PRIMARY KEY,period TEXT NOT NULL,up INTEGER NOT NULL,down INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, event TEXT NOT NULL, detail TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS traffic (user_id TEXT NOT NULL, stream TEXT NOT NULL, epoch TEXT NOT NULL, up INTEGER NOT NULL, down INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(user_id,stream));
    CREATE TABLE IF NOT EXISTS totals (user_id TEXT PRIMARY KEY, up INTEGER NOT NULL DEFAULT 0, down INTEGER NOT NULL DEFAULT 0, last_activity INTEGER);
    CREATE TABLE IF NOT EXISTS line_periods (period TEXT NOT NULL,stream TEXT NOT NULL,up INTEGER NOT NULL,down INTEGER NOT NULL,first_at INTEGER NOT NULL,last_at INTEGER NOT NULL,PRIMARY KEY(period,stream));
    CREATE TABLE IF NOT EXISTS monitor_history (at INTEGER PRIMARY KEY,data TEXT NOT NULL);
    PRAGMA user_version=2;`);
  if (!db.prepare('PRAGMA table_info(events)').all().some(column=>column.name==='next_at')) db.exec('ALTER TABLE events ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0');
  const get = name => { const row = db.prepare('SELECT value FROM config WHERE key=?').get(name); return row ? JSON.parse(row.value) : undefined; };
  const set = (name, value) => db.prepare('INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value));
  if(get('line-metering-started')===undefined)set('line-metering-started',clock());
  if(get('user-metering-started')===undefined)set('user-metering-started',clock());
  let transactionDepth=0,savepointSequence=0;
  const transaction = fn => {
    const nested=transactionDepth>0,name='vps_sp_'+(++savepointSequence);
    db.exec(nested?'SAVEPOINT '+name:'BEGIN IMMEDIATE');transactionDepth++;
    try{const value=fn();db.exec(nested?'RELEASE SAVEPOINT '+name:'COMMIT');return value;}
    catch(error){if(nested){db.exec('ROLLBACK TO SAVEPOINT '+name);db.exec('RELEASE SAVEPOINT '+name);}else db.exec('ROLLBACK');throw error;}
    finally{transactionDepth--;}
  };
  const audit = (event, detail = {}) => db.prepare('INSERT INTO audit(at,event,detail) VALUES(?,?,?)').run(clock(), event, JSON.stringify(detail));
  let bootstrapPassword;
  if (!db.prepare('SELECT id FROM admin WHERE id=1').get()) {
    bootstrapPassword = password || token().slice(0, 24);
    const passwordHash=await hashPassword(bootstrapPassword);
    transaction(()=>{
    if(db.prepare('SELECT id FROM admin WHERE id=1').get()){bootstrapPassword=undefined;return;}
    db.prepare('INSERT INTO admin VALUES(1,?,?)').run('admin', passwordHash);
    set('settings', { serverName: '我的服务器', role: 'relay', rotationDays: 30, bandwidthMbps: 500, autoStart: false, autoRepair: false, logRetentionDays: 30 });
    set('entrance', { value: newEntrance(), changed: clock() });
    set('runtime', { maintenance: true, emergencyStop: false });
    set('identity', randomUUID());
    audit('初始化完成');
    });
  }
  function rotateEntrance() {
    return transaction(() => {
      const entrance = { value: newEntrance(), changed: clock() };
      set('entrance', entrance);
      db.exec('DELETE FROM sessions');
      audit('安全入口已轮换');
      // The new path is encrypted in the outbox, never in normal audit logs.
      db.prepare('INSERT INTO events(id,at,type,payload) VALUES(?,?,?,?)').run(randomUUID(), clock(), 'entrance.rotated', encrypt(JSON.stringify({ entrance: entrance.value }), key));
      return entrance;
    });
  }
  function applyTraffic({ userId, stream, epoch, up, down }) {
    for (const value of [up, down]) if (!Number.isSafeInteger(value) || value < 0) throw new Error('无效流量计数');
    if (!db.prepare('SELECT id FROM users WHERE id=?').get(userId)) throw new Error('未知用户');
    return transaction(() => {
      const prior = db.prepare('SELECT * FROM traffic WHERE user_id=? AND stream=?').get(userId, stream);
      const same = prior?.epoch === epoch;
      if (same && (up < prior.up || down < prior.down)) throw new Error('同一核心周期的计数不应倒退');
      const deltaUp = up - (same ? prior.up : 0), deltaDown = down - (same ? prior.down : 0);
      const total=db.prepare('SELECT up,down FROM totals WHERE user_id=?').get(userId)||{up:0,down:0};
      if(![total.up+deltaUp,total.down+deltaDown,total.up+deltaUp+total.down+deltaDown].every(Number.isSafeInteger))throw new Error('累计流量超出可精确计数范围');
      addLineUsage({db},{stream,up:deltaUp,down:deltaDown,at:clock()});
      addUserUsage({db},{userId,up:deltaUp,down:deltaDown,at:clock()});
      db.prepare('INSERT INTO traffic VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,stream) DO UPDATE SET epoch=excluded.epoch,up=excluded.up,down=excluded.down,at=excluded.at').run(userId, stream, epoch, up, down, clock());
      db.prepare('INSERT INTO totals(user_id,up,down,last_activity) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET up=up+excluded.up,down=down+excluded.down,last_activity=COALESCE(excluded.last_activity,last_activity)').run(userId, deltaUp, deltaDown, deltaUp + deltaDown ? clock() : null);
      return { up: deltaUp, down: deltaDown };
    });
  }
  db.prepare("DELETE FROM config WHERE key IN ('health-settings','health-probes')").run();
  return { directory,db, get, set, audit, transaction, rotateEntrance, applyTraffic, clock, bootstrapPassword,
    seal: value => encrypt(value, key), unseal: value => decrypt(value, key),
    session(raw) { return raw ? db.prepare('SELECT * FROM sessions WHERE token=? AND expires>?').get(digest(raw), clock()) : undefined; },
    close() { key.fill(0); db.close(); }
  };
}
