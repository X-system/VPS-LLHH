import{saveLines}from'./line-permissions.mjs';
export function storedUsers(store){return store.db.prepare('SELECT u.*,l.lines AS line_permissions FROM users u LEFT JOIN user_lines l ON l.user_id=u.id ORDER BY u.created,u.id').all();}
export function restoreLineRows(store,rows){for(const row of rows)if(row.line_permissions!=null)saveLines(store,row.id,JSON.parse(row.line_permissions));}
export function ledgerSnapshot(store){return{userDays:store.db.prepare('SELECT * FROM user_days').all(),deletedDays:store.db.prepare('SELECT * FROM deleted_days').all()};}
export function restoreLedger(store,snapshot){
 store.db.exec('DELETE FROM user_days; DELETE FROM deleted_days;');
 for(const row of snapshot.userDays||[])store.db.prepare('INSERT INTO user_days VALUES(?,?,?,?,?)').run(row.user_id,row.day,row.period,row.up,row.down);
 for(const row of snapshot.deletedDays||[])store.db.prepare('INSERT INTO deleted_days VALUES(?,?,?,?)').run(row.day,row.period,row.up,row.down);
}
