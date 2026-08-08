(() => {
  "use strict";
  const $=id=>document.getElementById(id), cfg=window.APP_CONFIG||{};
  const configured=cfg.SUPABASE_URL&&cfg.SUPABASE_PUBLISHABLE_KEY&&!cfg.SUPABASE_URL.includes("YOUR_PROJECT_ID")&&!cfg.SUPABASE_PUBLISHABLE_KEY.includes("YOUR_SUPABASE");
  const icon=k=>k==="success"?"✓":k==="error"?"×":k==="warning"?"!":"i";
  function toast(t,m,k="info",d=5000){
    const stack=$("toastStack")||document.body, el=document.createElement("article");
    el.className=`toast ${k}`; el.innerHTML=`<div class="toast-icon">${icon(k)}</div><div class="toast-copy"><strong></strong><span></span></div><button class="toast-close" type="button" aria-label="Đóng">×</button><span class="toast-progress"></span>`;
    el.querySelector("strong").textContent=t||"Thông báo"; el.querySelector(".toast-copy span").textContent=m||"";
    const close=()=>{el.classList.add("leaving");setTimeout(()=>el.remove(),220)}; el.querySelector(".toast-close").onclick=close;
    stack.append(el); while(stack.children.length>4){const old=stack.firstElementChild;if(!old||old===el)break;old.remove();}
    requestAnimationFrame(()=>el.classList.add("show")); const prog=el.querySelector(".toast-progress"); if(prog)prog.style.animationDuration=`${Math.max(1200,d)}ms`; setTimeout(close,Math.max(1200,d));
  }
  if(!configured){toast("Chưa cấu hình Supabase","Hãy điền Project URL và Publishable Key trong js/config.js.","warning",9000);return;}
  const client=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_PUBLISHABLE_KEY,{auth:{detectSessionInUrl:true,persistSession:true}});
  $("resetForm")?.addEventListener("submit",async e=>{e.preventDefault();const a=$("newPassword").value,b=$("confirmPassword").value;if(a.length<8)return toast("Mật khẩu quá ngắn","Tối thiểu 8 ký tự.","error");if(a!==b)return toast("Không khớp","Hai mật khẩu không giống nhau.","error");const btn=$("resetSubmit");btn.disabled=true;btn.textContent="Đang cập nhật...";try{const {error}=await client.auth.updateUser({password:a});if(error)throw error;toast("Đã đổi mật khẩu","Bạn có thể quay lại đăng nhập.","success",7000);setTimeout(()=>location.href="./",1400);}catch(error){toast("Không đổi được mật khẩu",error.message||String(error),"error",7000);}finally{btn.disabled=false;btn.textContent="Cập nhật mật khẩu";}});
})();
