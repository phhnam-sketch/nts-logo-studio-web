(() => {
  "use strict";

  const cfg = window.APP_CONFIG || {};
  const configured = Boolean(
    cfg.SUPABASE_URL && cfg.SUPABASE_PUBLISHABLE_KEY &&
    !cfg.SUPABASE_URL.includes("YOUR_PROJECT_ID") &&
    !cfg.SUPABASE_PUBLISHABLE_KEY.includes("YOUR_SUPABASE")
  );
  const $ = (id) => document.getElementById(id);
  const authView = $("authView"), appView = $("appView"), authForm = $("authForm");
  const loginTab = $("loginTab"), registerTab = $("registerTab"), nameField = $("nameField");
  const termsRow = $("termsRow"), terms = $("terms"), displayName = $("displayName");
  const email = $("email"), password = $("password"), authTitle = $("authTitle"), authSubtitle = $("authSubtitle");
  const authSubmit = $("authSubmit"), authSubmitText = $("authSubmitText"), authSpinner = $("authSpinner");
  const togglePassword = $("togglePassword"), passwordStrength = $("passwordStrength"), googleLogin = $("googleLogin");
  const forgotPassword = $("forgotPassword"), forgotModal = $("forgotModal"), forgotModalClose = $("forgotModalClose");
  const forgotForm = $("forgotForm"), forgotEmail = $("forgotEmail"), logoutButton = $("logoutButton");
  const userMenuButton = $("userMenuButton"), userMenu = $("userMenu");

  let mode = "login";
  let client = null;
  let toastTimer = null;

  function showToast(title, message, kind = "info", duration = 4300) {
    const toast = $("globalToast");
    if (!toast) return;
    $("toastTitle").textContent = title;
    $("toastMessage").textContent = message || "";
    $("toastIcon").textContent = kind === "success" ? "✓" : kind === "error" ? "!" : kind === "warning" ? "!" : "i";
    toast.className = `toast ${kind} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), duration);
  }

  window.NTS = window.NTS || {};
  Object.assign(window.NTS, {
    showToast,
    currentUser: null,
    supabase: null,
    configured,
    getClient: () => client
  });

  $("toastClose")?.addEventListener("click", () => $("globalToast")?.classList.remove("show"));

  function dispatchUser(user, event = "SIGNED_IN") {
    window.NTS.currentUser = user || null;
    window.dispatchEvent(new CustomEvent("nts:auth-user", { detail: { user: user || null, event } }));
  }

  function setMode(nextMode) {
    mode = nextMode;
    const registering = mode === "register";
    loginTab.classList.toggle("active", !registering);
    registerTab.classList.toggle("active", registering);
    loginTab.setAttribute("aria-selected", String(!registering));
    registerTab.setAttribute("aria-selected", String(registering));
    nameField.classList.toggle("hidden", !registering);
    termsRow.classList.toggle("hidden", !registering);
    passwordStrength.classList.toggle("hidden", !registering);
    passwordStrength.setAttribute("aria-hidden", String(!registering));
    password.autocomplete = registering ? "new-password" : "current-password";
    authTitle.textContent = registering ? "Tạo tài khoản mới" : "Chào mừng trở lại";
    authSubtitle.textContent = registering
      ? "Tạo tài khoản Free và nhận 10 lượt xuất ảnh mỗi tháng."
      : "Đăng nhập để tiếp tục vào Logo Studio.";
    authSubmitText.textContent = registering ? "Tạo tài khoản Free" : "Đăng nhập";
  }

  function setLoading(loading) {
    authSubmit.disabled = loading;
    authSpinner.classList.toggle("hidden", !loading);
  }

  function passwordScore(value) {
    let score = 0;
    if (value.length >= 8) score++;
    if (/[A-Z]/.test(value) && /[a-z]/.test(value)) score++;
    if (/\d/.test(value)) score++;
    if (/[^A-Za-z0-9]/.test(value) && value.length >= 10) score++;
    return score;
  }

  password?.addEventListener("input", () => { passwordStrength.dataset.score = String(passwordScore(password.value)); });
  loginTab?.addEventListener("click", () => setMode("login"));
  registerTab?.addEventListener("click", () => setMode("register"));
  togglePassword?.addEventListener("click", () => {
    const reveal = password.type === "password";
    password.type = reveal ? "text" : "password";
    togglePassword.textContent = reveal ? "Ẩn" : "Hiện";
  });

  function baseUserName(user) {
    return String(user?.user_metadata?.display_name || user?.user_metadata?.full_name || user?.user_metadata?.name || (user?.email || "Người dùng").split("@")[0]).trim() || "Người dùng";
  }

  function updateBaseUserUI(user) {
    if (!user) return;
    const name = baseUserName(user), mail = user.email || "";
    $("userDisplayName").textContent = name;
    $("menuDisplayName").textContent = name;
    $("userEmail").textContent = mail;
    $("menuEmail").textContent = mail;
    const avatarImg = $("userAvatarImage");
    const avatarFallback = $("userAvatarFallback");
    const metaAvatar = user.user_metadata?.avatar_url || user.user_metadata?.picture || "";
    if (avatarImg && metaAvatar) { avatarImg.src = metaAvatar; avatarImg.classList.remove("hidden"); avatarFallback?.classList.add("hidden"); }
    else { avatarImg?.classList.add("hidden"); if (avatarFallback) { avatarFallback.textContent = name.charAt(0).toUpperCase(); avatarFallback.classList.remove("hidden"); } }
  }

  function showAuthenticated(user, event = "SIGNED_IN") {
    updateBaseUserUI(user);
    authView.classList.add("hidden");
    appView.classList.remove("hidden");
    document.title = `${cfg.APP_NAME || "NTS Logo Studio Pro Web"} · Studio`;
    dispatchUser(user, event);
  }

  function showAnonymous(event = "SIGNED_OUT") {
    appView.classList.add("hidden");
    authView.classList.remove("hidden");
    userMenu?.classList.add("hidden");
    userMenuButton?.setAttribute("aria-expanded", "false");
    document.title = cfg.APP_NAME || "NTS Logo Studio Pro Web";
    dispatchUser(null, event);
  }

  function authErrorMessage(error) {
    const message = String(error?.message || error || "Không thể thực hiện yêu cầu.");
    const lower = message.toLowerCase();
    if (lower.includes("invalid login credentials")) return "Email hoặc mật khẩu không chính xác.";
    if (lower.includes("email not confirmed")) return "Email chưa được xác minh. Hãy kiểm tra hộp thư của bạn.";
    if (lower.includes("user already registered")) return "Email này đã có tài khoản.";
    if (lower.includes("password should be")) return "Mật khẩu chưa đáp ứng yêu cầu bảo mật.";
    if (lower.includes("rate limit")) return "Bạn thao tác quá nhanh. Hãy thử lại sau ít phút.";
    if (lower.includes("provider is not enabled")) return "Google Login chưa được bật trong Supabase. Hãy cấu hình Google Provider.";
    return message;
  }
  window.NTS.authErrorMessage = authErrorMessage;

  authForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!client) return showToast("Chưa cấu hình Supabase", "Điền Project URL + Publishable Key trong js/config.js.", "warning", 6500);
    const mail = email.value.trim(), pass = password.value;
    if (!mail || !pass) return showToast("Thiếu thông tin", "Vui lòng nhập email và mật khẩu.", "warning");
    if (mode === "register") {
      if (!displayName.value.trim()) return showToast("Thiếu tên hiển thị", "Hãy nhập tên hiển thị.", "warning");
      if (pass.length < 8) return showToast("Mật khẩu quá ngắn", "Mật khẩu tối thiểu 8 ký tự.", "warning");
      if (!terms.checked) return showToast("Chưa đồng ý điều khoản", "Bạn cần đồng ý điều khoản và chính sách bảo mật.", "warning");
    }
    setLoading(true);
    try {
      if (mode === "login") {
        const { data, error } = await client.auth.signInWithPassword({ email: mail, password: pass });
        if (error) throw error;
        showAuthenticated(data.user, "SIGNED_IN");
        showToast("Đăng nhập thành công", `Chào mừng ${baseUserName(data.user)}.`, "success");
      } else {
        const redirectTo = `${window.location.origin}${window.location.pathname}`;
        const { data, error } = await client.auth.signUp({
          email: mail,
          password: pass,
          options: { data: { display_name: displayName.value.trim() }, emailRedirectTo: redirectTo }
        });
        if (error) throw error;
        if (data.session) {
          showAuthenticated(data.user, "SIGNED_IN");
          showToast("Tạo tài khoản thành công", "Bạn đang ở gói Free.", "success");
        } else {
          setMode("login");
          showToast("Kiểm tra email", "Supabase đã gửi email xác minh. Xác minh xong rồi đăng nhập.", "success", 7500);
        }
      }
    } catch (error) { showToast("Không thể xác thực", authErrorMessage(error), "error", 6500); }
    finally { setLoading(false); }
  });

  googleLogin?.addEventListener("click", async () => {
    if (!client) return showToast("Chưa cấu hình Supabase", "Điền thông tin Supabase trong js/config.js trước.", "warning");
    googleLogin.disabled = true;
    try {
      const { error } = await client.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${window.location.origin}${window.location.pathname}` } });
      if (error) throw error;
    } catch (error) {
      googleLogin.disabled = false;
      showToast("Google Login chưa sẵn sàng", authErrorMessage(error), "error", 7000);
    }
  });

  function closeForgot() { forgotModal?.classList.add("hidden"); }
  forgotPassword?.addEventListener("click", () => { forgotEmail.value = email.value.trim(); forgotModal.classList.remove("hidden"); setTimeout(() => forgotEmail.focus(), 50); });
  forgotModalClose?.addEventListener("click", closeForgot);
  forgotModal?.addEventListener("click", (e) => { if (e.target === forgotModal) closeForgot(); });
  forgotForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!client) return;
    const mail = forgotEmail.value.trim(); if (!mail) return;
    const submit = $("forgotSubmit"); submit.disabled = true;
    try {
      const basePath = window.location.pathname.replace(/[^/]*$/, "");
      const { error } = await client.auth.resetPasswordForEmail(mail, { redirectTo: `${window.location.origin}${basePath}reset-password.html` });
      if (error) throw error;
      closeForgot(); showToast("Đã gửi email", "Hãy mở email và bấm đường dẫn đặt mật khẩu mới.", "success", 7000);
    } catch (error) { showToast("Không gửi được email", authErrorMessage(error), "error", 6500); }
    finally { submit.disabled = false; }
  });

  userMenuButton?.addEventListener("click", () => {
    const open = userMenu.classList.toggle("hidden") === false;
    userMenuButton.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".user-menu-wrap")) { userMenu?.classList.add("hidden"); userMenuButton?.setAttribute("aria-expanded", "false"); }
  });
  logoutButton?.addEventListener("click", async () => {
    if (!client) return;
    logoutButton.disabled = true;
    try { const { error } = await client.auth.signOut(); if (error) throw error; showAnonymous(); showToast("Đã đăng xuất", "Phiên đăng nhập đã kết thúc.", "success"); }
    catch (error) { showToast("Không thể đăng xuất", authErrorMessage(error), "error"); }
    finally { logoutButton.disabled = false; }
  });

  async function boot() {
    setMode("login");
    if (!configured) {
      showAnonymous("UNCONFIGURED"); googleLogin.disabled = true;
      setTimeout(() => showToast("Cần cấu hình Supabase", "Điền Project URL và Publishable Key trong js/config.js để bật đăng nhập thật.", "warning", 9000), 450);
      return;
    }
    try {
      client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      window.NTS.supabase = client;
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      if (data.session?.user) showAuthenticated(data.session.user, "INITIAL_SESSION"); else showAnonymous("INITIAL_SESSION");
      client.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_OUT" || !session?.user) showAnonymous(event);
        else if (["SIGNED_IN", "TOKEN_REFRESHED", "USER_UPDATED", "INITIAL_SESSION"].includes(event)) showAuthenticated(session.user, event);
      });
    } catch (error) { showAnonymous("ERROR"); showToast("Lỗi kết nối Supabase", authErrorMessage(error), "error", 8500); }
  }

  boot();
})();
