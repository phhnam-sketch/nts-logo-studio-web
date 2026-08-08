(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const cfg = window.APP_CONFIG || {};
  let timer = 0;

  function showToast(title, message, kind = "info", duration = 4800) {
    const el = $("globalToast");
    $("toastTitle").textContent = title;
    $("toastMessage").textContent = message;
    $("toastIcon").textContent = kind === "success" ? "✓" : kind === "error" ? "!" : "i";
    el.className = `toast ${kind} show`;
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove("show"), duration);
  }
  $("toastClose").addEventListener("click", () => $("globalToast").classList.remove("show"));

  const configured = cfg.SUPABASE_URL && cfg.SUPABASE_PUBLISHABLE_KEY && !cfg.SUPABASE_URL.includes("YOUR_PROJECT_ID");
  if (!configured) {
    showToast("Chưa cấu hình Supabase", "Điền Project URL và Publishable Key trong js/config.js.", "error", 8000);
    $("resetSubmit").disabled = true;
    return;
  }

  const client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  $("resetForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const p1 = $("newPassword").value;
    const p2 = $("confirmPassword").value;
    if (p1.length < 8) {
      showToast("Mật khẩu quá ngắn", "Hãy dùng ít nhất 8 ký tự.", "error");
      return;
    }
    if (p1 !== p2) {
      showToast("Mật khẩu không khớp", "Hai lần nhập mật khẩu phải giống nhau.", "error");
      return;
    }

    const button = $("resetSubmit");
    button.disabled = true;
    button.textContent = "Đang cập nhật...";
    try {
      const { error } = await client.auth.updateUser({ password: p1 });
      if (error) throw error;
      showToast("Đổi mật khẩu thành công", "Bạn có thể quay lại và đăng nhập bằng mật khẩu mới.", "success", 6500);
      setTimeout(() => { window.location.href = "./"; }, 1800);
    } catch (error) {
      showToast("Không thể đổi mật khẩu", error?.message || "Đường dẫn có thể đã hết hạn. Hãy yêu cầu email mới.", "error", 7000);
      button.disabled = false;
      button.textContent = "Cập nhật mật khẩu";
    }
  });
})();
