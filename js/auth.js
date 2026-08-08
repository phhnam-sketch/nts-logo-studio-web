(() => {
  "use strict";

  const cfg = window.APP_CONFIG || {};
  const configured = Boolean(
    cfg.SUPABASE_URL &&
    cfg.SUPABASE_PUBLISHABLE_KEY &&
    !cfg.SUPABASE_URL.includes("YOUR_PROJECT_ID") &&
    !cfg.SUPABASE_PUBLISHABLE_KEY.includes("YOUR_SUPABASE")
  );

  const $ = (id) => document.getElementById(id);
  const authView = $("authView");
  const appView = $("appView");
  const authForm = $("authForm");
  const loginTab = $("loginTab");
  const registerTab = $("registerTab");
  const nameField = $("nameField");
  const termsRow = $("termsRow");
  const terms = $("terms");
  const displayName = $("displayName");
  const email = $("email");
  const password = $("password");
  const authTitle = $("authTitle");
  const authSubtitle = $("authSubtitle");
  const authSubmit = $("authSubmit");
  const authSubmitText = $("authSubmitText");
  const authSpinner = $("authSpinner");
  const togglePassword = $("togglePassword");
  const passwordStrength = $("passwordStrength");
  const googleLogin = $("googleLogin");
  const forgotPassword = $("forgotPassword");
  const forgotModal = $("forgotModal");
  const forgotModalClose = $("forgotModalClose");
  const forgotForm = $("forgotForm");
  const forgotEmail = $("forgotEmail");
  const logoutButton = $("logoutButton");
  const userMenuButton = $("userMenuButton");
  const userMenu = $("userMenu");

  let mode = "login";
  let client = null;
  let toastTimer = null;

  function showToast(title, message, kind = "info", duration = 4300) {
    const toast = $("globalToast");
    $("toastTitle").textContent = title;
    $("toastMessage").textContent = message || "";
    $("toastIcon").textContent = kind === "success" ? "✓" : kind === "error" ? "!" : kind === "warning" ? "!" : "i";
    toast.className = `toast ${kind} show`;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), duration);
  }

  window.NTS = window.NTS || {};
  window.NTS.showToast = showToast;

  $("toastClose").addEventListener("click", () => $("globalToast").classList.remove("show"));

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
      ? "Tạo tài khoản để bắt đầu sử dụng Logo Studio trên web."
      : "Đăng nhập để tiếp tục vào Logo Studio.";
    authSubmitText.textContent = registering ? "Tạo tài khoản" : "Đăng nhập";
  }

  function setLoading(loading) {
    authSubmit.disabled = loading;
    authSpinner.classList.toggle("hidden", !loading);
  }

  function passwordScore(value) {
    let score = 0;
    if (value.length >= 8) score += 1;
    if (/[A-Z]/.test(value) && /[a-z]/.test(value)) score += 1;
    if (/\d/.test(value)) score += 1;
    if (/[^A-Za-z0-9]/.test(value) && value.length >= 10) score += 1;
    return score;
  }

  password.addEventListener("input", () => {
    passwordStrength.dataset.score = String(passwordScore(password.value));
  });

  loginTab.addEventListener("click", () => setMode("login"));
  registerTab.addEventListener("click", () => setMode("register"));

  togglePassword.addEventListener("click", () => {
    const revealing = password.type === "password";
    password.type = revealing ? "text" : "password";
    togglePassword.textContent = revealing ? "Ẩn" : "Hiện";
    togglePassword.setAttribute("aria-label", revealing ? "Ẩn mật khẩu" : "Hiện mật khẩu");
  });

  function updateUserUI(user) {
    if (!user) return;
    const metaName = user.user_metadata?.display_name || user.user_metadata?.full_name || "";
    const fallback = (user.email || "Người dùng").split("@")[0];
    const name = metaName.trim() || fallback;
    const mail = user.email || "";
    const initial = name.trim().charAt(0).toUpperCase() || "N";

    $("userDisplayName").textContent = name;
    $("menuDisplayName").textContent = name;
    $("userEmail").textContent = mail;
    $("menuEmail").textContent = mail;
    $("userAvatar").textContent = initial;
  }

  function showAuthenticated(user) {
    updateUserUI(user);
    authView.classList.add("hidden");
    appView.classList.remove("hidden");
    document.title = `${cfg.APP_NAME || "NTS Logo Studio Pro Web"} · Studio`;
  }

  function showAnonymous() {
    appView.classList.add("hidden");
    authView.classList.remove("hidden");
    userMenu.classList.add("hidden");
    userMenuButton.setAttribute("aria-expanded", "false");
    document.title = cfg.APP_NAME || "NTS Logo Studio Pro Web";
  }

  function authErrorMessage(error) {
    const message = String(error?.message || error || "Không thể thực hiện yêu cầu.");
    const lower = message.toLowerCase();
    if (lower.includes("invalid login credentials")) return "Email hoặc mật khẩu không chính xác.";
    if (lower.includes("email not confirmed")) return "Email chưa được xác minh. Hãy kiểm tra hộp thư của bạn.";
    if (lower.includes("user already registered")) return "Email này đã có tài khoản.";
    if (lower.includes("password should be")) return "Mật khẩu chưa đáp ứng yêu cầu bảo mật.";
    if (lower.includes("rate limit")) return "Bạn thao tác quá nhanh. Hãy thử lại sau ít phút.";
    return message;
  }

  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!client) {
      showToast("Chưa cấu hình Supabase", "Mở js/config.js và điền Project URL + Publishable Key trước.", "warning", 6500);
      return;
    }

    const mail = email.value.trim();
    const pass = password.value;
    if (!mail || !pass) {
      showToast("Thiếu thông tin", "Vui lòng nhập email và mật khẩu.", "warning");
      return;
    }

    if (mode === "register") {
      if (!displayName.value.trim()) {
        showToast("Thiếu tên hiển thị", "Hãy nhập tên bạn muốn hiển thị trong ứng dụng.", "warning");
        return;
      }
      if (pass.length < 8) {
        showToast("Mật khẩu quá ngắn", "Mật khẩu nên có tối thiểu 8 ký tự.", "warning");
        return;
      }
      if (!terms.checked) {
        showToast("Chưa đồng ý điều khoản", "Bạn cần đồng ý điều khoản để tạo tài khoản.", "warning");
        return;
      }
    }

    setLoading(true);
    try {
      if (mode === "login") {
        const { data, error } = await client.auth.signInWithPassword({ email: mail, password: pass });
        if (error) throw error;
        showAuthenticated(data.user);
        showToast("Đăng nhập thành công", `Chào mừng ${data.user?.user_metadata?.display_name || mail}.`, "success");
      } else {
        const redirectTo = `${window.location.origin}${window.location.pathname}`;
        const { data, error } = await client.auth.signUp({
          email: mail,
          password: pass,
          options: {
            data: { display_name: displayName.value.trim() },
            emailRedirectTo: redirectTo
          }
        });
        if (error) throw error;
        if (data.session) {
          showAuthenticated(data.user);
          showToast("Tạo tài khoản thành công", "Tài khoản đã sẵn sàng sử dụng.", "success");
        } else {
          setMode("login");
          showToast("Kiểm tra email", "Supabase đã gửi email xác minh. Xác minh xong rồi đăng nhập.", "success", 7500);
        }
      }
    } catch (error) {
      showToast("Không thể xác thực", authErrorMessage(error), "error", 6200);
    } finally {
      setLoading(false);
    }
  });

  googleLogin.addEventListener("click", async () => {
    if (!client) {
      showToast("Chưa cấu hình Supabase", "Điền thông tin Supabase trong js/config.js trước.", "warning");
      return;
    }
    try {
      const { error } = await client.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}${window.location.pathname}` }
      });
      if (error) throw error;
    } catch (error) {
      showToast("Google Login chưa sẵn sàng", authErrorMessage(error), "error", 6200);
    }
  });

  function openForgot() {
    forgotEmail.value = email.value.trim();
    forgotModal.classList.remove("hidden");
    window.setTimeout(() => forgotEmail.focus(), 60);
  }
  function closeForgot() { forgotModal.classList.add("hidden"); }

  forgotPassword.addEventListener("click", openForgot);
  forgotModalClose.addEventListener("click", closeForgot);
  forgotModal.addEventListener("click", (e) => { if (e.target === forgotModal) closeForgot(); });

  forgotForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!client) {
      showToast("Chưa cấu hình Supabase", "Điền thông tin Supabase trong js/config.js trước.", "warning");
      return;
    }
    const mail = forgotEmail.value.trim();
    if (!mail) return;
    const submit = $("forgotSubmit");
    submit.disabled = true;
    try {
      const basePath = window.location.pathname.replace(/[^/]*$/, "");
      const redirectTo = `${window.location.origin}${basePath}reset-password.html`;
      const { error } = await client.auth.resetPasswordForEmail(mail, { redirectTo });
      if (error) throw error;
      closeForgot();
      showToast("Đã gửi email", "Hãy mở email và bấm đường dẫn để đặt mật khẩu mới.", "success", 7200);
    } catch (error) {
      showToast("Không gửi được email", authErrorMessage(error), "error", 6200);
    } finally {
      submit.disabled = false;
    }
  });

  userMenuButton.addEventListener("click", () => {
    const open = userMenu.classList.toggle("hidden") === false;
    userMenuButton.setAttribute("aria-expanded", String(open));
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".user-menu-wrap")) {
      userMenu.classList.add("hidden");
      userMenuButton.setAttribute("aria-expanded", "false");
    }
  });

  logoutButton.addEventListener("click", async () => {
    if (!client) return;
    logoutButton.disabled = true;
    try {
      const { error } = await client.auth.signOut();
      if (error) throw error;
      showAnonymous();
      showToast("Đã đăng xuất", "Phiên đăng nhập trên thiết bị này đã kết thúc.", "success");
    } catch (error) {
      showToast("Không thể đăng xuất", authErrorMessage(error), "error");
    } finally {
      logoutButton.disabled = false;
    }
  });

  async function boot() {
    setMode("login");
    if (!configured) {
      showAnonymous();
      googleLogin.disabled = true;
      window.setTimeout(() => {
        showToast("Cần cấu hình Supabase", "Giao diện đã sẵn sàng. Hãy điền Project URL và Publishable Key trong js/config.js để bật đăng nhập thật.", "warning", 9000);
      }, 500);
      return;
    }

    try {
      client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      });
      window.NTS.supabase = client;

      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      if (data.session?.user) showAuthenticated(data.session.user);
      else showAnonymous();

      client.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_OUT" || !session?.user) showAnonymous();
        else if (["SIGNED_IN", "TOKEN_REFRESHED", "USER_UPDATED", "INITIAL_SESSION"].includes(event)) showAuthenticated(session.user);
      });
    } catch (error) {
      showAnonymous();
      showToast("Lỗi kết nối Supabase", authErrorMessage(error), "error", 8500);
    }
  }

  boot();
})();
