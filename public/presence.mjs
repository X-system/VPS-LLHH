export function lastOnline(user,{now=Date.now(),timeZone}={}){
 const seen=user.last_online,known=Number.isSafeInteger(seen)&&seen>0;
 const exact=known?new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',...(timeZone?{timeZone}:{})}).format(seen):'从未上线';
 if(user.online===true)return{label:'当前在线',exact};
 if(!known)return{label:'从未上线',exact};
 if(seen>now+60000)return{label:'时间待校准',exact};
 const minutes=Math.max(0,Math.floor((now-seen)/60000));
 if(!minutes)return{label:'不足1分钟前在线',exact};
 const days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60),rest=minutes%60;
 return{label:(days?days+'天':'')+(hours?hours+'小时':'')+(rest?rest+'分钟':'')+'前在线',exact};
}
