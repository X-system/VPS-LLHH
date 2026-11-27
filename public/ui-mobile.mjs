import{icon}from'./ui-kit.mjs';
export const mobileQuery='(max-width: 820px), (max-width: 1000px) and (hover: none)';
export function installMobile(ctx){
 const media=matchMedia(mobileQuery);let currentAside=null,opened=false,savedScroll=0,savedStyle=null;
 const root=document.querySelector('#app');
 function close({restoreFocus=true,restoreScroll=true}={}){
  const aside=document.querySelector('#panel-sidebar'),shell=document.querySelector('.shell'),button=document.querySelector('#mobile-menu'),backdrop=document.querySelector('.mobile-backdrop');
  opened=false;document.body.classList.remove('mobile-nav-open');
  if(savedStyle){for(const[key,value]of Object.entries(savedStyle))document.body.style[key]=value;savedStyle=null;if(restoreScroll)window.scrollTo(0,savedScroll);}
  if(shell)shell.inert=false;if(backdrop)backdrop.hidden=true;if(button)button.setAttribute('aria-expanded','false');
  if(aside){aside.inert=media.matches;aside.setAttribute('aria-hidden',String(media.matches));aside.removeAttribute('aria-modal');aside.removeAttribute('role');}
  if(restoreFocus&&media.matches)button?.focus({preventScroll:true});
 }
 function open(){
  const aside=document.querySelector('#panel-sidebar'),shell=document.querySelector('.shell');if(!media.matches||!aside)return;
  savedScroll=scrollY;savedStyle=Object.fromEntries(['position','top','width','overflow'].map(key=>[key,document.body.style[key]]));
  Object.assign(document.body.style,{position:'fixed',top:-savedScroll+'px',width:'100%',overflow:'hidden'});
  opened=true;document.body.classList.add('mobile-nav-open');aside.inert=false;aside.setAttribute('aria-hidden','false');aside.setAttribute('role','dialog');aside.setAttribute('aria-modal','true');
  document.querySelector('.mobile-backdrop').hidden=false;document.querySelector('#mobile-menu').setAttribute('aria-expanded','true');aside.querySelector('.mobile-menu-close').focus({preventScroll:true});if(shell)shell.inert=true;
 }
 ctx.closeMobileMenu=close;
 function setup(){
  const aside=root.querySelector('.sidebar');if(aside===currentAside)return;
  if(opened)close({restoreFocus:false});currentAside=aside;if(!aside)return;
  aside.id='panel-sidebar';aside.setAttribute('aria-label','导航菜单');
  const header=root.querySelector('.topbar'),toggle=document.createElement('button');toggle.id='mobile-menu';toggle.className='mobile-menu-toggle mobile-only';toggle.type='button';toggle.setAttribute('aria-controls','panel-sidebar');toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-label','打开导航菜单');toggle.innerHTML='<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
  const name=document.createElement('span');name.className='mobile-server-name mobile-only';name.textContent=ctx.state.meta.serverName;header.prepend(toggle,name);
  const dismiss=document.createElement('button');dismiss.className='mobile-menu-close mobile-only';dismiss.type='button';dismiss.setAttribute('aria-label','关闭导航菜单');dismiss.textContent='×';aside.prepend(dismiss);
  const backdrop=document.createElement('button');backdrop.className='mobile-backdrop';backdrop.hidden=true;backdrop.setAttribute('aria-label','关闭菜单遮罩');root.append(backdrop);
  const bottom=document.createElement('nav');bottom.className='mobile-bottom-nav mobile-only';bottom.setAttribute('aria-label','常用功能');
  const definitions=ctx.state.meta.uiVersion>=2?[['overview','dashboard','首页'],...(ctx.state.meta.role==='exit'?[]:[['users','users','用户']]),['traffic','traffic','流量'],['services','network','配置'],['settings','settings','设置']]:[['overview','dashboard','首页'],['users','users',ctx.state.meta.role==='exit'?'中转机':'用户'],['traffic','traffic','流量'],['lines','network','线路']];
  for(const[id,symbol,label]of definitions){const b=document.createElement('button');b.type='button';b.dataset.page=id;b.dataset.mobileGo=id;b.innerHTML=icon(symbol)+'<span>'+label+'</span>';b.classList.toggle('active',ctx.state.page===id);bottom.append(b);}root.append(bottom);close({restoreFocus:false});
 }
 function tables(scope){
  const found=new Set();if(scope.matches?.('table'))found.add(scope);if(scope.closest?.('table'))found.add(scope.closest('table'));scope.querySelectorAll?.('table').forEach(t=>found.add(t));
  for(const table of found){
   if(!table.closest('#page,dialog'))continue;const headers=[...table.querySelectorAll('thead th')].map(th=>{const copy=th.cloneNode(true);copy.querySelectorAll('button').forEach(b=>b.remove());return copy.textContent.trim();});if(!headers.length)continue;
   table.dataset.mobileTable='';for(const row of table.querySelectorAll('tbody tr'))[...row.children].forEach((cell,index)=>{cell.dataset.mobileLabel=headers[index]||'';if(index===row.children.length-1&&cell.querySelector('button:not(.help-trigger)'))cell.dataset.mobileActions='';});
  }
 }
 new MutationObserver(setup).observe(root,{childList:true});
 new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.nodeType===1)tables(node);}).observe(document.body,{childList:true,subtree:true});
 document.addEventListener('click',event=>{
  if(event.target.closest('#mobile-menu')){opened?close():open();return;}
  if(event.target.closest('.mobile-menu-close,.mobile-backdrop')){close();return;}
  const target=event.target.closest('[data-mobile-go]');if(target)ctx.navigate(target.dataset.mobileGo);
 });
 document.addEventListener('pointerdown',event=>{for(const details of document.querySelectorAll('.row-more[open]'))if(!details.contains(event.target))details.open=false;},true);
 document.addEventListener('keydown',event=>{
  if(!opened)return;if(event.key==='Escape'){event.preventDefault();close();return;}
  if(event.key==='Tab'){const focusable=[...currentAside.querySelectorAll('button:not(:disabled),a[href]')].filter(n=>n.getClientRects().length);const first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
 });
 media.addEventListener('change',()=>close({restoreFocus:false}));window.addEventListener('popstate',()=>close({restoreFocus:false}));
 function viewport(){const v=window.visualViewport;document.documentElement.style.setProperty('--phone-height',(v?.height||innerHeight)+'px');document.documentElement.style.setProperty('--phone-offset',(v?.offsetTop||0)+'px');}
 window.visualViewport?.addEventListener('resize',viewport);window.visualViewport?.addEventListener('scroll',viewport);window.addEventListener('resize',viewport);viewport();setup();
}
