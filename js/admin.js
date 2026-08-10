(() => {
  "use strict";
  // V3.2: responsive member management + smart payment review + premium service settings.
  const $ = id => document.getElementById(id);
  const NTS = window.NTS = window.NTS || {};
  const cfg = window.APP_CONFIG || {};
  const state = { members: [], payments: [], stats: null, loading: false, modalProfile: null };
  const client = () => NTS.supabase;
  const toast = (t, m, k = "info", d) => NTS.showToast?.(t, m, k, d);
  const money = v => NTS.membership?.money?.(v) || `${Number(v || 0).toLocaleString("vi-VN")} ₫`;
  const dt = v => NTS.membership?.dateTime?.(v) || "—";
  const esc = v => String(v ?? "").replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]);

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function transientReadError(error) {
    const message = String(error?.message || error || "").toLowerCase();
    const status = Number(error?.status || error?.statusCode || error?.context?.status || 0);
    return error instanceof TypeError
      || /failed to fetch|networkerror|network error|load failed|fetch failed|timeout|timed out|connection reset|connection closed|gateway/.test(message)
      || [408, 429, 502, 503, 504, 520, 522, 524].includes(status);
  }

  async function adminRead(label, operation, attempts = 2) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const pending = operation();
        const result = NTS.health?.withTimeout
          ? await NTS.health.withTimeout(pending, 12000, label)
          : await pending;
        if (result?.error) throw result.error;
        return result;
      } catch (error) {
        lastError = error;
        if (!transientReadError(error) || attempt >= attempts - 1) throw error;
        const delay = Math.round(220 * (2 ** attempt) + Math.random() * 120);
        console.warn(`Admin read retry: ${label} (${attempt + 1}/${attempts})`, error);
        await sleep(delay);
      }
    }
    throw lastError || new Error(`Không tải được ${label}`);
  }

  function renderStats() {
    const s = state.stats || {};
    [["statTotalUsers", s.total_users], ["statVipUsers", s.vip_users], ["statFreeUsers", s.free_users], ["statPendingPayments", s.pending_payments]].forEach(([id, v]) => { if ($(id)) $(id).textContent = Number(v || 0).toLocaleString("vi-VN"); });
    if ($("statRevenue")) $("statRevenue").textContent = money(s.approved_revenue_month || 0);
    if ($("statSuspended")) $("statSuspended").textContent = Number(s.suspended_users || 0).toLocaleString("vi-VN");
  }

  async function renderSystemHealth({ force = false } = {}) {
    const root = $("adminSystemHealth");
    if (!root) return;
    const health = await NTS.health?.run?.({ force });
    const lastError = NTS.health?.state?.lastError;
    const items = [
      ["core_ready", "Tài khoản & quota"],
      ["community_ready", "Cộng đồng & chat"],
      ["payment_ready", "Thanh toán"],
      ["avatar_ready", "Avatar đồng bộ"],
      ["admin_ready", "Quản trị"]
    ];
    if (!health) {
      const info = lastError ? NTS.health?.friendly?.(lastError, "tình trạng hệ thống") : null;
      root.innerHTML = `<div class="v316-health-summary degraded"><strong>Chưa xác minh được database</strong><span>${esc(info?.message || "Hãy chạy migration repair V3.16 nếu database chưa đồng bộ.")}</span></div>`;
      if ($("adminSystemHealthVersion")) $("adminSystemHealthVersion").textContent = "Chưa xác minh";
      return;
    }
    const okCount = items.filter(([key]) => health[key] === true).length;
    root.innerHTML = items.map(([key,label]) => `<div class="v316-health-item ${health[key] ? "ok" : "bad"}"><span>${health[key] ? "✓" : "!"}</span><div><strong>${esc(label)}</strong><small>${health[key] ? "Sẵn sàng" : "Thiếu/lệch schema"}</small></div></div>`).join("");
    if ($("adminSystemHealthVersion")) $("adminSystemHealthVersion").textContent = `${okCount}/${items.length} module · DB ${esc(health.version || "?")}`;
  }

  function renderAdminSectionError(section, error) {
    const msg = esc(error?.message || String(error || "Lỗi kết nối"));
    if (section === "members") {
      if ($("adminMembersBody")) $("adminMembersBody").innerHTML = `<tr><td colspan="8" class="table-empty">Không tải được hội viên. Bấm “Làm mới” để thử lại.<br><small>${msg}</small></td></tr>`;
      if ($("adminMembersMobile")) $("adminMembersMobile").innerHTML = `<div class="empty-admin-card">Không tải được hội viên.<br><small>${msg}</small></div>`;
    }
    if (section === "payments" && $("adminPaymentsList")) $("adminPaymentsList").innerHTML = `<div class="empty-admin-card">Không tải được thanh toán. Bấm “Làm mới” để thử lại.<br><small>${msg}</small></div>`;
  }

  async function loadDashboardBundle() {
    const search = $("adminMemberSearch")?.value?.trim() || null;
    const filter = $("adminPaymentFilter")?.value || "pending";
    try {
      const { data } = await adminRead("Admin Dashboard", () => client().rpc("admin_dashboard_v316", { p_search: search, p_payment_status: filter }), 2);
      const bundle = typeof data === "string" ? JSON.parse(data) : data;
      if (!bundle || typeof bundle !== "object") throw new Error("ADMIN_DASHBOARD_INVALID_RESPONSE");
      state.stats = bundle.stats || {};
      state.members = Array.isArray(bundle.members) ? bundle.members : [];
      state.payments = Array.isArray(bundle.payments) ? bundle.payments : [];
      renderStats();
      renderMembers();
      await renderPayments();
      applyServiceSettings(bundle.settings || {});
      return true;
    } catch (error) {
      const message = String(error?.message || error || "");
      if (/admin_dashboard_v316|function|schema cache|does not exist|PGRST202/i.test(message)) return false;
      console.warn("Bundled Admin Dashboard unavailable; falling back to granular reads", error);
      return false;
    }
  }

  async function refresh() {
    if (NTS.membership?.state?.account?.role !== "admin" || state.loading) return;
    state.loading = true;
    void renderSystemHealth({ force: true });
    try {
      const bundled = await loadDashboardBundle();
      if (bundled) return;

      const failures = [];
      const tasks = [
        ["stats", loadStats],
        ["members", loadMembers],
        ["payments", loadPayments],
        ["settings", loadServiceSettings]
      ].map(async ([name, fn]) => {
        try { await fn(); }
        catch (error) {
          failures.push({ name, error });
          if ((name === "members" && !state.members.length) || (name === "payments" && !state.payments.length)) renderAdminSectionError(name, error);
        }
      });
      await Promise.all(tasks);
      if (failures.length) {
        const labels = failures.map(x => x.name).join(", ");
        const first = failures[0].error;
        toast("Admin Dashboard tải chưa đầy đủ", `${labels}: ${first?.message || first}. Hệ thống đã tự thử lại nhiều lần; bấm “Làm mới” để thử tiếp.`, "warning", 8000);
      }
    } catch (error) {
      console.error(error);
      toast("Không tải được Admin Dashboard", error.message || String(error), "error", 7000);
    } finally { state.loading = false; }
  }

  async function loadStats() {
    const { data } = await adminRead("thống kê", () => client().rpc("admin_stats"));
    state.stats = Array.isArray(data) ? data[0] : data;
    renderStats();
  }

  async function loadMembers() {
    const search = $("adminMemberSearch")?.value?.trim() || null;
    const { data } = await adminRead("danh sách hội viên", () => client().rpc("admin_list_members", { p_search: search }));
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
    const names = ["admin_list_payments_v35", "admin_list_payments_v32", "admin_list_payments"];
    let lastError = null;
    for (const name of names) {
      try {
        const result = await adminRead(`thanh toán:${name}`, () => client().rpc(name, { p_status: filter }));
        state.payments = result.data || [];
        await renderPayments();
        return;
      } catch (error) {
        lastError = error;
        const message = String(error?.message || error || "");
        if (!/function|schema cache|does not exist|PGRST202|admin_list_payments/i.test(message)) throw error;
      }
    }
    throw lastError || new Error("Không tải được danh sách thanh toán.");
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
      const months = Math.max(1, Number(p.months || 1));
      const statusLabel = p.status === "pending" ? "Chờ duyệt" : p.status === "approved" ? "Đã duyệt" : p.status === "rejected" ? "Từ chối" : "Đã hủy";
      cards.push(`<article class="admin-payment-card premium-payment-card">
        <div class="admin-payment-head"><div><strong>${esc(p.display_name)}</strong><span>${esc(p.email)}</span></div><span class="request-status ${p.status}">${statusLabel}</span></div>
        <div class="payment-review-summary"><div><span>Gói mua</span><strong>${months} tháng VIP</strong></div><div><span>Số tiền yêu cầu</span><strong>${money(p.amount)}</strong></div><div><span>Đã nhận</span><strong>${money(p.paid_amount || 0)}</strong></div><div><span>Kênh</span><strong>${p.payment_provider === "payos" ? `payOS · ${esc(p.provider_state || "pending")}` : "Thủ công"}</strong></div><div><span>Mã đơn</span><strong>${esc(p.provider_order_code || p.reference || "—")}</strong></div><div><span>Mã giao dịch</span><strong>${esc(p.transaction_code || "—")}</strong></div><div><span>Ngày gửi</span><strong>${dt(p.created_at)}</strong></div></div>
        ${p.note ? `<p class="admin-note">${esc(p.note)}</p>` : ""}
        <div class="payment-proof-row">${url ? `<a class="proof-link" href="${url}" target="_blank" rel="noopener">Xem minh chứng thanh toán ↗</a>` : '<span class="muted">Không có minh chứng</span>'}</div>
        ${p.status === "pending" ? `<div class="admin-payment-actions"><button class="primary-button compact" data-payment-approve="${p.payment_id}" type="button">✓ Duyệt +${months} tháng VIP</button><button class="danger-soft-button compact" data-payment-reject="${p.payment_id}" type="button">Từ chối</button></div>` : `${p.admin_note ? `<small class="admin-review-note">Admin: ${esc(p.admin_note)}</small>` : ""}`}
      </article>`);
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
    const typed = NTS.dialog?.prompt
      ? await NTS.dialog.prompt({ title: "Xóa hội viên?", message: `Hành động này xóa tài khoản Auth và dữ liệu liên quan. Nhập chính xác email ${email} để xác nhận.`, confirmText: "Xóa vĩnh viễn", inputPlaceholder: email, danger: true })
      : window.prompt(`Nhập chính xác email để xóa: ${email}`, "");
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
    const payment = state.payments.find(p => p.payment_id === id);
    const months = Math.max(1, Number(payment?.months || 1));
    const approved = action === "approve";
    const ok = NTS.dialog?.confirm
      ? await NTS.dialog.confirm({ title: approved ? "Duyệt thanh toán VIP?" : "Từ chối thanh toán?", message: approved ? `Xác nhận ${money(payment?.amount)} và cộng ${months} tháng VIP cho ${payment?.email || "hội viên"}.` : `Yêu cầu của ${payment?.email || "hội viên"} sẽ bị từ chối.`, confirmText: approved ? `Duyệt +${months} tháng` : "Từ chối", danger: !approved })
      : window.confirm(approved ? `Duyệt và cộng ${months} tháng VIP?` : "Từ chối yêu cầu này?");
    if (!ok) return;
    let note = "";
    if (!approved) {
      note = NTS.dialog?.prompt ? await NTS.dialog.prompt({ title: "Lý do từ chối", message: "Ghi lý do để hội viên biết cần bổ sung gì. Có thể để trống.", confirmText: "Xác nhận từ chối", inputPlaceholder: "Ví dụ: Chưa thấy giao dịch...", danger: true }) : window.prompt("Lý do từ chối (có thể để trống):", "");
      if (note === null) return;
    }
    try {
      const { error } = await client().rpc("admin_review_payment", { p_request_id: id, p_action: action, p_admin_note: note || null });
      if (error) throw error;
      toast(approved ? "VIP đã được kích hoạt" : "Đã từ chối yêu cầu", approved ? `Hội viên được cộng chính xác ${months} tháng VIP.` : "Trạng thái và ghi chú đã được cập nhật.", approved ? "success" : "warning", 6200);
      await refresh();
    } catch (error) { toast("Không xử lý được thanh toán", error.message || String(error), "error", 8000); }
  }

  function updateServicePreview({ dirty = true } = {}) {
    const free = Number($("adminFreeLimit")?.value || 0);
    const price = Number($("adminVipPrice")?.value || 0);
    const bank = $("adminBankName")?.value?.trim() || "Chưa cấu hình";
    const account = $("adminAccountNumber")?.value?.trim() || "—";
    if ($("adminFreePreview")) $("adminFreePreview").textContent = `${Math.max(0, free).toLocaleString("vi-VN")} ảnh/tháng`;
    if ($("adminVipPreview")) $("adminVipPreview").textContent = `${money(Math.max(0, price))}/tháng`;
    if ($("adminBankPreview")) $("adminBankPreview").textContent = bank;
    if ($("adminAccountPreview")) $("adminAccountPreview").textContent = account;
    const badge = $("adminSettingsDirty");
    if (badge) { badge.textContent = dirty ? "Có thay đổi chưa lưu" : "Đã đồng bộ"; badge.classList.toggle("dirty", dirty); }
  }

  function fallbackPaymentQr() { return cfg.MEMBERSHIP?.paymentQrUrl || "assets/payment/payment-qr.png"; }
  function renderAdminQr(url) {
    const custom = Boolean(url);
    if ($("adminQrPreview")) $("adminQrPreview").src = url || fallbackPaymentQr();
    if ($("adminQrSource")) $("adminQrSource").textContent = custom ? "QR đang lưu trên Supabase" : "QR mặc định trong package";
    if ($("adminQrStatus")) $("adminQrStatus").textContent = custom ? "Thay đổi có hiệu lực ngay trên trang VIP. Upload lại PNG nếu muốn cập nhật QR." : "Khuyên dùng PNG vuông, rõ nét, tối đa 5 MB.";
  }

  async function uploadAdminQr(file) {
    if (!file) return;
    if (file.type !== "image/png") return toast("QR phải là PNG", "Hãy chọn file PNG để giữ QR sắc nét và ổn định trên mọi thiết bị.", "warning", 6000);
    if (file.size > 5 * 1024 * 1024) return toast("QR quá lớn", "File QR tối đa 5 MB.", "warning");
    const status = $("adminQrStatus");
    if (status) status.textContent = "Đang tải QR lên Supabase...";
    try {
      const path = "payment/payment-qr.png";
      const { error: uploadError } = await client().storage.from("site-assets").upload(path, file, { upsert: true, cacheControl: "0", contentType: "image/png" });
      if (uploadError) throw uploadError;
      const { data } = client().storage.from("site-assets").getPublicUrl(path);
      if (!data?.publicUrl) throw new Error("Không tạo được URL QR sau khi upload.");
      const url = `${data.publicUrl}${data.publicUrl.includes("?") ? "&" : "?"}v=${Date.now()}`;
      const { error: updateError } = await client().from("site_settings").update({ payment_qr_url: url }).eq("id", true);
      if (updateError) throw updateError;
      renderAdminQr(url);
      await NTS.membership?.loadSettings?.();
      toast("QR thanh toán đã cập nhật", "Trang VIP đã chuyển sang QR mới mà không cần deploy GitHub.", "success", 6200);
    } catch (error) {
      console.error(error);
      const msg = String(error?.message || error);
      if (/site-assets|row-level security|policy|column.*payment_qr_url|schema cache/i.test(msg)) {
        toast("Schema thanh toán chưa sẵn sàng", "Hãy chạy một lần `supabase/017_v3_16_full_system_repair.sql` trong Supabase SQL Editor rồi thử lại.", "error", 9000);
      } else toast("Không cập nhật được QR", msg, "error", 8000);
    } finally { if ($("adminQrInput")) $("adminQrInput").value = ""; }
  }

  async function resetAdminQr() {
    const ok = NTS.dialog?.confirm ? await NTS.dialog.confirm({ title: "Dùng lại QR mặc định?", message: "QR Supabase hiện tại sẽ được bỏ khỏi cấu hình. Trang VIP quay về assets/payment/payment-qr.png trong website.", confirmText: "Dùng QR mặc định" }) : window.confirm("Dùng lại QR mặc định?");
    if (!ok) return;
    try {
      const { error } = await client().from("site_settings").update({ payment_qr_url: null }).eq("id", true);
      if (error) throw error;
      try { await client().storage.from("site-assets").remove(["payment/payment-qr.png"]); } catch (_) {}
      renderAdminQr(null);
      await NTS.membership?.loadSettings?.();
      toast("Đã dùng QR mặc định", "Trang VIP đã quay về QR PNG nằm trong package website.", "success");
    } catch (error) { toast("Không reset được QR", error.message || String(error), "error", 8000); }
  }

  function applyServiceSettings(data = {}) {
    if ($("adminFreeLimit")) $("adminFreeLimit").value = data.free_monthly_limit ?? 10;
    if ($("adminVipPrice")) $("adminVipPrice").value = data.vip_monthly_price ?? 200000;
    if ($("adminBankName")) $("adminBankName").value = data.bank_name || "";
    if ($("adminAccountName")) $("adminAccountName").value = data.account_name || "";
    if ($("adminAccountNumber")) $("adminAccountNumber").value = data.account_number || "";
    if ($("adminTransferPrefix")) $("adminTransferPrefix").value = data.transfer_prefix || "";
    if ($("adminSupportText")) $("adminSupportText").value = data.support_text || "";
    renderAdminQr(data.payment_qr_url || null);
    updateServicePreview({ dirty: false });
  }

  async function loadServiceSettings() {
    const { data } = await adminRead("cấu hình dịch vụ", () => client().from("site_settings").select("*").eq("id", true).single());
    applyServiceSettings(data || {});
  }

  async function saveServiceSettings(event) {
    event.preventDefault(); const btn = $("saveAdminSettings"); btn.disabled = true; btn.textContent = "Đang lưu...";
    try {
      const payload = { free_monthly_limit: Number($("adminFreeLimit").value), vip_monthly_price: Number($("adminVipPrice").value), bank_name: $("adminBankName").value.trim(), account_name: $("adminAccountName").value.trim(), account_number: $("adminAccountNumber").value.trim(), transfer_prefix: $("adminTransferPrefix").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16) || "NTSVIP", support_text: $("adminSupportText").value.trim() };
      if (!Number.isInteger(payload.free_monthly_limit) || payload.free_monthly_limit < 0 || payload.free_monthly_limit > 100000) throw new Error("Quota Free không hợp lệ.");
      if (!Number.isInteger(payload.vip_monthly_price) || payload.vip_monthly_price < 0) throw new Error("Giá VIP không hợp lệ.");
      if (!payload.bank_name || !payload.account_name || !payload.account_number) throw new Error("Hãy điền đủ ngân hàng, tên chủ tài khoản và số tài khoản.");
      const { error } = await client().from("site_settings").update(payload).eq("id", true); if (error) throw error;
      updateServicePreview({ dirty: false });
      toast("Cấu hình dịch vụ đã lưu", "Giá, quota và thông tin thanh toán đã đồng bộ sang trang VIP.", "success", 5600);
      await NTS.membership?.loadSettings?.(); await NTS.membership?.refreshAccount?.({ silent: true });
    } catch (error) { toast("Không lưu được cấu hình", error.message || String(error), "error", 8000); }
    finally { btn.disabled = false; btn.textContent = "Lưu thay đổi"; }
  }

  async function resetMemberUsage() {
    const uid = $("memberModalUserId").value; if (!uid) return;
    const ok = NTS.dialog?.confirm ? await NTS.dialog.confirm({ title: "Reset quota tháng?", message: "Toàn bộ lượt Free đã dùng của hội viên trong tháng hiện tại sẽ về 0.", confirmText: "Reset quota" }) : window.confirm("Reset toàn bộ lượt Free đã dùng của hội viên trong tháng này?");
    if (!ok) return;
    const btn = $("resetMemberUsageButton"); btn.disabled = true;
    try { const { error } = await client().rpc("admin_reset_usage", { p_user_id: uid }); if (error) throw error; toast("Đã reset quota", "Lượt đã dùng tháng này đã về 0.", "success"); await refresh(); }
    catch (error) { toast("Không reset được quota", error.message || String(error), "error"); }
    finally { btn.disabled = false; }
  }

  let searchTimer = 0;
  $("adminMemberSearch")?.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadMembers, 320); });
  $("adminPaymentFilter")?.addEventListener("change", loadPayments);
  $("refreshAdminButton")?.addEventListener("click", refresh);
  $("refreshSystemHealth")?.addEventListener("click", () => renderSystemHealth({ force: true }));
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
  $("adminSettingsForm")?.addEventListener("input", () => updateServicePreview({ dirty: true }));
  $("adminQrInput")?.addEventListener("change", e => uploadAdminQr(e.target.files?.[0]));
  $("resetAdminQr")?.addEventListener("click", resetAdminQr);

  let membershipRefreshTimer = 0;
  window.addEventListener("nts:membership-updated", e => {
    if (e.detail.account?.role !== "admin" || $("adminPage")?.classList.contains("hidden")) return;
    clearTimeout(membershipRefreshTimer);
    membershipRefreshTimer = setTimeout(() => refresh(), 450);
  });
  NTS.admin = { state, refresh, loadMembers, loadPayments, loadServiceSettings, openCreateMemberModal, renderSystemHealth };
})();
