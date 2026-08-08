(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const cfg = window.APP_CONFIG || {};
  const NTS = window.NTS = window.NTS || {};

  const state = {
    user: null,
    account: null,
    settings: null,
    loading: false,
    currentReservation: null
  };

  function client() { return NTS.supabase; }
  function toast(t,m,k="info",d) { NTS.showToast?.(t,m,k,d); }
  function money(v) { return new Intl.NumberFormat("vi-VN", { style:"currency", currency:"VND", maximumFractionDigits:0 }).format(Number(v||0)); }
  function dateTime(v) { if (!v) return "—"; try { return new Intl.DateTimeFormat("vi-VN", {dateStyle:"medium", timeStyle:"short"}).format(new Date(v)); } catch { return "—"; } }

  function fallbackSettings() {
    const m = cfg.MEMBERSHIP || {};
    return {
      free_monthly_limit: Number(m.freeMonthlyImages || 10),
      vip_monthly_price: Number(m.vipMonthlyPriceVnd || 200000),
      bank_name: m.bankName || "THAY TÊN NGÂN HÀNG",
      account_name: m.accountName || "THAY TÊN CHỦ TÀI KHOẢN",
      account_number: m.accountNumber || "THAY SỐ TÀI KHOẢN",
      transfer_prefix: m.transferPrefix || "NTSVIP",
      support_text: m.supportText || ""
    };
  }

  async function loadSettings() {
    const c = client();
    if (!c) return fallbackSettings();
    try {
      const { data, error } = await c.from("site_settings").select("*").eq("id", true).single();
      if (error) throw error;
      state.settings = { ...fallbackSettings(), ...(data || {}) };
    } catch (error) {
      console.warn("site_settings fallback", error);
      state.settings = fallbackSettings();
    }
    renderVipPage();
    return state.settings;
  }

  function defaultAccount() {
    const s = state.settings || fallbackSettings();
    return {
      role:"member", plan:"free", status:"active", vip_until:null, is_vip:false,
      free_limit:s.free_monthly_limit, used:0, reserved:0, remaining:s.free_monthly_limit,
      vip_monthly_price:s.vip_monthly_price
    };
  }

  async function refreshAccount({silent=false}={}) {
    const c = client();
    if (!c || !state.user) return null;
    if (!silent) state.loading = true;
    try {
      const { data, error } = await c.rpc("get_my_account_state");
      if (error) throw error;
      state.account = Array.isArray(data) ? data[0] : data;
      if (!state.account) state.account = defaultAccount();
      renderAccount();
      window.dispatchEvent(new CustomEvent("nts:membership-updated", {detail:{account:state.account}}));
      return state.account;
    } catch (error) {
      console.error(error);
      state.account = defaultAccount();
      renderAccount();
      if (!silent) toast("Chưa cài database V3", "Hãy chạy file supabase/001_membership_schema.sql trong Supabase SQL Editor.", "warning", 8500);
      return state.account;
    } finally { state.loading = false; }
  }

  function renderAccount() {
    const a = state.account || defaultAccount();
    const vip = Boolean(a.is_vip);
    const admin = a.role === "admin";
    const planLabel = admin ? "ADMIN" : vip ? "VIP" : "FREE";
    ["topPlanBadge","profilePlanBadge"].forEach(id => {
      const el=$(id); if (!el) return; el.textContent=planLabel; el.className=`plan-badge ${admin?"admin":vip?"vip":"free"}`;
    });
    $("adminNavButton")?.classList.toggle("hidden", !admin);
    $("adminQuickMenu")?.classList.toggle("hidden", !admin);
    const remain = vip ? "Không giới hạn" : `${Math.max(0, Number(a.remaining||0))}/${Number(a.free_limit||10)} ảnh còn lại`;
    if ($("quotaText")) $("quotaText").textContent = remain;
    if ($("quotaUsed")) $("quotaUsed").textContent = vip ? "∞" : String(a.used || 0);
    if ($("quotaLimit")) $("quotaLimit").textContent = vip ? "∞" : String(a.free_limit || 10);
    if ($("profileQuotaBar")) { const pct=vip?100:Math.min(100,Math.round(Number(a.used||0)/Math.max(1,Number(a.free_limit||10))*100)); $("profileQuotaBar").style.width=`${pct}%`; }
    if ($("profileMembershipText")) $("profileMembershipText").textContent = admin ? "Tài khoản quản trị viên" : vip ? `VIP đến ${dateTime(a.vip_until)}` : `Free · ${remain}`;
    if ($("vipUntilText")) $("vipUntilText").textContent = vip && a.vip_until ? dateTime(a.vip_until) : "Chưa kích hoạt VIP";
    if ($("upgradeCta")) $("upgradeCta").classList.toggle("hidden", vip || admin);
    const suspended = a.status === "suspended";
    $("suspendedOverlay")?.classList.toggle("hidden", !suspended);
  }

  function renderVipPage() {
    const s = state.settings || fallbackSettings();
    if ($("vipPrice")) $("vipPrice").textContent = money(s.vip_monthly_price);
    if ($("freeLimitCopy")) $("freeLimitCopy").textContent = `${s.free_monthly_limit} ảnh/tháng`;
    if ($("paymentBank")) $("paymentBank").textContent = s.bank_name;
    if ($("paymentAccountName")) $("paymentAccountName").textContent = s.account_name;
    if ($("paymentAccountNumber")) $("paymentAccountNumber").textContent = s.account_number;
    if ($("paymentSupport")) $("paymentSupport").textContent = s.support_text;
    const qr=$("paymentQr"); if (qr) qr.src=(cfg.MEMBERSHIP?.paymentQrUrl || "assets/payment/payment-qr.png");
    updateTransferContent();
  }

  function updateTransferContent() {
    const s = state.settings || fallbackSettings();
    const suffix = state.user?.id ? state.user.id.replace(/-/g,"").slice(0,8).toUpperCase() : "USER";
    const content = `${s.transfer_prefix || "NTSVIP"} ${suffix}`;
    if ($("paymentContent")) $("paymentContent").textContent = content;
  }

  async function beginExport(count) {
    if (!state.user) throw new Error("Bạn cần đăng nhập trước khi xuất ảnh.");
    await refreshAccount({silent:true});
    if (state.account?.status === "suspended") throw new Error("Tài khoản đang bị tạm khóa bởi quản trị viên.");
    const c=client();
    if (!c) throw new Error("Không kết nối được Supabase.");
    const { data, error } = await c.rpc("begin_export", { p_count: Number(count) });
    if (error) {
      const msg=String(error.message||"");
      if (msg.includes("FREE_QUOTA_EXCEEDED")) {
        openPage("vipPage");
        throw new Error(`Gói Free không còn đủ lượt cho ${count} ảnh. Hãy nâng cấp VIP để xuất không giới hạn.`);
      }
      if (msg.includes("ACCOUNT_SUSPENDED")) throw new Error("Tài khoản đang bị tạm khóa.");
      throw error;
    }
    state.currentReservation=data;
    await refreshAccount({silent:true});
    return data;
  }

  async function finishExport(reservation, successCount) {
    if (!reservation || !client()) return;
    try { await client().rpc("finish_export", { p_reservation: reservation, p_success_count: Number(successCount||0) }); }
    finally { if (state.currentReservation===reservation) state.currentReservation=null; await refreshAccount({silent:true}); }
  }

  async function cancelExport(reservation) {
    if (!reservation || !client()) return;
    try { await client().rpc("cancel_export_reservation", { p_reservation: reservation }); }
    finally { if (state.currentReservation===reservation) state.currentReservation=null; await refreshAccount({silent:true}); }
  }

  function openPage(pageId) {
    document.querySelectorAll(".app-page").forEach(p=>p.classList.toggle("hidden", p.id!==pageId));
    document.querySelectorAll("[data-page]").forEach(b=>b.classList.toggle("active", b.dataset.page===pageId));
    window.scrollTo({top:0,behavior:"smooth"});
    if (pageId==="vipPage") { loadPaymentHistory(); renderVipPage(); }
    if (pageId==="adminPage") window.NTS.admin?.refresh?.();
    if (pageId==="profilePage") window.NTS.profile?.refresh?.();
  }

  document.addEventListener("click", (event) => {
    const nav=event.target.closest("[data-page]");
    if (!nav) return;
    if (nav.dataset.page==="adminPage" && state.account?.role!=="admin") return;
    openPage(nav.dataset.page);
  });

  async function uploadPaymentProof(file) {
    if (!file) return null;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) && file.type!=="application/pdf") throw new Error("Minh chứng chỉ nhận JPG, PNG, WebP hoặc PDF.");
    if (file.size > 8*1024*1024) throw new Error("Minh chứng tối đa 8 MB.");
    const ext=(file.name.split(".").pop()||"jpg").replace(/[^a-z0-9]/gi,"").toLowerCase();
    const path=`${state.user.id}/${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`;
    const { error }=await client().storage.from("payment-proofs").upload(path,file,{upsert:false,contentType:file.type});
    if (error) throw error;
    return path;
  }

  async function submitPayment(event) {
    event.preventDefault();
    const btn=$("submitPaymentButton"); btn.disabled=true;
    let proofPath=null;
    try {
      const proof=$("paymentProof")?.files?.[0] || null;
      if (proof) proofPath=await uploadPaymentProof(proof);
      const reference=$("paymentReference")?.value?.trim() || null;
      const note=$("paymentNote")?.value?.trim() || null;
      const { error }=await client().rpc("submit_vip_payment", {p_reference:reference,p_note:note,p_proof_path:proofPath});
      if (error) throw error;
      $("vipPaymentForm")?.reset();
      toast("Đã gửi yêu cầu VIP", "Quản trị viên sẽ kiểm tra chuyển khoản và kích hoạt 1 tháng VIP.", "success", 7000);
      await loadPaymentHistory();
    } catch (error) {
      console.error(error);
      if (proofPath) client().storage.from("payment-proofs").remove([proofPath]).catch(()=>{});
      const msg=String(error?.message||error);
      toast("Không gửi được yêu cầu", msg.includes("TOO_MANY_PENDING")?"Bạn đang có quá nhiều yêu cầu chờ duyệt.":msg, "error", 7000);
    } finally { btn.disabled=false; }
  }

  async function loadPaymentHistory() {
    if (!client() || !state.user) return;
    const wrap=$("paymentHistory"); if (!wrap) return;
    wrap.innerHTML='<div class="skeleton-line"></div>';
    const { data, error }=await client().from("payment_requests").select("id,amount,status,reference,admin_note,created_at,reviewed_at").eq("user_id",state.user.id).order("created_at",{ascending:false}).limit(20);
    if (error) { wrap.innerHTML='<p class="muted">Không tải được lịch sử thanh toán.</p>'; return; }
    if (!data?.length) { wrap.innerHTML='<p class="muted">Chưa có yêu cầu nâng cấp nào.</p>'; return; }
    wrap.innerHTML=data.map(row=>`<div class="payment-history-row"><div><strong>${money(row.amount)}</strong><span>${new Date(row.created_at).toLocaleDateString("vi-VN")}${row.reference?` · ${escapeHtml(row.reference)}`:""}</span></div><span class="request-status ${row.status}">${statusLabel(row.status)}</span>${row.admin_note?`<small>${escapeHtml(row.admin_note)}</small>`:""}</div>`).join("");
  }

  function statusLabel(v){return ({pending:"Chờ duyệt",approved:"Đã duyệt",rejected:"Từ chối",cancelled:"Đã hủy"})[v]||v;}
  function escapeHtml(v){return String(v??"").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[c]);}

  $("vipPaymentForm")?.addEventListener("submit", submitPayment);
  $("suspendedLogout")?.addEventListener("click",()=>$("logoutButton")?.click());
  $("copyPaymentContent")?.addEventListener("click", async()=>{
    const text=$("paymentContent")?.textContent||""; try{await navigator.clipboard.writeText(text); toast("Đã sao chép", text, "success");}catch{toast("Nội dung chuyển khoản",text,"info",7000);}
  });

  window.addEventListener("nts:auth-user", async (event) => {
    state.user=event.detail.user || null;
    if (!state.user) { state.account=null; return; }
    await loadSettings(); updateTransferContent(); await refreshAccount();
  });

  NTS.membership = { state, refreshAccount, beginExport, finishExport, cancelExport, openPage, loadSettings, money, dateTime };

  if (NTS.currentUser) {
    state.user=NTS.currentUser;
    loadSettings().then(()=>refreshAccount());
  } else { renderVipPage(); }
})();
