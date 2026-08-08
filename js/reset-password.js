(() => {
  "use strict";
  const cfg=window.APP_CONFIG||{};
  const $=id=>document.getElementById(id);
  let timer=0;
  function toast(t,m,k="info",d=5000){$("toastTitle").textContent=t;$("toastMessage").textContent=m||"";$("toastIcon").textContent=k==="success"?"✓":"!";$("globalToast").className=`toast ${k} show`;clearTimeout(timer);timer=setTimeout(()=>$("globalToast").classList.remove("show"),d);}
  $("toastClose")?.addEventListener("click",()=>$("globalToast").classList.remove("show"));
  const configured=cfg.SUPABASE_URL&&cfg.SUPABASE_PUBLISHABLE_KEY&&!cfg.SUPABASE_URL.includes("YOUR_PROJECT_ID");
  if(!configured){toast("Chưa cấu hình Supabase","Điền js/config.js trước.","error",8000);return;}
  const client=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_PUBLISHABLE_KEY,{auth:{detectSessionInUrl:true,persistSession:true}});
  $("resetForm")?.addEventListener("submit",async e=>{e.preventDefault();const a=$("newPassword").value,b=$("confirmPassword").value;if(a.length<8)return toast("Mật khẩu quá ngắn","Tối thiểu 8 ký tự.","error");if(a!==b)return toast("Không khớp","Hai mật khẩu không giống nhau.","error");const btn=$("resetSubmit");btn.disabled=true;try{const {error}=await client.auth.updateUser({password:a});if(error)throw error;toast("Đã đổi mật khẩu","Bạn có thể quay lại đăng nhập.","success",7000);setTimeout(()=>location.href="./",1400);}catch(error){toast("Không đổi được mật khẩu",error.message||String(error),"error",7000);}finally{btn.disabled=false;}});
})();
