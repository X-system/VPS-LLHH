import{HttpError}from'./validation.mjs';

export const lineIds=['vmess.att','vmess.direct','hy2.att','hy2.direct'];
export function checkLines(value){
 if(!Array.isArray(value)||value.some(id=>!lineIds.includes(id))||new Set(value).size!==value.length)throw new HttpError(400,'请选择有效且不重复的线路');
 return lineIds.filter(id=>value.includes(id));
}
export function allowsLine(user,id){
 const[protocol,exit]=id.split('.');
 return lineIds.includes(id)&&user.protocols.includes(protocol)&&user.exits.includes(exit)&&(!Array.isArray(user.lines)||user.lines.includes(id));
}
export function linePermissions(store,id){const row=store.db.prepare('SELECT lines FROM user_lines WHERE user_id=?').get(id);return row?JSON.parse(row.lines):undefined;}
export function saveLines(store,id,lines){if(lines!==undefined)store.db.prepare('INSERT INTO user_lines VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET lines=excluded.lines').run(id,JSON.stringify(checkLines(lines)));}
