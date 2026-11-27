export const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const bytes=value=>value>=1073741824?`${(value/1073741824).toFixed(2)} GB`:value>=1048576?`${(value/1048576).toFixed(1)} MB`:value>=1024?`${(value/1024).toFixed(1)} KB`:`${Math.round(value||0)} B`;
export const rate=value=>value===null||value===undefined?'—':bytes(value)+'/s';
const paths={dashboard:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',traffic:'M4 19h16 M7 15V9 M12 15V4 M17 15v-4',network:'M9 3h6v6H9z M3 15h6v6H3z M15 15h6v6h-6z M12 9v3 M6 15v-3h12v3',settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',bell:'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4',logs:'M6 3h12v18H6z M9 7h6 M9 11h6 M9 15h4',tools:'M14 6a5 5 0 0 0-6 6L3 17a3 3 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-4 4-4-4z',help:'M12 17v.01 M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5 M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20',refresh:'M3 12a9 9 0 0 1 15.36-6.36L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15.36 6.36L3 16 M8 16H3v5',arrow:'M5 12h14 M13 6l6 6-6 6',up:'M12 20V4 M6 10l6-6 6 6',down:'M12 4v16 M6 14l6 6 6-6',check:'M5 12l4 4L19 6',shield:'M12 2l8 4v6c0 6-8 10-8 10S4 18 4 12V6z M8 12l3 3 5-6',copy:'M8 8h13v13H8z M16 8V3H3v13h5',link:'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',plus:'M12 5v14 M5 12h14',search:'M21 21l-5-5 M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14',server:'M3 3h18v7H3z M3 14h18v7H3z M7 6v1 M7 17v1 M11 6h6 M11 17h6'};
export function icon(name){return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.help}"/></svg>`;}
export function tone(text){
 const value=String(text);
 if(/失败|异常|已过期|已用尽|流量已用完|急停|不可用|错误|失效/.test(value))return'bad';
 if(/未知|暂无|未部署|未获取|尚未|未配置|没有|未签发|尚未开通|等待|正在|维护|测试|即将|接近/.test(value))return'warn';
 if(/已停止|停用|离线|已关闭|未启用|线路未启动/.test(value))return'quiet';
 if(/正常|运行中|已部署|已开通|在线|就绪|有效|已签发|已配对|已启用|已保存|已受理|成功|已配置|已开启|允许运行|正式证书/.test(value))return'good';
 return'info';
}
export function badge(text,kind=tone(text)){return `<span class="badge status-badge ${kind}"><i aria-hidden="true"></i>${esc(text)}</span>`;}
export function progress(used,quota){
 const ratio=quota===null||quota===undefined?null:quota===0?100:Math.min(100,used/quota*100),color=ratio!==null&&ratio>=100?'bad':ratio!==null&&ratio>=80?'warn':'info';
 return `<div class="usage-cell"><div class="usage-numbers"><strong>${bytes(used)}</strong><span>/ ${quota===null||quota===undefined?'不限额':bytes(quota)}</span></div><div class="usage-track ${color}" role="progressbar" aria-label="流量额度使用比例" aria-valuemin="0" aria-valuemax="100" ${ratio===null?'aria-valuetext="未设置额度"':`aria-valuenow="${Math.round(ratio)}"`}><span style="width:${ratio===null?0:ratio.toFixed(2)}%"></span></div></div>`;
}
// Polls patch existing nodes; shell, focus, form values, open details and scroll containers survive.
export function patchHTML(target,markup){
 const template=document.createElement('template');template.innerHTML=markup;
 const key=node=>node?.nodeType===1?(node.getAttribute('data-key')||node.id||null):null;
 function patch(parent,fresh){
  let cursor=parent.firstChild;
  for(const source of [...fresh.childNodes]){
   const wanted=key(source);let current=cursor;
   if(wanted&&key(current)!==wanted)current=[...parent.childNodes].find(node=>key(node)===wanted)||null;
   if(!current||current.nodeType!==source.nodeType||current.nodeName!==source.nodeName||(wanted&&key(current)!==wanted)){
    const copy=source.cloneNode(true);parent.insertBefore(copy,cursor);cursor=copy.nextSibling;continue;
   }
   if(current!==cursor)parent.insertBefore(current,cursor);
   if(source.nodeType===3){if(current.nodeValue!==source.nodeValue)current.nodeValue=source.nodeValue;}
   else if(source.nodeType===1){
    if(source.hasAttribute('data-preserve')&&current.hasAttribute('data-preserve')){cursor=current.nextSibling;continue;}
    const field=['INPUT','SELECT','TEXTAREA'].includes(source.nodeName);
    for(const attr of [...current.attributes])if(!source.hasAttribute(attr.name)&&!['open','data-help-ready','data-selected','data-mobile-table','data-mobile-label','data-mobile-actions','data-busy','aria-busy'].includes(attr.name)&&!(field&&['value','checked','selected'].includes(attr.name)))current.removeAttribute(attr.name);
    for(const attr of [...source.attributes])if(!(field&&['value','checked','selected'].includes(attr.name))&&!(attr.name==='open'&&current.nodeName==='DETAILS')&&current.getAttribute(attr.name)!==attr.value)current.setAttribute(attr.name,attr.value);
    if(!field)patch(current,source);
   }
   cursor=current.nextSibling;
  }
  while(cursor){const next=cursor.nextSibling;cursor.remove();cursor=next;}
 }
 patch(target,template.content);
}
