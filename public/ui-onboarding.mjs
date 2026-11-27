import{esc,icon}from'./ui-kit.mjs';
import{pairingControls}from'./ui-pairing.mjs';
const labels={account:'设置账户',name:'服务器名称',protocols:'选择协议',certificate:'域名与证书',bark:'手机提醒',pairing:'连接出口',review:'自动配置'};
export async function renderOnboarding(root,ctx){
 const data=await ctx.api('onboarding');Object.assign(ctx.state.meta,data.meta);
 if(!data.active)return ctx.navigate('overview');
 const index=data.steps.indexOf(data.step),draft=data.draft;
 root.innerHTML=`<div class="onboarding-page"><aside class="onboarding-sidebar"><div class="onboarding-brand">${icon('network')} 服务器管理</div><strong>${data.role==='exit'?'出口端':'中转端'}首次设置</strong><p>每次只做一步，程序负责配置和检查。</p><ol>${data.steps.map((id,i)=>`<li class="${i===index?'current':i<index?'done':''}"><span>${i<index?'✓':i+1}</span>${labels[id]}</li>`).join('')}</ol><small>进度自动保存，可以稍后回来继续。</small></aside><main class="onboarding-main"><div class="onboarding-step">第 ${index+1} 步，共 ${data.steps.length} 步</div><h1>${labels[data.step]}</h1><div data-onboarding-body></div><p class="form-error" role="alert" hidden></p></main></div>`;
 const body=root.querySelector('[data-onboarding-body]'),error=root.querySelector('[role=alert]'),next='<button class="primary" type="submit">保存并继续</button>';
 const fields={
  account:`<p>设置你自己的管理账户，替换安装时的临时账户。</p><form><label class="field">用户名<input name="username" autocomplete="username" required maxlength="48" placeholder="例如：我的管理员"></label><label class="field">密码<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required placeholder="至少12位"></label><label class="field">再输入一次密码<input name="repeat" type="password" autocomplete="new-password" required></label>${next}</form>`,
  name:`<p>给这台服务器起一个你能认出来的名字。</p><form><label class="field">服务器名称<input name="serverName" required maxlength="48" value="${esc(draft.serverName||'')}" placeholder="例如：香港中转一号"></label>${next}</form>`,
  protocols:`<p>只开启你需要的协议。端口和运行环境由程序安排。</p><form><label class="protocol-choice"><input type="checkbox" name="protocol" value="hy2" ${(draft.protocols||['hy2']).includes('hy2')?'checked':''}><span><strong>Hy2</strong><small>需要域名和证书，使用UDP传输。</small></span></label><label class="protocol-choice"><input type="checkbox" name="protocol" value="vmess" ${draft.protocols?.includes('vmess')?'checked':''}><span><strong>原始 TCP</strong><small>保留原来的VMess TCP协议，可作为备用线路。</small></span></label>${next}</form>`,
  certificate:`<p>按下面三步准备一次，之后证书由程序自动申请和续期。</p><ol class="certificate-guide"><li><strong>准备代理域名</strong><p>在Cloudflare为域名添加A记录，指向这台服务器；代理状态选择“仅DNS”（灰云）。</p><a href="https://dash.cloudflare.com/" target="_blank" rel="noopener noreferrer">打开Cloudflare →</a></li><li><strong>创建证书令牌</strong><p>选择区域权限：DNS编辑、区域读取；资源仅限你使用的域名。</p><a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer">打开令牌创建页 →</a> <a href="https://developers.cloudflare.com/fundamentals/api/get-started/create-token/" target="_blank" rel="noopener noreferrer">查看官方步骤图 →</a></li><li><strong>粘贴到下面</strong><p>程序自动识别域名区域，令牌加密保存，不在页面回显。</p></li></ol><form><label class="field">完整代理域名<input name="domain" value="${esc(draft.domain||'')}" required placeholder="例如：hk.example.com"></label><label class="field">Cloudflare令牌<input name="token" type="password" autocomplete="off" ${data.hasCertificateSettings?'':'required'} placeholder="${data.hasCertificateSettings?'留空保留已保存的令牌':'粘贴刚才创建的完整令牌'}"></label><label class="field">证书联系邮箱<input name="email" type="email" ${data.hasCertificateSettings?'':'required'} placeholder="${data.hasCertificateSettings?'留空保留已保存的联系邮箱':'任意可收件邮箱，用于证书事务'}"></label><details><summary>无法自动识别区域时，手动填写</summary><label class="field">Cloudflare区域ID<input name="zoneId" placeholder="在域名概览页复制区域ID"></label></details><label class="check-row"><input type="checkbox" name="termsAccepted" required>我同意 <a href="https://letsencrypt.org/repository/" target="_blank" rel="noopener noreferrer">证书机构服务条款</a></label><button class="primary">检查并申请证书</button><p class="certificate-job-state" role="status"></p></form>`,
  bark:`<p>在Bark里复制推送链接，原样粘贴即可。也可以稍后到服务配置添加。</p><form><label class="field">Bark推送链接<input name="url" type="password" autocomplete="off" placeholder="https://服务地址/你的推送密钥"></label><div class="actions">${next}<button type="button" data-skip>稍后配置</button></div></form>`,
  pairing:data.role==='exit'?'<p>这台服务器作为出口，接收中转端发来的绑定邀请。可以现在连接，也可以稍后在服务配置中操作。</p><div data-pairing></div><button class="primary" type="button" data-next>继续</button>':`<p>是否让部分线路通过ATT出口访问网站？不连接也能正常使用本机直出。</p><form><label class="protocol-choice"><input type="radio" name="useAtt" value="no" ${!draft.useAtt?'checked':''}><span><strong>先使用本机直出</strong><small>无需第二台服务器，之后可以添加出口。</small></span></label><label class="protocol-choice"><input type="radio" name="useAtt" value="yes" ${draft.useAtt?'checked':''}><span><strong>连接ATT出口</strong><small>请准备一台已安装出口端面板的服务器。</small></span></label><div data-pairing ${draft.useAtt?'':'hidden'}></div>${next}</form>`,
  review:`<p>配置已经准备好，点击后由程序生成配置、开启所选服务并检查结果。</p><div class="onboarding-summary"><p>服务器：<strong>${esc(draft.serverName)}</strong></p><p>角色：${data.role==='exit'?'出口端':'中转端'}</p>${data.role==='relay'?`<p>协议：${draft.protocols?.map(id=>id==='hy2'?'Hy2':'原始 TCP').join('、')}</p><p>出口：${draft.useAtt?'本机直出 + ATT出口':'本机直出'}</p>`:'<p>完成后可接收中转端的绑定请求。</p>'}</div><div data-job-state role="status"></div>${draft.recovery?'<label class="check-row"><input type="checkbox" name="releaseRecovery">确认解除恢复保护，并开启所选服务</label>':''}<button type="button" class="primary" data-finish ${data.job?.state==='running'?'disabled':''}>${data.job?.state==='failed'?'重新检查并配置':'完成配置并开启服务'}</button>`
 };
 body.innerHTML=fields[data.step];
 const showError=e=>{error.hidden=false;error.textContent=e.message||String(e);};
 const submit=async input=>{
  const controls=[...body.querySelectorAll('button')];controls.forEach(button=>button.disabled=true);error.hidden=true;
  try{const result=await ctx.api('onboarding',{method:'POST',data:{step:data.step,...input}});if(result.csrf)ctx.state.csrf=result.csrf;Object.assign(ctx.state.meta,result.meta);if(root.isConnected)await renderOnboarding(root,ctx);}
  catch(e){showError(e);controls.forEach(button=>button.disabled=false);}
 };
 const form=body.querySelector('form');if(form)form.onsubmit=event=>{
  event.preventDefault();const values=Object.fromEntries(new FormData(form));
  if(data.step==='account'&&values.password!==values.repeat)return showError(new Error('两次输入的密码不一致'));
  if(data.step==='protocols')values.protocols=[...form.querySelectorAll('[name=protocol]:checked')].map(input=>input.value);
  if(data.step==='certificate')values.termsAccepted=form.elements.termsAccepted.checked;
  if(data.step==='pairing')values.useAtt=values.useAtt==='yes';submit(values);
 };
 const skip=body.querySelector('[data-skip]');if(skip)skip.onclick=()=>submit({skip:true});
 const finish=body.querySelector('[data-finish]');if(finish)finish.onclick=()=>submit({confirmed:true,releaseRecovery:body.querySelector('[name=releaseRecovery]')?.checked===true});
 const advance=body.querySelector('[data-next]');if(advance)advance.onclick=()=>submit({});
 const holder=body.querySelector('[data-pairing]');if(holder){await pairingControls(holder,ctx);body.querySelectorAll('[name=useAtt]').forEach(input=>input.onchange=()=>{holder.hidden=form.elements.useAtt.value!=='yes';});}
 if(data.step==='certificate'&&draft.domain){
  const status=body.querySelector('.certificate-job-state');let busy=false;
  const tick=async()=>{if(!body.isConnected){clearInterval(timer);return;}if(busy)return;busy=true;try{const cert=await ctx.api('certificate');status.textContent=cert.job?'正在申请证书，验证域名可能需要几分钟…':cert.ok===false?'申请未完成，请检查上面的域名、令牌和邮箱后重试。':'正在检查证书结果…';if(cert.certificateStaging===false&&cert.certificateDomain===draft.domain&&cert.notAfter>Date.now()){clearInterval(timer);await submit({check:true});}}catch(e){showError(e);}finally{busy=false;}};
  const timer=setInterval(tick,2000);tick();
 }
 if(data.step==='review'){
  const status=body.querySelector('[data-job-state]');status.textContent=data.job?.state==='failed'?data.job.message:data.job?.phase||'等待你确认开始。';
  if(data.job?.state==='running'){let busy=false;const timer=setInterval(async()=>{if(!body.isConnected){clearInterval(timer);return;}if(busy)return;busy=true;try{const current=await ctx.api('onboarding');status.textContent=current.job?.phase||'正在配置…';if(!current.active||current.job?.state!=='running'){clearInterval(timer);await renderOnboarding(root,ctx);}}catch(e){showError(e);}finally{busy=false;}},1000);}
 }
 if(index>1&&data.job?.state!=='running'){const back=document.createElement('button');back.className='link-button onboarding-back';back.textContent='← 上一步';back.onclick=()=>submit({back:true});body.append(back);}
}
