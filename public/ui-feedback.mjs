const overlays=new Map();
export function showOverlay(node,{owner}={}){
 overlays.set(node,{owner});const parent=owner?.closest('dialog[open],[role=dialog][aria-modal=true]')||[...document.querySelectorAll('dialog[open]')].at(-1)||document.body;
 if(node.parentElement!==parent){if(node.hidePopover&&node.matches(':popover-open'))node.hidePopover();parent.append(node);}
 if(typeof node.showPopover==='function'){node.setAttribute('popover','manual');if(!node.matches(':popover-open'))node.showPopover();}
}
export function hideOverlay(node){if(!node)return;overlays.delete(node);if(node.hidePopover&&node.matches(':popover-open'))node.hidePopover();}
const wrapped=Symbol('feedback-wrapper'),pending=new WeakSet(),messages=new WeakMap(),visibleMessages=new Set();let lastControl=null;
function descriptor(owner){return{ownerId:owner.id,formId:owner.closest('form')?.id,text:owner.textContent.trim(),dialog:!!owner.closest('dialog'),transient:!!owner.closest('[popover],.health-popup')};}
function replacement(key){if(key.dialog||key.transient)return null;if(key.ownerId)return document.getElementById(key.ownerId);const scope=key.formId?document.getElementById(key.formId):document;return [...(scope?.querySelectorAll('button')||[])].find(n=>n.textContent.trim()===key.text);}
function place(entry,owner){const actions=owner.closest('.actions,.settings-actions');if(actions)actions.append(entry.node);else(owner.closest('.check-row')||owner).insertAdjacentElement('afterend',entry.node);entry.owner=owner;messages.set(owner,entry);}
export function feedbackAnchor(){return lastControl?.isConnected?lastControl:lastControl?replacement(descriptor(lastControl)):null;}

export function actionFeedback(owner,message,{kind='success',duration=6000}={}){
 if(owner&&!owner.isConnected){owner=replacement(descriptor(owner));if(!owner)return;}
 owner=owner||feedbackAnchor();
 if(!owner){owner=document.querySelector('dialog[open] button,.page-heading button,#app button');}
 if(!owner)return;
 let entry=messages.get(owner);
 if(!entry||!entry.node.isConnected){
  const node=document.createElement('span');node.className='action-feedback';node.setAttribute('aria-live','polite');node.setAttribute('role','status');
  entry={node,key:descriptor(owner)};visibleMessages.add(entry);place(entry,owner);
 }
 clearTimeout(entry.timer);entry.kind=kind;entry.node.dataset.kind=kind;entry.node.textContent=message;
 if(duration&&kind!=='pending')entry.timer=setTimeout(()=>{entry.node.remove();visibleMessages.delete(entry);messages.delete(entry.owner);},duration);
 return entry;
}
function finishFeedback(owner){const entry=messages.get(owner);if(entry?.kind==='pending'){if(owner.isConnected)actionFeedback(owner,'操作已完成');else{entry.node.remove();visibleMessages.delete(entry);}}}
export function loadingMarkup(){return '<div class="connection-loader" role="status" aria-live="polite"><div class="spectrum" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><strong>正在获取面板数据</strong></div>';}
export function installFeedback(ctx){
 function bind(node,key){
  const original=node[key];if(typeof original!=='function'||original[wrapped])return;
  const handler=function(event){
   const control=key==='onsubmit'?(event.submitter||node.querySelector('button[type=submit],button:not([type])')):event.target.closest?.('button')||null;
   if(control&&pending.has(control)){event.preventDefault();event.stopImmediatePropagation();return;}
   if(control)lastControl=control;
   let result;try{result=original.call(this,event);}catch(error){actionFeedback(control,error.message||'操作未完成，请重试',{kind:'error'});return;}
   if(!result||typeof result.then!=='function')return result;
   if(control){pending.add(control);control.dataset.busy='';control.setAttribute('aria-busy','true');}const notice=control?setTimeout(()=>actionFeedback(control,'正在处理，请稍候…',{kind:'pending',duration:0}),180):null;
   return Promise.resolve(result).catch(error=>actionFeedback(control,error.message||'操作未完成，请重试',{kind:'error'})).finally(()=>{clearTimeout(notice);if(control){pending.delete(control);delete control.dataset.busy;control.removeAttribute('aria-busy');finishFeedback(control);}});
  };handler[wrapped]=true;node[key]=handler;
 }
 function enhance(scope){for(const node of [scope,...scope.querySelectorAll('*')]){bind(node,'onclick');bind(node,'onsubmit');}}
 new MutationObserver(records=>{for(const r of records)for(const n of r.addedNodes)if(n.nodeType===1)enhance(n);}).observe(document.querySelector('#app'),{childList:true,subtree:true});
 new MutationObserver(records=>{for(const r of records)for(const n of r.addedNodes)if(n.nodeType===1&&n.matches('dialog'))enhance(n);}).observe(document.body,{childList:true});
 document.addEventListener('pointerdown',event=>{const button=event.target.closest?.('button,summary');if(!button||button.disabled)return;if(button.matches('button:not(.help-trigger)'))lastControl=button;button.dataset.pressed='';setTimeout(()=>delete button.dataset.pressed,180);},true);
 new MutationObserver(()=>{for(const entry of visibleMessages){if(!entry.owner.isConnected){const owner=replacement(entry.key);if(owner)place(entry,owner);else if(entry.key.dialog||entry.key.transient){clearTimeout(entry.timer);entry.node.remove();visibleMessages.delete(entry);}}}for(const[node,options]of [...overlays]){if(options.owner&&!options.owner.isConnected){hideOverlay(node);node.remove();}else showOverlay(node,options);}}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open']});
 document.addEventListener('click',event=>{const control=event.target.closest?.('button:not(.help-trigger)');if(control)lastControl=control;},true);
 document.addEventListener('submit',event=>{lastControl=event.submitter||event.target.querySelector('button');},true);
 enhance(document.querySelector('#app'));
 return{enhance};
}
