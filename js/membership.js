(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const cfg = window.APP_CONFIG || {};
  const NTS = window.NTS = window.NTS || {};
  const state = {
    user: null,
    account: null,
    settings: null,
    loading: false,
    currentReservation: null,
    paymentMonths: 1,
    paymentOrderCode: "",
    paymentPollTimer: 0,
    pendingPaymentIds: new Set()
  };

  function client() { return NTS.supabase; }
  function toast(t, m, k = "info", d) { NTS.showToast?.(t, m, k, d); }
  function money(v) { return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(Number(v || 0)); }
  function dateTime(v) { if (!v) return "—"; try { return new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(v)); } catch { return "—"; } }
  function escapeHtml(v) { return String(v ?? "").replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]); }

  function fallbackSettings() {
    const m = cfg.MEMBERSHIP || {};
    return {
      free_monthly_limit: Number(m.freeMonthlyImages || 10),
      vip_monthly_price: Number(m.vipMonthlyPriceVnd || 200000),
      bank_name: m.bankName || "THAY TÊN NGÂN HÀNG",
      account_name: m.accountName || "THAY TÊN CHỦ TÀI KHOẢN",
      account_number: m.accountNumber || "THAY SỐ TÀI KHOẢN",
      transfer_prefix: m.transferPrefix || "NTSVIP",
      support_text: m.supportText || "",
      payment_qr_url: null
    };
  }

  async function loadSettings() {
    const c = client();
    if (!c) { state.settings = fallbackSettings(); renderVipPage(); return state.settings; }
    try {
      const { data, error } = await c.from("site_settings").select("*").eq("id", true).single();
      if (error) throw error;
      state.settings = { ...fallbackSettings(), ...(data || {}) };
    } catch (error) {
      console.warn("site_settings fallback", error);
      state.settings = fallbackSettings();
    }
    if (!state.paymentOrderCode) regenerateOrderCode();
    renderVipPage();
    return state.settings;
  }

  function defaultAccount() {
    const s = state.settings || fallbackSettings();
    return { role: "member", plan: "free", status: "active", vip_until: null, is_vip: false, free_limit: s.free_monthly_limit, used: 0, reserved: 0, remaining: s.free_monthly_limit, vip_monthly_price: s.vip_monthly_price };
  }

  async function refreshAccount({ silent = false } = {}) {
    const c = client();
    if (!c || !state.user) return null;
    if (!silent) state.loading = true;
    try {
      const { data, error } = await c.rpc("get_my_account_state");
      if (error) throw error;
      state.account = Array.isArray(data) ? data[0] : data;
      if (!state.account) state.account = defaultAccount();
      renderAccount();
      window.dispatchEvent(new CustomEvent("nts:membership-updated", { detail: { account: state.account } }));
      return state.account;
    } catch (error) {
      console.error(error);
      state.account = defaultAccount();
      renderAccount();
      if (!silent) toast("Chưa cài database V3.2", "Hãy chạy migration 001, 002 và 003_v3_2_profile_payment.sql trong Supabase SQL Editor.", "warning", 9000);
      return state.account;
    } finally { state.loading = false; }
  }

  function renderAccount() {
    const a = state.account || defaultAccount();
    const vip = Boolean(a.is_vip), admin = a.role === "admin";
    const planLabel = admin ? "ADMIN" : vip ? "VIP" : "FREE";
    ["topPlanBadge", "profilePlanBadge"].forEach(id => {
      const el = $(id); if (!el) return;
      el.textContent = planLabel; el.className = `plan-badge ${admin ? "admin" : vip ? "vip" : "free"}`;
    });
    $("adminNavButton")?.classList.toggle("hidden", !admin);
    $("adminQuickMenu")?.classList.toggle("hidden", !admin);
    const remain = vip ? "Không giới hạn" : `${Math.max(0, Number(a.remaining || 0))}/${Number(a.free_limit || 10)} ảnh còn lại`;
    if ($("quotaText")) $("quotaText").textContent = remain;
    if ($("quotaUsed")) $("quotaUsed").textContent = vip ? "∞" : String(a.used || 0);
    if ($("quotaLimit")) $("quotaLimit").textContent = vip ? "∞" : String(a.free_limit || 10);
    if ($("profileQuotaBar")) {
      const pct = vip ? 100 : Math.min(100, Math.round(Number(a.used || 0) / Math.max(1, Number(a.free_limit || 10)) * 100));
      $("profileQuotaBar").style.width = `${pct}%`;
    }
    if ($("profileMembershipText")) $("profileMembershipText").textContent = admin ? "Tài khoản quản trị viên" : vip ? `VIP đến ${dateTime(a.vip_until)}` : `Free · ${remain}`;
    if ($("vipUntilText")) $("vipUntilText").textContent = vip && a.vip_until ? dateTime(a.vip_until) : "Chưa kích hoạt VIP";
    $("upgradeCta")?.classList.toggle("hidden", vip || admin);
    $("suspendedOverlay")?.classList.toggle("hidden", a.status !== "suspended");
  }

  function sanitizePrefix(value) { return String(value || "NTSVIP").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "NTSVIP"; }
  function regenerateOrderCode() {
    const s = state.settings || fallbackSettings();
    const uid = state.user?.id ? state.user.id.replace(/-/g, "").slice(0, 6).toUpperCase() : "USER00";
    const d = new Date();
    const stamp = `${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
    state.paymentOrderCode = `${sanitizePrefix(s.transfer_prefix)}-${uid}-${stamp}`;
    return state.paymentOrderCode;
  }
  function paymentAmount() { return Number((state.settings || fallbackSettings()).vip_monthly_price || 0) * Number(state.paymentMonths || 1); }

  function renderPaymentPlan() {
    const s = state.settings || fallbackSettings();
    const base = Number(s.vip_monthly_price || 0);
    [1, 3, 6, 12].forEach(months => {
      const id = months === 1 ? "price1Month" : `price${months}Month`;
      if ($(id)) $(id).textContent = money(base * months);
    });
    document.querySelectorAll("#vipDurationSelector [data-months]").forEach(btn => btn.classList.toggle("active", Number(btn.dataset.months) === state.paymentMonths));
    const amount = paymentAmount();
    if ($("paymentAmount")) $("paymentAmount").textContent = money(amount);
    if ($("paymentAmountCopy")) $("paymentAmountCopy").textContent = money(amount);
    if ($("selectedPlanMonths")) $("selectedPlanMonths").textContent = `${state.paymentMonths} tháng VIP`;
    if ($("paymentOrderMonths")) $("paymentOrderMonths").textContent = `${state.paymentMonths} tháng`;
    if ($("paymentOrderAmount")) $("paymentOrderAmount").textContent = money(amount);
  }

  function renderVipPage() {
    const s = state.settings || fallbackSettings();
    if ($("vipPrice")) $("vipPrice").textContent = money(s.vip_monthly_price);
    if ($("freeLimitCopy")) $("freeLimitCopy").textContent = `${s.free_monthly_limit} ảnh/tháng`;
    if ($("paymentBank")) $("paymentBank").textContent = s.bank_name;
    if ($("paymentAccountName")) $("paymentAccountName").textContent = s.account_name;
    if ($("paymentAccountNumber")) $("paymentAccountNumber").textContent = s.account_number;
    if ($("paymentSupport")) $("paymentSupport").textContent = s.support_text;
    const qr = $("paymentQr"); if (qr) qr.src = s.payment_qr_url || cfg.MEMBERSHIP?.paymentQrUrl || "assets/payment/payment-qr.png";
    if (!state.paymentOrderCode) regenerateOrderCode();
    if ($("paymentContent")) $("paymentContent").textContent = state.paymentOrderCode;
    if ($("paymentOrderCode")) $("paymentOrderCode").textContent = state.paymentOrderCode;
    renderPaymentPlan();
  }

  async function copyText(text, title = "Đã sao chép") {
    try { await navigator.clipboard.writeText(String(text || "")); toast(title, String(text || ""), "success", 2600); }
    catch { toast(title, String(text || ""), "info", 6500); }
  }

  function paymentDetailsText() {
    const s = state.settings || fallbackSettings();
    return [
      `NTS Logo Studio - VIP ${state.paymentMonths} tháng`,
      `Ngân hàng: ${s.bank_name}`,
      `Chủ TK: ${s.account_name}`,
      `Số TK: ${s.account_number}`,
      `Số tiền: ${money(paymentAmount())}`,
      `Nội dung: ${state.paymentOrderCode}`
    ].join("\n");
  }

  async function beginExport(count) {
    if (!state.user) throw new Error("Bạn cần đăng nhập trước khi xuất ảnh.");
    await refreshAccount({ silent: true });
    if (state.account?.status === "suspended") throw new Error("Tài khoản đang bị tạm khóa bởi quản trị viên.");
    const c = client(); if (!c) throw new Error("Không kết nối được Supabase.");
    const { data, error } = await c.rpc("begin_export", { p_count: Number(count) });
    if (error) {
      const msg = String(error.message || "");
      if (msg.includes("FREE_QUOTA_EXCEEDED")) { openPage("vipPage"); throw new Error(`Gói Free không còn đủ lượt cho ${count} ảnh. Hãy nâng cấp VIP để xuất không giới hạn.`); }
      if (msg.includes("ACCOUNT_SUSPENDED")) throw new Error("Tài khoản đang bị tạm khóa.");
      throw error;
    }
    state.currentReservation = data; await refreshAccount({ silent: true }); return data;
  }
  async function finishExport(reservation, successCount) {
    if (!reservation || !client()) return;
    try { await client().rpc("finish_export", { p_reservation: reservation, p_success_count: Number(successCount || 0) }); }
    finally { if (state.currentReservation === reservation) state.currentReservation = null; await refreshAccount({ silent: true }); }
  }
  async function cancelExport(reservation) {
    if (!reservation || !client()) return;
    try { await client().rpc("cancel_export_reservation", { p_reservation: reservation }); }
    finally { if (state.currentReservation === reservation) state.currentReservation = null; await refreshAccount({ silent: true }); }
  }

  function openPage(pageId) {
    document.querySelectorAll(".app-page").forEach(p => p.classList.toggle("hidden", p.id !== pageId));
    document.querySelectorAll("[data-page]").forEach(b => b.classList.toggle("active", b.dataset.page === pageId));
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (pageId === "vipPage") { loadPaymentHistory({ silent: true }); renderVipPage(); startPaymentPolling(); }
    else stopPaymentPolling();
    if (pageId === "adminPage") NTS.admin?.refresh?.();
    if (pageId === "profilePage") NTS.profile?.refresh?.();
  }
  document.addEventListener("click", event => {
    const nav = event.target.closest("[data-page]");
    if (!nav) return;
    if (nav.dataset.page === "adminPage" && state.account?.role !== "admin") return;
    openPage(nav.dataset.page);
  });

  async function uploadPaymentProof(file) {
    if (!file) return null;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) && file.type !== "application/pdf") throw new Error("Minh chứng chỉ nhận JPG, PNG, WebP hoặc PDF.");
    if (file.size > 8 * 1024 * 1024) throw new Error("Minh chứng tối đa 8 MB.");
    const ext = (file.name.split(".").pop() || "jpg").replace(/[^a-z0-9]/gi, "").toLowerCase();
    const path = `${state.user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await client().storage.from("payment-proofs").upload(path, file, { upsert: false, contentType: file.type });
    if (error) throw error;
    return path;
  }

  async function submitPayment(event) {
    event.preventDefault();
    const btn = $("submitPaymentButton"); if (btn) { btn.disabled = true; btn.textContent = "Đang gửi yêu cầu..."; }
    const status = $("paymentAutoStatus"); if (status) { status.textContent = "Đang gửi..."; status.dataset.kind = "busy"; }
    let proofPath = null;
    try {
      const proof = $("paymentProof")?.files?.[0] || null;
      if (proof) proofPath = await uploadPaymentProof(proof);
      const transaction = $("paymentTransactionCode")?.value?.trim() || null;
      const note = $("paymentNote")?.value?.trim() || null;
      const { error } = await client().rpc("submit_vip_payment_v32", {
        p_months: state.paymentMonths,
        p_order_code: state.paymentOrderCode,
        p_transaction_code: transaction,
        p_note: note,
        p_proof_path: proofPath
      });
      if (error) {
        if (/submit_vip_payment_v32|schema cache|function/i.test(String(error.message || error))) throw new Error("Database chưa có Smart Payment V3.2. Hãy chạy `supabase/003_v3_2_profile_payment.sql`.");
        throw error;
      }
      $("vipPaymentForm")?.reset();
      if (status) { status.textContent = "Đang chờ duyệt"; status.dataset.kind = "pending"; }
      toast("Đã ghi nhận thanh toán", `Yêu cầu ${state.paymentMonths} tháng VIP · ${money(paymentAmount())} đã vào hàng chờ duyệt.`, "success", 7200);
      regenerateOrderCode(); renderVipPage();
      await loadPaymentHistory();
    } catch (error) {
      console.error(error);
      if (proofPath) client().storage.from("payment-proofs").remove([proofPath]).catch(() => {});
      const msg = String(error?.message || error);
      if (status) { status.textContent = "Cần kiểm tra"; status.dataset.kind = "error"; }
      let friendly = msg;
      if (msg.includes("TOO_MANY_PENDING")) friendly = "Bạn đang có quá nhiều yêu cầu chờ duyệt.";
      else if (msg.includes("ORDER_ALREADY_EXISTS")) friendly = "Mã đơn này đã được gửi trước đó. Hãy kiểm tra lịch sử thanh toán hoặc tạo lại mã đơn.";
      else if (msg.includes("TRANSACTION_CODE_ALREADY_USED")) friendly = "Mã giao dịch này đã được dùng cho một yêu cầu trước đó. Hãy kiểm tra lại mã ngân hàng.";
      toast("Không gửi được yêu cầu", friendly, "error", 8500);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Gửi yêu cầu xác nhận"; }
    }
  }

  function statusLabel(v) { return ({ pending: "Chờ duyệt", approved: "Đã duyệt", rejected: "Từ chối", cancelled: "Đã hủy" })[v] || v; }
  async function loadPaymentHistory({ silent = false } = {}) {
    if (!client() || !state.user) return [];
    const wrap = $("paymentHistory"); if (!wrap) return [];
    if (!silent) wrap.innerHTML = '<div class="skeleton-line"></div>';
    let result = await client().from("payment_requests").select("id,amount,months,status,reference,transaction_code,admin_note,created_at,reviewed_at").eq("user_id", state.user.id).order("created_at", { ascending: false }).limit(20);
    if (result.error && /transaction_code/i.test(String(result.error.message || result.error))) {
      result = await client().from("payment_requests").select("id,amount,months,status,reference,admin_note,created_at,reviewed_at").eq("user_id", state.user.id).order("created_at", { ascending: false }).limit(20);
    }
    const { data, error } = result;
    if (error) { if (!silent) wrap.innerHTML = '<p class="muted">Không tải được lịch sử thanh toán.</p>'; return []; }
    const rows = data || [];
    const nextPending = new Set(rows.filter(r => r.status === "pending").map(r => r.id));
    const hadPending = state.pendingPaymentIds.size > 0;
    if (hadPending && nextPending.size < state.pendingPaymentIds.size) {
      await refreshAccount({ silent: true });
      if (state.account?.is_vip) toast("VIP đã được kích hoạt", `Tài khoản hiện có quyền VIP${state.account.vip_until ? ` đến ${dateTime(state.account.vip_until)}` : ""}.`, "success", 9000);
    }
    state.pendingPaymentIds = nextPending;
    if (!rows.length) { wrap.innerHTML = '<div class="payment-empty-state"><span>₫</span><strong>Chưa có yêu cầu nâng cấp</strong><p>Yêu cầu của bạn sẽ xuất hiện ở đây sau khi gửi xác nhận thanh toán.</p></div>'; return rows; }
    wrap.innerHTML = rows.map(row => `
      <article class="payment-history-row enhanced-payment-history">
        <div><strong>${money(row.amount)}</strong><span>${Number(row.months || 1)} tháng · ${new Date(row.created_at).toLocaleDateString("vi-VN")}</span><small>${escapeHtml(row.reference || "")}${row.transaction_code ? ` · GD: ${escapeHtml(row.transaction_code)}` : ""}</small></div>
        <span class="request-status ${row.status}">${statusLabel(row.status)}</span>
        ${row.admin_note ? `<p>${escapeHtml(row.admin_note)}</p>` : ""}
      </article>`).join("");
    return rows;
  }

  function startPaymentPolling() {
    stopPaymentPolling();
    state.paymentPollTimer = window.setInterval(() => {
      if (!$("vipPage")?.classList.contains("hidden")) loadPaymentHistory({ silent: true }).catch(() => {});
    }, 20000);
  }
  function stopPaymentPolling() { if (state.paymentPollTimer) clearInterval(state.paymentPollTimer); state.paymentPollTimer = 0; }

  $("vipDurationSelector")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-months]"); if (!btn) return;
    state.paymentMonths = Math.max(1, Math.min(12, Number(btn.dataset.months) || 1));
    renderPaymentPlan();
  });
  $("vipPaymentForm")?.addEventListener("submit", submitPayment);
  $("suspendedLogout")?.addEventListener("click", () => $("logoutButton")?.click());
  $("copyPaymentContent")?.addEventListener("click", () => copyText(state.paymentOrderCode, "Đã sao chép nội dung"));
  $("copyPaymentAccount")?.addEventListener("click", () => copyText((state.settings || fallbackSettings()).account_number, "Đã sao chép số tài khoản"));
  $("copyPaymentAmount")?.addEventListener("click", () => copyText(String(paymentAmount()), "Đã sao chép số tiền"));
  $("sharePaymentDetails")?.addEventListener("click", async () => {
    const text = paymentDetailsText();
    try {
      if (navigator.share) await navigator.share({ title: "NTS VIP - Thông tin thanh toán", text });
      else await copyText(text, "Đã sao chép thông tin thanh toán");
    } catch (error) { if (error?.name !== "AbortError") await copyText(text, "Thông tin thanh toán"); }
  });
  $("markTransferredButton")?.addEventListener("click", () => {
    $("vipPaymentForm")?.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => $("paymentTransactionCode")?.focus(), 450);
    toast("Bước cuối", "Nhập mã giao dịch nếu có, đính kèm minh chứng và gửi yêu cầu xác nhận.", "info", 5200);
  });
  $("refreshPaymentHistory")?.addEventListener("click", async () => { await loadPaymentHistory(); await refreshAccount({ silent: true }); toast("Đã kiểm tra", "Trạng thái thanh toán và quyền VIP đã được làm mới.", "success", 2600); });

  window.addEventListener("nts:auth-user", async event => {
    state.user = event.detail.user || null;
    if (!state.user) { state.account = null; state.paymentOrderCode = ""; stopPaymentPolling(); return; }
    state.paymentOrderCode = "";
    await loadSettings(); regenerateOrderCode(); renderVipPage(); await refreshAccount();
  });
  window.addEventListener("beforeunload", stopPaymentPolling);

  NTS.membership = { state, refreshAccount, beginExport, finishExport, cancelExport, openPage, loadSettings, loadPaymentHistory, money, dateTime };
  if (NTS.currentUser) {
    state.user = NTS.currentUser;
    loadSettings().then(() => { regenerateOrderCode(); renderVipPage(); return refreshAccount(); });
  } else { state.settings = fallbackSettings(); renderVipPage(); }
})();
