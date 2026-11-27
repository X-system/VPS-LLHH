import{readdir}from'node:fs/promises';
import{join,resolve}from'node:path';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
const run=promisify(execFile),root=resolve(process.argv[2]||'.');let checked=0;
async function walk(directory){
 for(const entry of await readdir(directory,{withFileTypes:true})){
  const path=join(directory,entry.name);
  if(entry.isSymbolicLink())throw new Error('代码检查不允许符号链接');
  if(entry.isDirectory())await walk(path);
  else if(entry.isFile()&&/\.(?:mjs|js)$/.test(entry.name)){await run(process.execPath,['--check',path],{windowsHide:true,timeout:15000});checked++;}
 }
}
for(const name of['src','public','scripts'])await walk(join(root,name));
console.log(`语法检查通过：${checked} 个文件`);
