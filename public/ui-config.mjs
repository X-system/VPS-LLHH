import{esc,icon,badge}from'./ui-kit.mjs';
const headings={lines:['线路管理','先看运行状态，需要调整时再展开配置。','network'],certificates:['域名与证书','按步骤完成一次配置，后续自动续签。','certificates'],settings:['面板设置','管理账户、外观和访问方式。','security'],events:['消息与告警','粘贴手机 Bark 链接，选择需要的提醒。','bark'],logs:['日志与诊断','出问题先看记录，需要帮助时导出诊断。','maintenance'],maintenance:['备份与维护','日常建议保存完整加密备份，恢复前先预览。','maintenance']};
function intro(kind){const [title,note,topic]=headings[kind];const node=document.createElement('div');node.className='section-intro';node.innerHTML=`<div><h2>${title}</h2><p>${note}</p></div><button class="guide-link" data-guide-open="${topic}">${icon('help')} 配置教程</button>`;return node;}
function tabbed(page,kind,definitions,ctx,initial){
 const holder=document.createElement('div');holder.className='module-tabs';holder.innerHTML=`<div class="tabbar" role="tablist">${definitions.map(([id,label])=>`<button type="button" role="tab" data-config-tab="${id}">${label}</button>`).join('')}</div>`;
 for(const[id]of definitions){const slot=document.createElement('section');slot.dataset.configSlot=id;slot.className='tab-panel';slot.setAttribute('role','tabpanel');holder.append(slot);}
 const activate=id=>{if(!definitions.some(([key])=>key===id))id=definitions[0][0];ctx.state.tabs[kind]=id;holder.querySelectorAll('[data-config-tab]').forEach(b=>{const yes=b.dataset.configTab===id;b.classList.toggle('active',yes);b.setAttribute('aria-selected',String(yes));});holder.querySelectorAll('[data-config-slot]').forEach(p=>{p.hidden=p.dataset.configSlot!==id;});};
 holder.querySelectorAll('[data-config-tab]').forEach(b=>b.onclick=()=>activate(b.dataset.configTab));page.append(holder);activate(ctx.state.tabs[kind]||initial||definitions[0][0]);
 return{slot:id=>holder.querySelector(`[data-config-slot="${id}"]`),activate};
}
function wrap(node,label,open=false,kind='advanced-details'){
 const details=document.createElement('details');details.className=kind;details.open=open;const summary=document.createElement('summary');summary.textContent=label;node.before(details);details.append(summary,node);return details;
}
function formAdvanced(form,names,title){
 const fields=names.map(name=>form.querySelector(`[name="${name}"]`)?.closest('.field')).filter(Boolean);if(!fields.length)return;
 const details=document.createElement('details');details.className='advanced-details';details.innerHTML=`<summary>${title}</summary>`;fields[0].before(details);fields.forEach(f=>details.append(f));
}
function cardByTitle(page,title){return[...page.querySelectorAll('article')].find(c=>c.querySelector('h2')?.textContent===title);}
export function organizeConfig(page,kind,ctx){
 if(kind==='settings'){
  const grid=page.querySelector('.settings-grid'),appearance=cardByTitle(page,'登录页与外观'),connection=cardByTitle(page,'面板连接'),recovery=page.querySelector('[data-module=recovery]'),role=page.querySelector('[data-module=role]');
  const tabs=tabbed(page,kind,[['general','账户与安全'],['appearance','外观'],['connection','访问地址'],['advanced','高级设置']],ctx);
  if(grid){tabs.slot('general').append(grid);formAdvanced(grid.querySelector('#settings-form'),['bandwidthMbps','logRetentionDays'],'高级：带宽与日志');}
  if(appearance)tabs.slot('appearance').append(appearance);if(connection)tabs.slot('connection').append(connection);
  if(recovery)tabs.slot('advanced').append(recovery);const health=page.querySelector('[data-module=health]');if(health)tabs.slot('advanced').append(health);if(role){tabs.slot('advanced').append(role);wrap(role,'高级：切换服务器角色',false,'advanced-details danger-zone');}
 }
 if(kind==='lines'){
  const network=ctx.state.networkConfig||{},relay=ctx.state.lineConfig||{},exit=ctx.state.meta.role==='exit';
  const forms=page.querySelector('#network-form'),relayForm=page.querySelector('#relay-form'),identity=[...page.querySelectorAll('article')].find(a=>a.querySelector('input[readonly]')),services=page.querySelector('[data-module=services]');
  page.querySelector(':scope > .notice')?.remove();
  const definitions=[['status','运行状态'],['network',exit?'中转机配对':'连接出口机'],...(!exit?[['protocol','域名与协议']]:[])];
  const tabs=tabbed(page,kind,definitions,ctx,!network.configured?'network':!exit&&!relay.configured?'protocol':'status');
  if(services)tabs.slot('status').append(services);
  if(identity){tabs.slot('network').append(identity);identity.classList.add('identity-card');const input=identity.querySelector('input');input.setAttribute('aria-label','本机公钥');const copy=document.createElement('button');copy.type='button';copy.innerHTML=icon('copy')+' 复制本机公钥';input.after(copy);copy.onclick=async()=>{try{await navigator.clipboard.writeText(input.value);ctx.toast('公钥已复制，请粘贴到另一台服务器');}catch{input.focus();input.select();ctx.toast('已选中公钥，请复制');}};}
  if(forms){const card=forms.closest('article');tabs.slot('network').append(card);formAdvanced(forms,['physicalInterface','address','listenPort'],'高级参数：网卡、隧道地址与端口（已预填）');if(network.configured){wrap(forms,'修改现有配对（保存会停止线路）');const current=document.createElement('div');current.className='saved-summary';current.innerHTML=`<span>${badge('已配对','good')}</span><strong>${esc((network.peers||[]).map(p=>p.name||p.address).join('、'))}</strong><p>当前网卡 ${esc(network.physicalInterface)} · 隧道地址 ${esc(network.address)} · UDP ${network.listenPort}</p><button class="link-button" data-guide-open="network">怎么看这些参数？</button>`;card.querySelector('.card-header').after(current);}}
  if(relayForm){const card=relayForm.closest('article');tabs.slot('protocol').append(card);formAdvanced(relayForm,['vmess-att','vmess-direct','hy2-att','hy2-direct'],'协议端口（默认值通常无需修改）');if(relay.configured){wrap(relayForm,'修改域名与端口（保存会停止线路）');const current=document.createElement('div');current.className='saved-summary';current.innerHTML=`${badge('已配置','good')}<strong>${esc(relay.domain)}</strong><p>本机公网地址 ${esc(relay.publicIPv4)}</p><div class="actions"><button class="link-button" data-go="certificates">查看域名证书 →</button><button class="link-button" data-go="users">添加用户并获取链接 →</button></div>`;card.querySelector('.card-header').after(current);}}
  const step=document.createElement('div');step.className='workflow-strip';step.innerHTML=`<span class="${network.configured?'done':''}">① 连接出口与配对</span><b>→</b><button data-go="certificates">② 配置证书</button><b>→</b><span>③ 启用线路</span><b>→</b><button data-go="users">④ 添加用户</button>`;if(!exit)page.prepend(step);
 }
 if(kind==='certificates'){
  const form=page.querySelector('#certificate-form'),card=form?.closest('article');
  if(card){const valid=card.dataset.certificateValid==='true';const steps=document.createElement('div');steps.className='certificate-steps';steps.innerHTML=`<span>1. 域名指向本机</span><span>2. 填写 DNS 令牌</span><span>3. 申请正式证书</span><span>4. 自动续签</span>`;card.before(steps);wrap(form,valid?'查看或修改证书配置':'填写证书申请信息',!valid,'certificate-editor');const token=form.querySelector('[name=token]');if(token){const links=document.createElement('div');links.className='guide-links';links.innerHTML='<a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer noopener">去 Cloudflare 创建令牌 ↗</a><button type="button" class="link-button" data-guide-open="certificates">不知道怎么填？查看分步教程</button>';token.closest('.field').append(links);}}
  else page.insertAdjacentHTML('beforeend','<div class="notice">当前实例尚未连接系统管理器。正式安装后可在这里配置域名与证书。</div>');
 }
 if(kind==='events'){
  const grid=page.querySelector('.settings-grid'),channel=page.querySelector('#bark-form')?.closest('article'),options=page.querySelector('#event-options')?.closest('article'),rules=cardByTitle(page,'告警阈值'),history=cardByTitle(page,'推送队列');page.querySelector(':scope > .notice')?.remove();
  const tabs=tabbed(page,kind,[['channel','手机推送'],['rules','提醒事件与规则'],['history','发送记录']],ctx);
  if(channel)tabs.slot('channel').append(channel);if(options)tabs.slot('rules').append(options);if(rules){tabs.slot('rules').append(rules);wrap(rules,'高级：调整提醒阈值（默认值可直接使用）');}if(history)tabs.slot('history').append(history);grid?.remove();
  if(options){const toggles=options.querySelector('#event-options');toggles.classList.add('event-grid');const save=document.createElement('button');save.className='primary';save.textContent='保存事件选项';save.onclick=()=>{const form=page.querySelector('#bark-form');if(!form.checkValidity()){tabs.activate('channel');form.reportValidity();return;}form.requestSubmit();};options.append(save);}
 }
 if(kind==='logs'){
  const pre=page.querySelector('pre');if(pre)wrap(pre,'展开详细系统日志');
 }
 if(kind==='maintenance'){
  page.querySelector('.feature-list')?.remove();
  const updates=cardByTitle(page,'版本更新与回滚'),restore=cardByTitle(page,'恢复与卸载');if(restore)wrap(restore,'高级：回退配置与卸载',false,'advanced-details danger-zone');
  if(updates){const form=updates.querySelector('#repository-form');if(form&&!form.querySelector('input').value){const note=document.createElement('p');note.className='notice';note.textContent='当前使用自己的安装包维护，无需填写仓库。私有仓库下载授权尚未接入。';updates.querySelector('.card-header').after(note);}wrap(updates,'高级：版本更新与回滚');}
 }
 page.prepend(intro(kind));
 page.addEventListener('click',event=>{const target=event.target.closest('[data-go]');if(target)ctx.navigate(target.dataset.go);});
}
