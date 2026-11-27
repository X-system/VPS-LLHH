import{esc}from'./ui-kit.mjs';
const time=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'尚未检查';
const failed=status=>!!status.job&&/^(failed|rollback-failed)/.test(status.job.step);
let prompt=null;
export function showUpdating(root){root.dataset.updating='true';document.querySelectorAll('.update-dialog').forEach(node=>node.remove());root.innerHTML='<div class="connection-loader" role="status"><div class="spectrum" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><strong>升级中，请等待</strong><span>面板正在自动更新，完成后将重新连接。</span></div>';setTimeout(()=>location.reload(),2500);}
async function downloadLogs(ctx){const logs=await ctx.api('updates/logs'),url=URL.createObjectURL(new Blob([JSON.stringify(logs,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='panel-update-diagnostics.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export function showUpdatePrompt(ctx,status,{notesOnly=false}={}){
 const required=status.required===true,version=status.available?.version||'',root=document.querySelector('#app');
 if(root.dataset.updating)return;
 if(prompt?.isConnected){if(prompt.dataset.required==='true'&&prompt.dataset.version===version)return;if(!required)return;prompt.remove();}
 if(!required&&document.querySelector('dialog[open]'))return;
 const dialog=document.createElement('dialog');prompt=dialog;dialog.className='update-dialog'+(required?' required-update-dialog':'');dialog.dataset.required=String(required);dialog.dataset.version=version;let leaving=false;
 dialog.innerHTML=`<h2>${required?'发现紧急安全更新':notesOnly?'版本更新内容':failed(status)?'上次更新未完成':'发现面板新版本'}</h2><p>当前 ${esc(status.currentVersion||ctx.state.meta?.version||'')} ${version?'→ <strong>'+esc(version)+'</strong>':''}</p>${required?'<p class="required-update-message">这是必须安装的安全更新。完成更新后才能继续使用面板，重新登录也不能跳过。</p>':'<p>你可以立即更新、预约时间，或稍后再说。</p>'}${failed(status)?'<p class="update-form-error">上次更新未完成，请检查结果后重试；必要时通过SSH应急菜单处理。</p>':''}${version?`<div class="update-release-notes" aria-label="更新内容">${esc(status.available.notes||'本版本暂未提供详细更新说明。')}</div>`:''}<p class="update-form-error" data-update-error role="alert" hidden></p><div class="settings-actions">${required?'':`<button data-later>${notesOnly?'关闭':'稍后再说'}</button>${status.hasUpdate?'<button data-reserve>预约更新</button>':''}`}${status.hasUpdate?'<button class="primary" data-now>立即更新</button>':''}</div>`;
 document.body.append(dialog);dialog.showModal();
 const close=()=>{if(required&&!leaving)return;dialog.close();dialog.remove();if(prompt===dialog)prompt=null;};
 dialog.oncancel=event=>{if(required)event.preventDefault();else close();};dialog.onclose=()=>{if(required&&!leaving&&ctx.state.csrf&&!root.dataset.updating&&dialog.isConnected)queueMicrotask(()=>dialog.isConnected&&dialog.showModal());else dialog.remove();};
 dialog.querySelector('[data-later]')?.addEventListener('click',close);
 dialog.querySelector('[data-reserve]')?.addEventListener('click',()=>{close();reserveDialog(ctx,status);});
 dialog.querySelector('[data-now]')?.addEventListener('click',async event=>{const button=event.currentTarget,note=dialog.querySelector('[data-update-error]');button.disabled=true;note.hidden=true;try{const accepted=await startUpdate(ctx,{required});if(accepted){leaving=true;close();}}catch(e){note.hidden=false;note.textContent=e.message;}finally{button.disabled=false;}});
}
export async function checkUpdateGate(ctx){
 if(!ctx.state.csrf)return false;let status;try{status=await ctx.api('updates');}catch(error){if(error.mandatory)return true;return false;}
 ctx.state.lastUpdateStatus=status;if(!status.required)return false;ctx.state.mandatoryUpdate=status;showUpdatePrompt(ctx,status);return true;
}
export async function updateReminder(ctx){
 if(!ctx.state.csrf||document.querySelector('#app')?.dataset.updating)return;
 let status;try{status=await ctx.api('updates');}catch{return;}
 if(status.required){ctx.state.mandatoryUpdate=status;showUpdatePrompt(ctx,status);return;}
 ctx.state.mandatoryUpdate=null;const key=(status.available?.version||'')+':'+(failed(status)?status.job.at:'');
 if((!status.hasUpdate&&!failed(status))||status.plan?.state==='scheduled'||ctx.state.updateNoticeKey===key||document.querySelector('dialog[open]'))return;
 ctx.state.updateNoticeKey=key;showUpdatePrompt(ctx,status);
}
export function installUpdateChecks(ctx){setInterval(()=>{if(document.visibilityState==='visible'&&ctx.state.csrf)updateReminder(ctx);},30000);}
export async function updateControls(page,ctx){
 let status;try{status=await ctx.api('updates');}catch(e){if(e.status===501)return;throw e;}
 const card=document.createElement('article');card.className='card';card.dataset.updateControls='';
 card.innerHTML=`<div class="card-header"><h2>面板更新</h2><span class="badge">当前 ${esc(status.currentVersion)}</span></div><div class="card-body"><p>每天北京时间08:00自动检查。普通更新可立即或预约安装；紧急安全更新需要立即完成。</p><p data-update-check></p><p data-update-available></p><p data-update-job></p><div class="actions"><button type="button" id="check-updates" data-check-update>检查更新</button><button type="button" class="primary" data-update-now>立即更新</button><button type="button" data-update-reserve>预约更新</button><button type="button" data-update-cancel>取消预约</button><button type="button" data-update-logs>导出更新日志</button></div><p class="muted">更新前保存配置与统计，自检失败自动尝试恢复原版本。仍尊重手动停止和急停设置。</p></div>`;page.append(card);
 const draw=value=>{status=value;card.querySelector('[data-update-check]').textContent='上次检查：'+time(value.checkedAt)+(value.checkError?' · '+value.checkError:'');const available=card.querySelector('[data-update-available]');available.innerHTML=value.hasUpdate?'可更新至 <a class="update-version-link" href="#update-notes">'+esc(value.available.version)+'</a>':value.checkedAt?'当前已是最新可用版本':'点击检查更新，或等待每日自动检查';available.querySelector('a')?.addEventListener('click',event=>{event.preventDefault();showUpdatePrompt(ctx,status,{notesOnly:true});});card.querySelector('[data-update-job]').textContent=value.plan?.state==='scheduled'?'已预约 '+time(value.plan.at)+' 更新至 '+value.plan.version:value.job?({'complete':'上次更新已完成','failed-rolled-back':'上次更新失败，已退回原版本','failed':'上次更新未完成，可导出日志','failed-to-start':'更新任务未能启动，可导出日志','failed-interrupted':'上次更新被中断，请导出日志检查','failed-needs-ssh':'自动恢复未完成，请使用SSH应急菜单','queued':'更新即将开始','downloading':'正在准备更新','rolled-back':'已回退版本'}[value.job.step]||'上次维护状态：'+value.job.step):'';card.querySelector('[data-update-now]').disabled=!value.hasUpdate;card.querySelector('[data-update-reserve]').disabled=!value.hasUpdate||value.required;card.querySelector('[data-update-cancel]').hidden=value.plan?.state!=='scheduled'||value.required;};draw(status);
 card.querySelector('[data-check-update]').onclick=async()=>{draw(await ctx.api('updates',{method:'POST',data:{action:'check'}}));if(status.required)showUpdatePrompt(ctx,status);else ctx.state.updateNoticeKey=(status.available?.version||'')+':'+(failed(status)?status.job.at:'');};
 card.querySelector('[data-update-now]').onclick=()=>startUpdate(ctx,{required:status.required});card.querySelector('[data-update-reserve]').onclick=()=>reserveDialog(ctx,status,plan=>draw({...status,plan}));
 card.querySelector('[data-update-cancel]').onclick=async event=>{await ctx.api('updates',{method:'POST',data:{action:'cancel'}});draw(await ctx.api('updates'));ctx.toast('预约已取消',event.currentTarget);};card.querySelector('[data-update-logs]').onclick=()=>downloadLogs(ctx);
}
async function startUpdate(ctx,{required=false}={}){if(!required&&!confirm('确认立即更新？线路会短暂暂停，完成检查后恢复原先允许运行的服务。'))return false;await ctx.api('updates',{method:'POST',data:{action:'update',confirmed:true}});showUpdating(document.querySelector('#app'));return true;}
function reserveDialog(ctx,status,onSaved){
 if(status.required){showUpdatePrompt(ctx,status);return;}
 const dialog=document.createElement('dialog');dialog.className='update-dialog';dialog.innerHTML=`<h2>预约更新</h2><p>将更新至 ${esc(status.available?.version||'新版本')}。时间按当前浏览器时区填写，确认前请核对。</p><form><label class="field">更新时间<input type="datetime-local" name="at" required></label><p class="update-form-error" role="alert" hidden></p><div class="settings-actions"><button type="button" data-cancel>取消</button><button class="primary">确认预约</button></div></form>`;document.body.append(dialog);dialog.showModal();const close=()=>{dialog.close();dialog.remove();};dialog.querySelector('[data-cancel]').onclick=close;dialog.oncancel=close;
 dialog.querySelector('form').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,button=event.submitter||form.querySelector('button.primary');button.disabled=true;try{const at=new Date(form.elements.at.value).getTime();await ctx.api('updates',{method:'POST',data:{action:'reserve',at,confirmed:true}});onSaved?.({state:'scheduled',at,version:status.available?.version});dialog.innerHTML='<h2>预约已保存</h2><p>'+esc(time(at))+' 自动更新。</p><div class="settings-actions"><button class="primary" data-done>完成</button></div>';dialog.querySelector('[data-done]').onclick=close;}catch(e){const note=dialog.querySelector('[role=alert]');note.hidden=false;note.textContent=e.message;}finally{button.disabled=false;}};
}
