import { randomInt, randomBytes, scrypt, timingSafeEqual, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_~';
export function newEntrance() {
  for (;;) {
    const value = Array.from({ length: 20 }, () => alphabet[randomInt(alphabet.length)]).join('');
    if (/[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value) && /[-_~]/.test(value)) return value;
  }
}
export const token = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password, hash) {
  const [algorithm, salt, encoded] = String(hash).split('$');
  if (algorithm !== 'scrypt' || !salt || !/^[a-f0-9]{128}$/.test(encoded ?? '')) return false;
  const expected = Buffer.from(encoded, 'hex');
  const actual = await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(actual, expected);
}
export function encrypt(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('vps-panel.secret.v1'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}
export function decrypt(value, key) {
  const [version, iv, tag, body] = value.split('.');
  if (version !== 'v1') throw new Error('不支持的密钥格式');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from('vps-panel.secret.v1'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}
export class RateLimiter {
  constructor({ max = 8, window = 60_000, capacity = 4096, clock = Date.now } = {}) {
    Object.assign(this, { max, window, capacity, clock });
    this.attempts = new Map();
  }
  allow(key) {
    const now = this.clock();
    let record = this.attempts.get(key);
    if (!record || now - record.start >= this.window) {
      if (this.attempts.size >= this.capacity && !record) {
        for (const [id, entry] of this.attempts) if (now - entry.start >= this.window) this.attempts.delete(id);
        if (this.attempts.size >= this.capacity) return false;
      }
      record = { start: now, count: 0 };
      this.attempts.set(key, record);
    }
    return ++record.count <= this.max;
  }
}
