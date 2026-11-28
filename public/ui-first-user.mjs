import{openUserDetails}from'./ui-user-details.mjs';
export async function firstUserGuide(ctx){
 if(ctx.state.meta.role!=='relay'||!ctx.state.meta.setupComplete||ctx.state.firstUserPrompt||ctx.state.firstUserChecking||document.querySelector('dialog[open]'))return;
 ctx.state.firstUserChecking=true;
 try{
  const status=await ctx.api('user-setup'),label=document.querySelector('.server-identity small');
  if(label)label.textContent=status.mode==='controller'?'中转机 · 等待接入总控':'中转机 · 独立管理';
  if(!status.required)return;ctx.state.firstUserPrompt=true;
  try{await openUserDetails(null,ctx,{firstUser:true,onSaved:async user=>{await ctx.navigate('users');await ctx.showLinks(user.id);},onController:async()=>{await ctx.api('user-setup',{method:'POST',data:{mode:'controller'}});if(label)label.textContent='中转机 · 等待接入总控';ctx.toast('已选择总控端模式，等待接入总控；本机暂不创建用户');}});}catch(error){ctx.state.firstUserPrompt=false;throw error;}
 }finally{ctx.state.firstUserChecking=false;}
}
