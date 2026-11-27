const overlays=new Map();
export function showOverlay(node,{owner}={}){
 overlays.set(node,{owner});const parent=owner?.closest('dialog[open],[role=dialog][aria-modal=true]')||[...document.querySelectorAll('dialog[open]')].at(-1)||document.body;
 if(node.parentElement!==parent){if(node.hidePopover&&node.matches(':popover-open'))node.hidePopover();parent.append(node);}
 if(typeof node.showPopover==='function'){node.setAttribute('popover','manual');if(!node.matches(':popover-open'))node.showPopover();}
}
export function hideOverlay(node){if(!node)return;overlays.delete(node);if(node.hidePopover&&node.matches(':popover-open'))node.hidePopover();}
const wrapped=Symbol('feedback-wrapper'),pending=new WeakSet();let active=0,noticeTimer;
export function loadingMarkup(){return '<div class="connection-loader" role="status" aria-live="polite"><div class="spectrum" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><strong>正在获取面板数据</strong></div>';}
export function installFeedback(ctx){
 const status=document.createElement('div');status.id='task-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.hidden=true;document.body.append(status);
 function running(delta){active+=delta;clearTimeout(noticeTimer);if(active){noticeTimer=setTimeout(()=>{status.textContent='正在处理，请稍候…';status.hidden=false;showOverlay(status);},180);}else{hideOverlay(status);status.hidden=true;}}
 function bind(node,key){
  const original=node[key];if(typeof original!=='function'||original[wrapped])return;
  const handler=function(event){
   const control=key==='onsubmit'?(event.submitter||node.querySelector('button[type=submit],button:not([type])')):event.target.closest?.('button')||null;
   if(control&&pending.has(control)){event.preventDefault();event.stopImmediatePropagation();return;}
   let result;try{result=original.call(this,event);}catch(error){ctx.toast(error.message||'操作未完成，请重试');return;}
   if(!result||typeof result.then!=='function')return result;
   if(control){pending.add(control);control.dataset.busy='';control.setAttribute('aria-busy','true');}running(1);
   return Promise.resolve(result).catch(error=>ctx.toast(error.message||'操作未完成，请重试')).finally(()=>{if(control){pending.delete(control);delete control.dataset.busy;control.removeAttribute('aria-busy');}running(-1);});
  };handler[wrapped]=true;node[key]=handler;
 }
 function enhance(scope){for(const node of [scope,...scope.querySelectorAll('*')]){bind(node,'onclick');bind(node,'onsubmit');}}
 new MutationObserver(records=>{for(const r of records)for(const n of r.addedNodes)if(n.nodeType===1)enhance(n);}).observe(document.querySelector('#app'),{childList:true,subtree:true});
 new MutationObserver(records=>{for(const r of records)for(const n of r.addedNodes)if(n.nodeType===1&&n.matches('dialog'))enhance(n);}).observe(document.body,{childList:true});
 document.addEventListener('pointerdown',event=>{const button=event.target.closest?.('button,summary');if(!button||button.disabled)return;button.dataset.pressed='';setTimeout(()=>delete button.dataset.pressed,180);},true);
 new MutationObserver(()=>{for(const[node,options]of [...overlays]){if(options.owner&&!options.owner.isConnected){hideOverlay(node);node.remove();}else showOverlay(node,options);}}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open']});
 enhance(document.querySelector('#app'));
 return{enhance};
}
