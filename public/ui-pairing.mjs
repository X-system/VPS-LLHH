import{actionFeedback}from'./ui-feedback.mjs';
import{esc}from'./ui-kit.mjs';
let prompted=null,notifying=false,shownError=null;

export async function pairingControls(container,ctx,options={}){
 const exit=ctx.state.meta.role==='exit',node=document.createElement('section');node.className='pairing-controls';container.append(node);
 node.innerHTML=exit?`<h3>连接中转端</h3><p>在中转端复制“ATT连接密钥”，粘贴到这里，然后回到中转端确认绑定。</p><label class="field">ATT连接密钥<textarea name="attKey" rows="3" placeholder="ATT1.…"></textarea></label><div class="actions"><button type="button" class="primary" data-connect>发送绑定请求</button><button type="button" data-cancel>取消请求</button></div>`:`<h3>连接ATT出口</h3><p>先在出口服务器安装本面板并选择“出口端”。将下面生成的密钥粘贴到出口面板，再回到这里确认绑定。</p><button type="button" class="primary" data-invite>生成ATT连接密钥</button><div data-invitation hidden><textarea readonly rows="3" aria-label="ATT连接密钥"></textarea><p>15分钟内有效，单次绑定使用。复制后粘贴到出口端。</p><button type="button" data-copy-key>复制密钥</button></div>`;
 node.insertAdjacentHTML('beforeend','<div class="pairing-status" role="status">正在检查配对状态…</div><div data-pairing-members></div><p class="form-error" role="alert" hidden></p>');
 const error=(message,owner)=>{if(owner){actionFeedback(owner,message,{kind:'error'});return;}const target=node.querySelector('[role=alert]');target.hidden=false;target.textContent=message;};
 let membershipSignature='',completed=false,pairingPending=false;
 const show=data=>{
  pairingPending=['waiting','configuring','applied'].includes(data.outgoing?.state)||['pending','approved'].includes(data.pending?.state);
  const status=node.querySelector('[role=status]');if(data.error)error(data.error);else node.querySelector('[role=alert]').hidden=true;status.textContent=data.error?data.error:data.pending?.state==='pending'?'已收到 '+data.pending.name+' 的绑定请求，请确认弹窗。':data.pending?.state==='approved'?'已批准接入ATT服务器，正在进行通信配置…':data.outgoing?.state==='waiting'?'绑定请求已发送，请在中转端确认。':['configuring','applied'].includes(data.outgoing?.state)?'中转服务器已批准接入，正在进行通信配置…':data.binding?'已配置完成：'+data.binding.name:(exit?'尚未连接中转端，可稍后再配对。':'尚未连接出口，可稍后再配对。');
  const summary=node.closest('[data-setting]')?.querySelector('.service-setting-summary-note');if(summary)summary.textContent=data.binding?'已配对：'+data.binding.name:'尚未配对，可按需连接';
  if(!completed&&!data.error&&(data.pending?.state==='bound'||data.outgoing?.state==='bound')){completed=true;status.textContent='已配置完成';if(options.onBound)setTimeout(()=>{if(node.isConnected)options.onBound().catch(e=>error(e.message));},650);}
  const signature=JSON.stringify([data.peers,data.binding]);if(signature!==membershipSignature){membershipSignature=signature;const members=node.querySelector('[data-pairing-members]');members.innerHTML=exit?(data.peers||[]).map(peer=>`<div class="pairing-member"><span>${esc(peer.name)}<small>已保存配对</small></span><button type="button" class="danger" data-disconnect="${esc(peer.publicKey)}">解除配对</button></div>`).join(''):data.binding||(data.peers||[]).length?'<p><button type="button" class="danger" data-disconnect="relay">解除当前出口配对</button></p>':'';}
 };
 const execute=async(button,data)=>{button.disabled=true;button.setAttribute('aria-busy','true');const label=button.textContent;button.textContent='正在处理…';node.querySelector('[role=status]').textContent=data.action==='connect'?'正在联系中转服务器并发送绑定请求…':'正在处理，请稍候…';try{const result=await ctx.api('pairing',{method:'POST',data});node.querySelector('[role=alert]').hidden=true;return result;}catch(e){error(e.message,button);}finally{button.disabled=false;button.removeAttribute('aria-busy');button.textContent=label;}};
 const invite=node.querySelector('[data-invite]');if(invite)invite.onclick=async()=>{const result=await execute(invite,{action:'invite'});if(result){const holder=node.querySelector('[data-invitation]');holder.hidden=false;holder.querySelector('textarea').value=result.key;}};
 const copy=node.querySelector('[data-copy-key]');if(copy)copy.onclick=async()=>{const text=node.querySelector('[data-invitation] textarea');try{await navigator.clipboard.writeText(text.value);ctx.toast('已复制，请到出口面板粘贴');}catch{text.focus();text.select();ctx.toast('请复制已选中的完整密钥');}};
 const connect=node.querySelector('[data-connect]');if(connect)connect.onclick=async()=>{const result=await execute(connect,{action:'connect',key:node.querySelector('[name=attKey]').value});if(result){node.querySelector('[name=attKey]').value='';show(result);}};
 const cancel=node.querySelector('[data-cancel]');if(cancel)cancel.onclick=async()=>{const result=await execute(cancel,{action:'cancel'});if(result)show(result);};
 node.addEventListener('click',async event=>{const button=event.target.closest('[data-disconnect]');if(!button)return;if(!confirm(exit?'解除这个中转配对？应用时隧道可能短暂重连。':'解除当前出口？程序会撤销ATT线路并重新检查直出，线路可能短暂重连。'))return;const result=await execute(button,{action:'disconnect',confirmed:true,...(exit?{publicKey:button.dataset.disconnect}:{})});if(result){show(result);ctx.toast('配对已解除，可以重新生成或粘贴连接密钥');}});
 let polling=false;
 const poll=async(force=false)=>{if(polling||!force&&!node.isConnected)return;polling=true;try{let state=await ctx.api('pairing');if(exit&&['waiting','configuring','applied'].includes(state.outgoing?.state))state=await ctx.api('pairing',{method:'POST',data:{action:'poll'}});show(state);}catch(e){error(e.message);}finally{polling=false;}};
 await poll(true);const timer=setInterval(()=>{if(!node.isConnected){clearInterval(timer);return;}if(document.visibilityState==='visible'||pairingPending){if(polling)ctx.api('pairing').then(show).catch(()=>{});else poll();}},3000);
}
export function installPairingNotifications(ctx){
 const check=async()=>{
  if(notifying||!ctx.state.csrf||ctx.state.meta?.role!=='relay'||document.visibilityState!=='visible')return;notifying=true;
  try{
   const data=await ctx.api('pairing'),pending=data.pending;if(data.error&&data.error!==shownError){shownError=data.error;ctx.toast(data.error,undefined,'error');}if(!pending||pending.state!=='pending'||prompted===pending.id||document.querySelector('dialog[open]'))return;
   prompted=pending.id;const dialog=document.createElement('dialog');dialog.className='pairing-request-dialog';dialog.innerHTML=`<h2>收到ATT绑定请求</h2><p><strong>${esc(pending.name)}</strong> 希望成为这台中转机的出口。</p><p>服务器地址：${esc(pending.publicIPv4)}</p><p>请核对这是你刚才操作的服务器。已有线路可能在应用配对时短暂重连。</p><p class="form-error" hidden role="alert"></p><div class="actions"><button type="button" data-reject>拒绝</button><button type="button" class="primary" data-approve>确认绑定</button></div>`;
   document.body.append(dialog);dialog.showModal();dialog.oncancel=()=>{dialog.remove();prompted=null;};
   for(const[key,action]of[['approve','approve'],['reject','reject']])dialog.querySelector('[data-'+key+']').onclick=async()=>{
    const buttons=[...dialog.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
    try{await ctx.api('pairing',{method:'POST',data:{action,id:pending.id,confirmed:action==='approve'}});dialog.close();dialog.remove();ctx.toast(action==='approve'?'已批准接入ATT服务器，正在进行通信配置':'已拒绝此请求');}
    catch(e){actionFeedback(dialog.querySelector('[data-'+key+']'),e.message,{kind:'error'});buttons.forEach(b=>b.disabled=false);}
   };
  }catch{}finally{notifying=false;}
 };
 const timer=setInterval(check,3000);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
}
