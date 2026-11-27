export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function text(value, name, { min = 1, max = 80 } = {}) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new HttpError(400, `${name}格式不正确`);
  return value.trim();
}
export function settings(input, prior) {
  const allowed = new Set(['serverName', 'rotationDays', 'bandwidthMbps', 'logRetentionDays']);
  if (!input || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key))) throw new HttpError(400, '存在不支持的设置项');
  const result = { ...prior };
  if ('serverName' in input) result.serverName = text(input.serverName, '服务器名称', { max: 48 });
  for (const [key, min, max] of [['rotationDays',1,180],['bandwidthMbps',1,1000000],['logRetentionDays',1,365]]) {
    if (key in input) {
      if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max) throw new HttpError(400, `${key}必须在${min}至${max}之间`);
      result[key] = input[key];
    }
  }
  return result;
}
export function user(input) {
  if (!input || Array.isArray(input)) throw new HttpError(400, '用户格式错误');
  const allowed = new Set(['name','enabled','protocols','exits','quota','expires']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new HttpError(400, '存在不支持的用户字段');
  const name = text(input.name, '用户名称', { max: 48 });
  const protocols = input.protocols ?? ['hy2'];
  const exits = input.exits ?? ['att'];
  for (const [items, choices] of [[protocols,['hy2','vmess']],[exits,['att','direct']]]) {
    if (!Array.isArray(items) || !items.length || items.some(item => !choices.includes(item)) || new Set(items).size !== items.length) throw new HttpError(400, '协议或出口不正确');
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new HttpError(400, '启用状态不正确');
  for (const value of [input.quota,input.expires]) if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new HttpError(400, '额度或到期时间不正确');
  return { name, enabled: input.enabled ?? true, protocols, exits, quota: input.quota ?? null, expires: input.expires ?? null };
}
