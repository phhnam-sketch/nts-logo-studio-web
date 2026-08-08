(() => {
  "use strict";
  const $=id=>document.getElementById(id);
  const NTS=window.NTS=window.NTS||{};
  const state={members:[],payments:[],stats:null,loading:false};
  const client=()=>NTS.supabase;
  const toast=(t,m,k="info",d)=>NTS.showToast?.(t,m,k,d);
  const money=v=>NTS.membership?.money?.(v)||`${Number(v||0).toLocaleString("vi-VN")} ₫`;
  const dt=v=>NTS.membership?.dateTime?.(v)||"—";
  const esc=v=>String(v??"").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[c]);

  async function refresh(){
    if(NTS.membership?.state?.account?.role!=="admin") return;
    if(state.loading) return;
    state.loading=true;
    try{await Promise.all([loadStats(),loadMembers(),loadPayments(),loadServiceSettings()]);}
    catch(error){console.error(error);toast("Không tải được Admin Dashboard",error.message||String(error),"error",7000);}
    finally{state.loading=false;}
  }

  async function loadStats(){
    const {data,error}=await client().rpc("admin_stats"); if(error)throw error;
    state.stats=Array.isArray(data)?data[0]:data;
    const s=state.stats||{};
    [["statTotalUsers",s.total_users],["statVipUsers",s.vip_users],["statFreeUsers",s.free_users],["statPendingPayments",s.pending_payments]].forEach(([id,v])=>{if($(id))$(id).textContent=Number(v||0).toLocaleString("vi-VN");});
    if($("statRevenue")) $("statRevenue").textContent=money(s.approved_revenue_month||0);
    if($("statSuspended")) $("statSuspended").textContent=Number(s.suspended_users||0).toLocaleString("vi-VN");
  }

  async function loadMembers(){
    const search=$("adminMemberSearch")?.value?.trim()||null;
    const {data,error}=await client().rpc("admin_list_members",{p_search:search}); if(error)throw error;
    state.members=data||[]; renderMembers();
  }

  function renderMembers(){
    const tbody=$("adminMembersBody"); if(!tbody)return;
    if(!state.members.length){tbody.innerHTML='<tr><td colspan="8" class="table-empty">Không có hội viên phù hợp.</td></tr>';return;}
    tbody.innerHTML=state.members.map(m=>`<tr data-user-id="${m.user_id}">
      <td><div class="member-cell"><strong>${esc(m.display_name)}</strong><small>${esc(m.email)}</small></div></td>
      <td><span class="plan-badge ${m.role==='admin'?'admin':m.plan==='vip'?'vip':'free'}">${m.role==='admin'?'ADMIN':String(m.plan).toUpperCase()}</span></td>
      <td><span class="account-status ${m.status}">${m.status==='active'?'Hoạt động':'Tạm khóa'}</span></td>
      <td>${m.month_used||0}</td>
      <td>${m.free_limit==null?'Mặc định':m.free_limit}</td>
      <td>${m.vip_until?dt(m.vip_until):'—'}</td>
      <td>${dt(m.created_at)}</td>
      <td><button class="mini-button" data-admin-edit="${m.user_id}" type="button">Quản lý</button></td>
    </tr>`).join("");
  }

  async function loadPayments(){
    const filter=$("adminPaymentFilter")?.value||"pending";
    const {data,error}=await client().rpc("admin_list_payments",{p_status:filter}); if(error)throw error;
    state.payments=data||[]; await renderPayments();
  }

  async function proofUrl(path){
    if(!path)return null;
    const {data,error}=await client().storage.from("payment-proofs").createSignedUrl(path,600);
    if(error)return null; return data?.signedUrl||null;
  }

  async function renderPayments(){
    const wrap=$("adminPaymentsList"); if(!wrap)return;
    if(!state.payments.length){wrap.innerHTML='<div class="empty-admin-card">Không có yêu cầu thanh toán.</div>';return;}
    const cards=[];
    for(const p of state.payments){
      const url=await proofUrl(p.proof_path);
      cards.push(`<article class="admin-payment-card">
        <div class="admin-payment-head"><div><strong>${esc(p.display_name)}</strong><span>${esc(p.email)}</span></div><span class="request-status ${p.status}">${p.status==='pending'?'Chờ duyệt':p.status==='approved'?'Đã duyệt':'Từ chối'}</span></div>
        <div class="admin-payment-grid"><span>Số tiền<strong>${money(p.amount)}</strong></span><span>Nội dung<strong>${esc(p.reference||'—')}</strong></span><span>Ngày gửi<strong>${dt(p.created_at)}</strong></span></div>
        ${p.note?`<p class="admin-note">${esc(p.note)}</p>`:""}
        ${url?`<a class="proof-link" href="${url}" target="_blank" rel="noopener">Xem minh chứng thanh toán ↗</a>`:'<span class="muted">Không có minh chứng</span>'}
        ${p.status==='pending'?`<div class="admin-payment-actions"><button class="primary-button compact" data-payment-approve="${p.payment_id}" type="button">✓ Duyệt +1 tháng VIP</button><button class="danger-soft-button compact" data-payment-reject="${p.payment_id}" type="button">Từ chối</button></div>`:`${p.admin_note?`<small>Admin: ${esc(p.admin_note)}</small>`:""}`}
      </article>`);
    }
    wrap.innerHTML=cards.join("");
  }

  function openMemberModal(id){
    const m=state.members.find(x=>x.user_id===id);if(!m)return;
    $("memberModalUserId").value=m.user_id;
    $("memberModalName").textContent=m.display_name;
    $("memberModalEmail").textContent=m.email;
    $("memberStatusSelect").value=m.status;
    $("memberPlanSelect").value=m.plan;
    $("memberFreeLimit").value=m.free_limit??"";
    $("memberVipUntil").value=m.vip_until?new Date(new Date(m.vip_until).getTime()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16):"";
    $("memberManageModal").classList.remove("hidden");
  }
  function closeMemberModal(){$("memberManageModal")?.classList.add("hidden");}

  async function saveMember(event){
    event.preventDefault();
    const uid=$("memberModalUserId").value;
    const status=$("memberStatusSelect").value,plan=$("memberPlanSelect").value;
    const vipRaw=$("memberVipUntil").value;
    const freeRaw=$("memberFreeLimit").value.trim();
    const args={p_user_id:uid,p_status:status,p_plan:plan,p_vip_until:vipRaw?new Date(vipRaw).toISOString():null,p_free_limit:freeRaw===""?null:Number(freeRaw),p_clear_free_limit:freeRaw===""};
    const btn=$("saveMemberButton");btn.disabled=true;
    try{const {error}=await client().rpc("admin_update_member",args);if(error)throw error;closeMemberModal();toast("Đã cập nhật hội viên","Quyền truy cập và gói thành viên đã được cập nhật.","success");await refresh();}
    catch(error){toast("Không cập nhật được",error.message||String(error),"error");}
    finally{btn.disabled=false;}
  }

  async function reviewPayment(id,action){
    const label=action==='approve'?'DUYỆT thanh toán và cộng 1 tháng VIP':'TỪ CHỐI yêu cầu này';
    if(!confirm(`Xác nhận ${label}?`))return;
    let note=""; if(action==='reject') note=prompt("Lý do từ chối (có thể để trống):","")||"";
    try{const {error}=await client().rpc("admin_review_payment",{p_request_id:id,p_action:action,p_admin_note:note||null});if(error)throw error;toast(action==='approve'?"Đã kích hoạt VIP":"Đã từ chối",action==='approve'?"Hội viên đã được cộng thêm 1 tháng VIP.":"Yêu cầu đã được cập nhật.",action==='approve'?"success":"warning");await refresh();}
    catch(error){toast("Không xử lý được thanh toán",error.message||String(error),"error",7000);}
  }


  async function loadServiceSettings(){
    const {data,error}=await client().from("site_settings").select("*").eq("id",true).single();
    if(error) throw error;
    if($("adminFreeLimit")) $("adminFreeLimit").value=data.free_monthly_limit??10;
    if($("adminVipPrice")) $("adminVipPrice").value=data.vip_monthly_price??200000;
    if($("adminBankName")) $("adminBankName").value=data.bank_name||"";
    if($("adminAccountName")) $("adminAccountName").value=data.account_name||"";
    if($("adminAccountNumber")) $("adminAccountNumber").value=data.account_number||"";
    if($("adminTransferPrefix")) $("adminTransferPrefix").value=data.transfer_prefix||"";
    if($("adminSupportText")) $("adminSupportText").value=data.support_text||"";
  }

  async function saveServiceSettings(event){
    event.preventDefault();
    const btn=$("saveAdminSettings"); btn.disabled=true;
    try{
      const payload={
        free_monthly_limit:Number($("adminFreeLimit").value),
        vip_monthly_price:Number($("adminVipPrice").value),
        bank_name:$("adminBankName").value.trim(),
        account_name:$("adminAccountName").value.trim(),
        account_number:$("adminAccountNumber").value.trim(),
        transfer_prefix:$("adminTransferPrefix").value.trim()||"NTSVIP",
        support_text:$("adminSupportText").value.trim()
      };
      if(!Number.isInteger(payload.free_monthly_limit)||payload.free_monthly_limit<0) throw new Error("Quota Free không hợp lệ.");
      if(!Number.isInteger(payload.vip_monthly_price)||payload.vip_monthly_price<0) throw new Error("Giá VIP không hợp lệ.");
      const {error}=await client().from("site_settings").update(payload).eq("id",true); if(error) throw error;
      toast("Đã lưu cấu hình","Giá VIP, quota và thông tin chuyển khoản đã được cập nhật.","success");
      await NTS.membership?.loadSettings?.(); await NTS.membership?.refreshAccount?.({silent:true});
    }catch(error){toast("Không lưu được cấu hình",error.message||String(error),"error",7000);}
    finally{btn.disabled=false;}
  }

  async function resetMemberUsage(){
    const uid=$("memberModalUserId").value; if(!uid)return;
    if(!confirm("Reset toàn bộ lượt Free đã dùng của hội viên trong tháng này?"))return;
    const btn=$("resetMemberUsageButton"); btn.disabled=true;
    try{const {error}=await client().rpc("admin_reset_usage",{p_user_id:uid}); if(error)throw error; toast("Đã reset quota","Lượt đã dùng tháng này đã về 0.","success"); await refresh();}
    catch(error){toast("Không reset được quota",error.message||String(error),"error");}
    finally{btn.disabled=false;}
  }

  let searchTimer=0;
  $("adminMemberSearch")?.addEventListener("input",()=>{clearTimeout(searchTimer);searchTimer=setTimeout(loadMembers,320);});
  $("adminPaymentFilter")?.addEventListener("change",loadPayments);
  $("refreshAdminButton")?.addEventListener("click",refresh);
  $("adminMembersBody")?.addEventListener("click",e=>{const b=e.target.closest("[data-admin-edit]");if(b)openMemberModal(b.dataset.adminEdit);});
  $("adminPaymentsList")?.addEventListener("click",e=>{const a=e.target.closest("[data-payment-approve]");const r=e.target.closest("[data-payment-reject]");if(a)reviewPayment(a.dataset.paymentApprove,"approve");if(r)reviewPayment(r.dataset.paymentReject,"reject");});
  $("memberManageClose")?.addEventListener("click",closeMemberModal);
  $("memberManageModal")?.addEventListener("click",e=>{if(e.target.id==="memberManageModal")closeMemberModal();});
  $("memberManageForm")?.addEventListener("submit",saveMember);
  $("resetMemberUsageButton")?.addEventListener("click",resetMemberUsage);
  $("adminSettingsForm")?.addEventListener("submit",saveServiceSettings);

  window.addEventListener("nts:membership-updated",e=>{if(e.detail.account?.role==='admin'&&!$("adminPage")?.classList.contains("hidden"))refresh();});
  NTS.admin={state,refresh,loadMembers,loadPayments,loadServiceSettings};
})();
