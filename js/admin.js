(() => {
  "use strict";
  // V3.1: responsive member management + safe CRUD via Supabase Edge Function.
  const $ = id => document.getElementById(id);
  const NTS = window.NTS = window.NTS || {};
  const state = { members: [], payments: [], stats: null, loading: false, modalProfile: null };
  const client = () => NTS.supabase;
  const toast = (t, m, k = "info", d) => NTS.showToast?.(t, m, k, d);
  const money = v => NTS.membership?.money?.(v) || `${Number(v || 0).toLocaleString("vi-VN")} ₫`;
  const dt = v => NTS.membership?.dateTime?.(v) || "—";
  const esc = v => String(v ?? "").replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]);

  async function refresh() {
    if (NTS.membership?.state?.account?.role !== "admin" || state.loading) return;
    state.loading = true;
    try { await Promise.all([loadStats(), loadMembers(), loadPayments(), loadServiceSettings()]); }
    catch (error) { console.error(error); toast("Không tải được Admin Dashboard", error.message || String(error), "error", 7000); }
    finally { state.loading = false; }
  }

  async function loadStats() {
    const { data, error } = await client().rpc("admin_stats"); if (error) throw error;
    state.stats = Array.isArray(data) ? data[0] : data;
    const s = state.stats || {};
    [["statTotalUsers", s.total_users], ["statVipUsers", s.vip_users], ["statFreeUsers", s.free_users], ["statPendingPayments", s.pending_payments]].forEach(([id, v]) => { if ($(id)) $(id).textContent = Number(v || 0).toLocaleString("vi-VN"); });
    if ($("statRevenue")) $("statRevenue").textContent = money(s.approved_revenue_month || 0);
    if ($("statSuspended")) $("statSuspended").textContent = Number(s.suspended_users || 0).toLocaleString("vi-VN");
  }

  async function loadMembers() {
    const search = $("adminMemberSearch")?.value?.trim() || null;
    const { data, error } = await client().rpc("admin_list_members", { p_search: search }); if (error) throw error;
    state.members = data || [];
    renderMembers();
  }

  function memberBadge(m) {
    const cls = m.role === "admin" ? "admin" : m.plan === "vip" ? "vip" : "free";
    const text = m.role === "admin" ? "ADMIN" : String(m.plan || "free").toUpperCase();
    return `<span class="plan-badge ${cls}">${text}</span>`;
  }

  function renderMembers() {
    const tbody = $("adminMembersBody");
    const mobile = $("adminMembersMobile");
    if (!state.members.length) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="table-empty">Không có hội viên phù hợp.</td></tr>';
      if (mobile) mobile.innerHTML = '<div class="empty-admin-card">Không có hội viên phù hợp.</div>';
      return;
    }
    if (tbody) tbody.innerHTML = state.members.map(m => `<tr data-user-id="${m.user_id}">
      <td><div class="member-cell"><strong>${esc(m.display_name)}</strong><small>${esc(m.email)}</small></div></td>
      <td>${memberBadge(m)}</td>
      <td><span class="account-status ${m.status}">${m.status === "active" ? "Hoạt động" : "Tạm khóa"}</span></td>
      <td>${m.month_used || 0}</td><td>${m.free_limit == null ? "Mặc định" : m.free_limit}</td>
      <td>${m.vip_until ? dt(m.vip_until) : "—"}</td><td>${dt(m.created_at)}</td>
      <td><button class="mini-button" data-admin-edit="${m.user_id}" type="button">Quản lý</button></td></tr>`).join("");
    if (mobile) mobile.innerHTML = state.members.map(m => `<article class="admin-member-card" data-user-id="${m.user_id}">
      <div class="admin-member-card-head"><div><strong>${esc(m.display_name)}</strong><span>${esc(m.email)}</span></div>${memberBadge(m)}</div>
      <div class="admin-member-card-grid"><span>Trạng thái<strong>${m.status === "active" ? "Hoạt động" : "Tạm khóa"}</strong></span><span>Đã dùng<strong>${m.month_used || 0}</strong></span><span>Quota<strong>${m.free_limit == null ? "Mặc định" : m.free_limit}</strong></span><span>VIP đến<strong>${m.vip_until ? dt(m.vip_until) : "—"}</strong></span></div>
      <button class="secondary-button compact full-width" data-admin-edit="${m.user_id}" type="button">Quản lý hội viên</button>
    </article>`).join("");
  }

  async function loadPayments() {
    const filter = $("adminPaymentFilter")?.value || "pending";
    const { data, error } = await client().rpc("admin_list_payments", { p_status: filter }); if (error) throw error;
    state.payments = data || []; await renderPayments();
  }
  async function proofUrl(path) {
    if (!path) return null;
    const { data, error } = await client().storage.from("payment-proofs").createSignedUrl(path, 600);
    if (error) return null; return data?.signedUrl || null;
  }
  async function renderPayments() {
    const wrap = $("adminPaymentsList"); if (!wrap) return;
    if (!state.payments.length) { wrap.innerHTML = '<div class="empty-admin-card">Không có yêu cầu thanh toán.</div>'; return; }
    const cards = [];
    for (const p of state.payments) {
      const url = await proofUrl(p.proof_path);
      cards.push(`<article class="admin-payment-card"><div class="admin-payment-head"><div><strong>${esc(p.display_name)}</strong><span>${esc(p.email)}</span></div><span class="request-status ${p.status}">${p.status === "pending" ? "Chờ duyệt" : p.status === "approved" ? "Đã duyệt" : "Từ chối"}</span></div><div class="admin-payment-grid"><span>Số tiền<strong>${money(p.amount)}</strong></span><span>Nội dung<strong>${esc(p.reference || "—")}</strong></span><span>Ngày gửi<strong>${dt(p.created_at)}</strong></span></div>${p.note ? `<p class="admin-note">${esc(p.note)}</p>` : ""}${url ? `<a class="proof-link" href="${url}" target="_blank" rel="noopener">Xem minh chứng thanh toán ↗</a>` : '<span class="muted">Không có minh chứng</span>'}${p.status === "pending" ? `<div class="admin-payment-actions"><button class="primary-button compact" data-payment-approve="${p.payment_id}" type="button">✓ Duyệt +1 tháng VIP</button><button class="danger-soft-button compact" data-payment-reject="${p.payment_id}" type="button">Từ chối</button></div>` : `${p.admin_note ? `<small>Admin: ${esc(p.admin_note)}</small>` : ""}`}</article>`);
    }
    wrap.innerHTML = cards.join("");
  }

  function localDateTime(value) {
    if (!value) return "";
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  function resetMemberModalUi(mode) {
    $("memberModalMode").value = mode;
    const creating = mode === "create";
    $("memberModalModeBadge").textContent = creating ? "CREATE MEMBER" : "MEMBER CONTROL";
    $("memberPasswordLabel").textContent = creating ? "Mật khẩu ban đầu" : "Mật khẩu mới";
    $("memberPasswordInput").required = creating;
    $("memberPasswordInput").placeholder = creating ? "Tối thiểu 8 ký tự" : "Để trống nếu không đổi · tối thiểu 8 ký tự";
    $("deleteMemberButton").classList.toggle("hidden", creating);
    $("resetMemberUsageButton").classList.toggle("hidden", creating);
  }

  async function openMemberModal(id) {
    const m = state.members.find(x => x.user_id === id); if (!m) return;
    resetMemberModalUi("edit");
    $("memberModalUserId").value = m.user_id;
    $("memberModalName").textContent = m.display_name;
    $("memberModalEmail").textContent = m.email;
    $("memberDisplayName").value = m.display_name || "";
    $("memberEmailInput").value = m.email || "";
    $("memberBioInput").value = "";
    $("memberPasswordInput").value = "";
    $("memberStatusSelect").value = m.status;
    $("memberPlanSelect").value = m.plan;
    $("memberFreeLimit").value = m.free_limit ?? "";
    $("memberVipUntil").value = localDateTime(m.vip_until);
    $("memberManageModal").classList.remove("hidden");
    try {
      const { data } = await client().from("profiles").select("bio").eq("id", m.user_id).single();
      if ($("memberModalUserId").value === m.user_id) $("memberBioInput").value = data?.bio || "";
    } catch (_) {}
  }

  function openCreateMemberModal() {
    resetMemberModalUi("create");
    $("memberModalUserId").value = "";
    $("memberModalName").textContent = "Thêm hội viên mới";
    $("memberModalEmail").textContent = "Tài khoản sẽ được xác nhận email sẵn để admin cấp trực tiếp.";
    $("memberDisplayName").value = "";
    $("memberEmailInput").value = "";
    $("memberBioInput").value = "";
    $("memberPasswordInput").value = "";
    $("memberStatusSelect").value = "active";
    $("memberPlanSelect").value = "free";
    $("memberFreeLimit").value = "";
    $("memberVipUntil").value = "";
    $("memberManageModal").classList.remove("hidden");
    setTimeout(() => $("memberDisplayName")?.focus(), 60);
  }
  function closeMemberModal() { $("memberManageModal")?.classList.add("hidden"); }

  async function invokeAdminUsers(body) {
    const { data, error } = await client().functions.invoke("admin-users", { body });
    if (error) {
      const message = error?.context?.body?.error || error.message || String(error);
      throw new Error(`${message}. Nếu Edge Function chưa được deploy, hãy làm theo ADMIN_USERS_EDGE_FUNCTION.md.`);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }

  function memberPayload() {
    const freeRaw = $("memberFreeLimit").value.trim();
    const password = $("memberPasswordInput").value;
    const payload = {
      user_id: $("memberModalUserId").value || null,
      email: $("memberEmailInput").value.trim().toLowerCase(),
      display_name: $("memberDisplayName").value.trim(),
      bio: $("memberBioInput").value.trim(),
      password: password || null,
      status: $("memberStatusSelect").value,
      plan: $("memberPlanSelect").value,
      vip_until: $("memberVipUntil").value ? new Date($("memberVipUntil").value).toISOString() : null,
      free_limit: freeRaw === "" ? null : Number(freeRaw),
      clear_free_limit: freeRaw === ""
    };
    if (!payload.display_name || payload.display_name.length > 60) throw new Error("Tên hiển thị phải từ 1 đến 60 ký tự.");
    if (!/^\S+@\S+\.\S+$/.test(payload.email)) throw new Error("Email không hợp lệ.");
    if (payload.bio.length > 500) throw new Error("Bio tối đa 500 ký tự.");
    if (password && password.length < 8) throw new Error("Mật khẩu phải có ít nhất 8 ký tự.");
    if (payload.free_limit != null && (!Number.isInteger(payload.free_limit) || payload.free_limit < 0 || payload.free_limit > 100000)) throw new Error("Quota riêng không hợp lệ.");
    return payload;
  }

  async function saveMember(event) {
    event.preventDefault();
    const mode = $("memberModalMode").value;
    const btn = $("saveMemberButton"); btn.disabled = true; btn.textContent = mode === "create" ? "Đang tạo..." : "Đang lưu...";
    try {
      const payload = memberPayload();
      if (mode === "create") {
        if (!payload.password) throw new Error("Tài khoản mới cần mật khẩu ban đầu tối thiểu 8 ký tự.");
        await invokeAdminUsers({ action: "create", ...payload });
        toast("Đã thêm hội viên", `${payload.email} đã được tạo thành công.`, "success");
      } else {
        // Membership + profile are still updated through RLS/RPC even when email/password stays unchanged.
        const original = state.members.find(m => m.user_id === payload.user_id);
        const emailChanged = original && original.email.toLowerCase() !== payload.email;
        if (emailChanged || payload.password) {
          await invokeAdminUsers({ action: "update-auth", user_id: payload.user_id, email: payload.email, password: payload.password, display_name: payload.display_name });
        }
        const { error: profileError } = await client().from("profiles").update({ display_name: payload.display_name, bio: payload.bio }).eq("id", payload.user_id);
        if (profileError) throw profileError;
        const { error: membershipError } = await client().rpc("admin_update_member", {
          p_user_id: payload.user_id, p_status: payload.status, p_plan: payload.plan,
          p_vip_until: payload.vip_until, p_free_limit: payload.free_limit, p_clear_free_limit: payload.clear_free_limit
        });
        if (membershipError) throw membershipError;
        toast("Đã cập nhật hội viên", "Thông tin, quyền truy cập và gói thành viên đã được lưu.", "success");
      }
      closeMemberModal();
      await refresh();
    } catch (error) {
      console.error(error);
      toast(mode === "create" ? "Không tạo được hội viên" : "Không cập nhật được", error.message || String(error), "error", 9000);
    } finally {
      btn.disabled = false; btn.textContent = "Lưu hội viên";
    }
  }

  async function deleteMember() {
    const uid = $("memberModalUserId").value;
    const email = $("memberEmailInput").value.trim();
    if (!uid) return;
    const typed = prompt(`Xóa tài khoản sẽ xóa Auth + hồ sơ + membership + dữ liệu liên quan.\n\nNhập chính xác email để xác nhận:\n${email}`, "");
    if (typed !== email) { if (typed !== null) toast("Đã hủy xóa", "Email xác nhận không khớp.", "warning"); return; }
    const btn = $("deleteMemberButton"); btn.disabled = true;
    try {
      await invokeAdminUsers({ action: "delete", user_id: uid });
      closeMemberModal();
      toast("Đã xóa hội viên", `${email} đã được xóa khỏi hệ thống.`, "success");
      await refresh();
    } catch (error) { toast("Không xóa được hội viên", error.message || String(error), "error", 9000); }
    finally { btn.disabled = false; }
  }

  async function reviewPayment(id, action) {
    const label = action === "approve" ? "DUYỆT thanh toán và cộng 1 tháng VIP" : "TỪ CHỐI yêu cầu này";
    if (!confirm(`Xác nhận ${label}?`)) return;
    let note = ""; if (action === "reject") note = prompt("Lý do từ chối (có thể để trống):", "") || "";
    try { const { error } = await client().rpc("admin_review_payment", { p_request_id: id, p_action: action, p_admin_note: note || null }); if (error) throw error; toast(action === "approve" ? "Đã kích hoạt VIP" : "Đã từ chối", action === "approve" ? "Hội viên đã được cộng thêm 1 tháng VIP." : "Yêu cầu đã được cập nhật.", action === "approve" ? "success" : "warning"); await refresh(); }
    catch (error) { toast("Không xử lý được thanh toán", error.message || String(error), "error", 7000); }
  }

  async function loadServiceSettings() {
    const { data, error } = await client().from("site_settings").select("*").eq("id", true).single(); if (error) throw error;
    if ($("adminFreeLimit")) $("adminFreeLimit").value = data.free_monthly_limit ?? 10;
    if ($("adminVipPrice")) $("adminVipPrice").value = data.vip_monthly_price ?? 200000;
    if ($("adminBankName")) $("adminBankName").value = data.bank_name || "";
    if ($("adminAccountName")) $("adminAccountName").value = data.account_name || "";
    if ($("adminAccountNumber")) $("adminAccountNumber").value = data.account_number || "";
    if ($("adminTransferPrefix")) $("adminTransferPrefix").value = data.transfer_prefix || "";
    if ($("adminSupportText")) $("adminSupportText").value = data.support_text || "";
  }

  async function saveServiceSettings(event) {
    event.preventDefault(); const btn = $("saveAdminSettings"); btn.disabled = true;
    try {
      const payload = { free_monthly_limit: Number($("adminFreeLimit").value), vip_monthly_price: Number($("adminVipPrice").value), bank_name: $("adminBankName").value.trim(), account_name: $("adminAccountName").value.trim(), account_number: $("adminAccountNumber").value.trim(), transfer_prefix: $("adminTransferPrefix").value.trim() || "NTSVIP", support_text: $("adminSupportText").value.trim() };
      if (!Number.isInteger(payload.free_monthly_limit) || payload.free_monthly_limit < 0) throw new Error("Quota Free không hợp lệ.");
      if (!Number.isInteger(payload.vip_monthly_price) || payload.vip_monthly_price < 0) throw new Error("Giá VIP không hợp lệ.");
      const { error } = await client().from("site_settings").update(payload).eq("id", true); if (error) throw error;
      toast("Đã lưu cấu hình", "Giá VIP, quota và thông tin chuyển khoản đã được cập nhật.", "success");
      await NTS.membership?.loadSettings?.(); await NTS.membership?.refreshAccount?.({ silent: true });
    } catch (error) { toast("Không lưu được cấu hình", error.message || String(error), "error", 7000); }
    finally { btn.disabled = false; }
  }

  async function resetMemberUsage() {
    const uid = $("memberModalUserId").value; if (!uid || !confirm("Reset toàn bộ lượt Free đã dùng của hội viên trong tháng này?")) return;
    const btn = $("resetMemberUsageButton"); btn.disabled = true;
    try { const { error } = await client().rpc("admin_reset_usage", { p_user_id: uid }); if (error) throw error; toast("Đã reset quota", "Lượt đã dùng tháng này đã về 0.", "success"); await refresh(); }
    catch (error) { toast("Không reset được quota", error.message || String(error), "error"); }
    finally { btn.disabled = false; }
  }

  let searchTimer = 0;
  $("adminMemberSearch")?.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadMembers, 320); });
  $("adminPaymentFilter")?.addEventListener("change", loadPayments);
  $("refreshAdminButton")?.addEventListener("click", refresh);
  $("createMemberButton")?.addEventListener("click", openCreateMemberModal);
  $("adminMembersBody")?.addEventListener("click", e => { const b = e.target.closest("[data-admin-edit]"); if (b) openMemberModal(b.dataset.adminEdit); });
  $("adminMembersMobile")?.addEventListener("click", e => { const b = e.target.closest("[data-admin-edit]"); if (b) openMemberModal(b.dataset.adminEdit); });
  $("adminPaymentsList")?.addEventListener("click", e => { const a = e.target.closest("[data-payment-approve]"); const r = e.target.closest("[data-payment-reject]"); if (a) reviewPayment(a.dataset.paymentApprove, "approve"); if (r) reviewPayment(r.dataset.paymentReject, "reject"); });
  $("memberManageClose")?.addEventListener("click", closeMemberModal);
  $("cancelMemberButton")?.addEventListener("click", closeMemberModal);
  $("memberManageModal")?.addEventListener("click", e => { if (e.target.id === "memberManageModal") closeMemberModal(); });
  $("memberManageForm")?.addEventListener("submit", saveMember);
  $("deleteMemberButton")?.addEventListener("click", deleteMember);
  $("resetMemberUsageButton")?.addEventListener("click", resetMemberUsage);
  $("adminSettingsForm")?.addEventListener("submit", saveServiceSettings);

  window.addEventListener("nts:membership-updated", e => { if (e.detail.account?.role === "admin" && !$("adminPage")?.classList.contains("hidden")) refresh(); });
  NTS.admin = { state, refresh, loadMembers, loadPayments, loadServiceSettings, openCreateMemberModal };
})();
