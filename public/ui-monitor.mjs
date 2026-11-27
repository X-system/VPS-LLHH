import{esc,bytes,rate,badge,icon,patchHTML}from'./ui-kit.mjs';
const views=new WeakMap();
const ranges=[['5m','5 分钟'],['1h','1 小时'],['24h','24 小时']];
const groups=[
 {id:'network',title:'公网网络速度',note:'服务器网卡 · 包含隧道与管理流量',series:[['networkUp','上传','#4385f5'],['networkDown','下载','#17ad91']]},
 {id:'resources',title:'CPU、内存与磁盘',note:'服务器资源使用率',percentage:true,series:[['cpu','CPU','#4385f5'],['memory','内存','#9976e7'],['disk','磁盘','#dbad50']]},
 {id:'business',title:'用户业务速度',note:'用户上传与下载 · 不重复计算隧道封装',relay:true,series:[['userUp','上传','#4385f5'],['userDown','下载','#17ad91']]},
 {id:'tunnel',title:'加密隧道速度',note:'本机 WG 接口 · 包含封装开销',series:[['tunnelUp','发送','#9976e7'],['tunnelDown','接收','#17ad91']]}
];
const value=(number,percentage=false)=>number===null||number===undefined?'—':percentage?number.toFixed(1)+'%':rate(number);
const clock=(at,range)=>new Date(at).toLocaleString('zh-CN',range==='24h'?{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}:{hour:'2-digit',minute:'2-digit',hour12:false});
const short=number=>number>=1073741824?(number/1073741824).toFixed(1)+'G':number>=1048576?(number/1048576).toFixed(1)+'M':number>=1024?(number/1024).toFixed(0)+'K':number>0&&number<10?Number(number.toFixed(1))+'' :Math.round(number)+'';
function chart(group,data,view){
 const phone=matchMedia('(max-width: 820px), (max-width: 1000px) and (hover: none)').matches,W=phone?400:720,L=60,R=W-16,T=20,B=188;
 const maximum=group.percentage?100:Math.max(1,...data.points.flatMap(p=>group.series.map(([key])=>p[key]||0)))*1.15;
 const x=at=>L+(at-data.from)/(data.to-data.from)*(R-L),y=n=>B-Math.min(maximum,n)/maximum*(B-T),gap=Math.max(15000,data.stepMs*2);
 const paths=key=>{const list=[];let current=[];for(const p of data.points){if(p[key]===null||p[key]===undefined){if(current.length)list.push(current);current=[];continue;}if(current.length&&p.at-current.at(-1).at>gap){list.push(current);current=[];}current.push({at:p.at,x:x(p.at),y:y(p[key])});}if(current.length)list.push(current);return list;};
 const curves=group.series.map(([key,label,color])=>{
  const segments=paths(key),line=segments.map(segment=>segment.map((p,i)=>(i?'L':'M')+p.x.toFixed(2)+' '+p.y.toFixed(2)).join(' ')).join(' '),area=segments.filter(s=>s.length>1).map(s=>s.map((p,i)=>(i?'L':'M')+p.x.toFixed(2)+' '+p.y.toFixed(2)).join(' ')+` L${s.at(-1).x.toFixed(2)} ${B} L${s[0].x.toFixed(2)} ${B}Z`).join(' '),last=segments.at(-1)?.at(-1);
  return `<path data-key="area-${key}" d="${area}" fill="${color}" fill-opacity=".055"/><path data-key="line-${key}" d="${line}" stroke="${color}" stroke-width="${phone?2:2.2}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>${last?`<circle data-key="dot-${key}" cx="${last.x.toFixed(2)}" cy="${last.y.toFixed(2)}" r="${phone?3:2.8}" fill="${color}"/>`:''}`;
 }).join('');
 const ticks=[0,.5,1].map(f=>`<line x1="${L}" x2="${R}" y1="${y(maximum*f)}" y2="${y(maximum*f)}" stroke="#edf1f7"/><text x="${L-10}" y="${y(maximum*f)+4}" text-anchor="end" class="chart-axis">${group.percentage?Math.round(maximum*f)+'%':short(maximum*f)}</text>`).join('');
 const timeTicks=[0,.5,1].map((f,i)=>`<text x="${L+f*(R-L)}" y="221" text-anchor="${i===0?'start':i===2?'end':'middle'}" class="chart-axis">${esc(clock(data.from+(data.to-data.from)*f,data.range))}</text>`).join('');
 const hasData=data.points.some(p=>group.series.some(([key])=>p[key]!==null&&p[key]!==undefined));
 return `<div class="history-plot" data-history-chart="${group.id}" data-key="plot-${group.id}"><svg class="history-svg" viewBox="0 0 ${W} 240" role="img" aria-label="${group.title}历史图表"><g>${ticks}</g>${curves}<line data-history-cursor data-preserve visibility="hidden" x1="${L}" x2="${L}" y1="${T}" y2="${B}" stroke="#91a5c5" stroke-dasharray="4 4"/>${timeTicks}</svg>${hasData?'':'<div class="history-empty"><strong>等待实际流量采样</strong><span>这个时段还没有有效数据，记录后会自动出现曲线。</span></div>'}<div class="history-tooltip" data-history-tooltip data-preserve hidden></div></div>`;
}
function markup(view,ctx){
 const data=view.data,full=!view.compact,list=groups.filter(g=>(!g.relay||ctx.state.meta.role!=='exit')&&(!view.compact||g.id==='network'));
 const resolution=data.stepMs===5000?'约 5 秒采样':data.stepMs===15000?'15 秒均值 · 峰值单独保留':'5 分钟均值 · 峰值单独保留';
 const toolbar=`<div class="monitor-toolbar"><div class="history-range" role="group" aria-label="历史时间范围">${ranges.map(([id,label])=>`<button type="button" data-history-range="${id}" aria-pressed="${view.range===id}" class="${view.range===id?'active':''}">${label}</button>`).join('')}</div><span class="monitor-state">${badge(data.fresh?'采样正常':data.latest?'数据暂未更新':'等待采样',data.fresh?'good':'warn')}</span></div>`;
 return `${full?'<div class="section-intro"><div><h2>历史监控</h2></div><div data-refresh-slot data-preserve></div></div>':''}${toolbar}<div class="monitor-grid ${view.compact?'compact-monitor':''}">${list.map(group=>`<article class="${full?'card monitor-card':'monitor-preview-card'}" data-key="monitor-${group.id}">${full?`<div class="card-header"><div><h2>${group.title}</h2><small>${group.note}</small></div>${icon(group.percentage?'server':'traffic')}</div>`:''}<div class="history-readings">${group.series.map(([key,label,color])=>`<div data-key="reading-${key}"><span class="series-label" data-series="${key}">${label}</span><strong>${value(data.fresh?data.latest?.[key]:null,group.percentage)}</strong><small>本窗口峰值 ${value(data.peaks[key],group.percentage)}</small></div>`).join('')}</div>${chart(group,data,view)}${full?`<div class="chart-bottom-note"><span>${group.note}</span><span>${resolution}</span></div>`:''}</article>`).join('')}</div><div class="history-footer">${view.compact?'':`<span>${data.recordedSince?'记录开始于 '+esc(new Date(data.recordedSince).toLocaleString('zh-CN')):'历史记录从启用后开始积累，暂无过去的数据。'}</span>`}${view.compact?'<button class="link-button" data-monitor-open>查看全部监控 →</button>':'<span>缺少记录的时段留空 · 不补造历史</span>'}</div>`;
}
function hover(container,view,event){
 const plot=event.target.closest('[data-history-chart]');if(!plot)return;
 view.pointer={id:plot.dataset.historyChart,clientX:event.clientX,clientY:event.clientY};showPointer(container,view);
}
function showPointer(container,view){
 if(!view.pointer)return;const plot=container.querySelector(`[data-history-chart="${view.pointer.id}"]`);if(!plot)return;
 const group=groups.find(g=>g.id===view.pointer.id),svg=plot.querySelector('svg'),box=svg.getBoundingClientRect(),W=svg.viewBox.baseVal.width,L=60,R=W-16;
 const position=Math.max(L,Math.min(R,(view.pointer.clientX-box.left)/box.width*W)),at=view.data.from+(position-L)/(R-L)*(view.data.to-view.data.from);
 const point=view.data.points.reduce((closest,p)=>!closest||Math.abs(p.at-at)<Math.abs(closest.at-at)?p:closest,null),valid=point&&Math.abs(point.at-at)<=Math.max(view.data.stepMs*1.5,(view.data.to-view.data.from)*.025),tooltip=plot.querySelector('[data-history-tooltip]'),cursor=plot.querySelector('[data-history-cursor]');
 tooltip.innerHTML=valid?`<strong>${esc(new Date(point.at).toLocaleString('zh-CN'))}</strong>${group.series.map(([key,label])=>`<span>${label}<b>${value(point[key],group.percentage)}</b></span>`).join('')}<small>${point.samples} 次有效帧 · ${view.data.stepMs===5000?'原始采样':'本时间段均值'}</small>`:'<strong>该时段暂无有效数据</strong>';
 tooltip.hidden=false;const local=view.pointer.clientX-plot.getBoundingClientRect().left;tooltip.style.left=Math.max(5,Math.min(local+10,plot.clientWidth-tooltip.offsetWidth-5))+'px';tooltip.style.top='12px';cursor.setAttribute('x1',position);cursor.setAttribute('x2',position);cursor.setAttribute('visibility','visible');
}
function hidePointer(container,view){view.pointer=null;container.querySelectorAll('[data-history-tooltip]').forEach(n=>n.hidden=true);container.querySelectorAll('[data-history-cursor]').forEach(n=>n.setAttribute('visibility','hidden'));}
async function update(container,view,ctx){
 const ticket=++view.ticket;container.setAttribute('aria-busy','true');try{
 const data=await ctx.api('history?range='+view.range);if(ticket!==view.ticket)return;
 view.data=data;patchHTML(container,markup(view,ctx));showPointer(container,view);
 }finally{if(ticket===view.ticket)container.removeAttribute('aria-busy');}
}
export async function mountMonitor(container,ctx,{compact=false}={}){
 if(!container)return;const view={range:ctx.state.monitorRange||'5m',compact,ticket:0,pointer:null};views.set(container,view);container.classList.add('monitor-widget');await update(container,view,ctx);
 container.addEventListener('click',event=>{const range=event.target.closest('[data-history-range]');if(range){view.range=range.dataset.historyRange;ctx.state.monitorRange=view.range;hidePointer(container,view);update(container,view,ctx).catch(error=>ctx.toast(error.message));}if(event.target.closest('[data-monitor-open]'))ctx.navigate('monitor');});
 container.addEventListener('pointermove',event=>hover(container,view,event));container.addEventListener('pointerdown',event=>hover(container,view,event));container.addEventListener('pointerleave',event=>{if(event.pointerType!=='touch')hidePointer(container,view);});
}
export async function refreshMonitor(container,ctx){const view=views.get(container);if(!view)return;await update(container,view,ctx);}
