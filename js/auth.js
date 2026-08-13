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
  let lastAuthUserId = null;
  let lastAuthDispatchAt = 0;
  let pendingAuthDispatchTimer = 0;
  let pendingAuthDomReady = null;
  const toastTimers = new WeakMap();
  const recentToastSignatures = new Map();
  function applyLoginBranding() {
    const login = cfg.LOGIN || {};
    const panel = $("authBrandPanel");
    const media = $("loginHeroMedia");
    const figure = $("loginHeroFigure");

    const clamp01 = (value, fallback) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      return Math.max(0, Math.min(1, n));
    };
    const safeAsset = (value, fallback) => String(value || fallback).replace(/["\\]/g, "");

    const figureUrl = safeAsset(login.figureImageUrl || login.heroImageUrl, "assets/login/login-hero.png");
    const backgroundUrl = String(login.backgroundImageUrl || "").trim();

    if (panel) {
      panel.style.setProperty("--login-overlay-opacity", String(clamp01(login.overlayOpacity ?? 0.70, 0.70)));
      panel.style.setProperty("--login-figure-left", login.figureLeft || "-6%");
      panel.style.setProperty("--login-figure-bottom", login.figureBottom || "-2%");
      panel.style.setProperty("--login-figure-width", login.figureWidth || "114%");
      panel.style.setProperty("--login-figure-max-width", login.figureMaxWidth || "1260px");
      panel.style.setProperty("--login-figure-opacity", String(clamp01(login.figureOpacity ?? 1, 1)));
      panel.style.setProperty("--login-figure-scale", String(Number.isFinite(Number(login.figureScale)) ? Number(login.figureScale) : 1));
      panel.style.setProperty("--login-figure-mobile-width", login.figureMobileWidth || "84%");
      panel.style.setProperty("--login-figure-mobile-left", login.figureMobileLeft || "-1%");
      panel.style.setProperty("--login-figure-mobile-bottom", login.figureMobileBottom || "-2%");
    }
    if (media) {
      if (backgroundUrl) {
        media.style.backgroundImage = `url("${safeAsset(backgroundUrl, "")}")`;
        media.style.backgroundPosition = login.heroPosition || "center center";
        media.style.backgroundSize = login.heroSize || "cover";
        media.style.opacity = String(clamp01(login.heroOpacity ?? .22, .22));
      } else {
        media.style.backgroundImage = "none";
        media.style.opacity = "0";
      }
    }
    if (figure) {
      figure.src = figureUrl;
      figure.decoding = "async";
      figure.loading = "eager";
    }
    const eyebrow = $("loginHeroEyebrow"), title = $("loginHeroTitle"), subtitle = $("loginHeroSubtitle");
    if (eyebrow && login.eyebrow) eyebrow.textContent = login.eyebrow;
    if (title && login.title) title.textContent = login.title;
    if (subtitle && login.subtitle) subtitle.textContent = login.subtitle;
  }


  function toastIcon(kind) {
    return kind === "success" ? "✓" : kind === "error" ? "×" : kind === "warning" ? "!" : "i";
  }

  function dismissToast(el) {
    if (!el) return;
    const timer = toastTimers.get(el);
    if (timer) clearTimeout(timer);
    el.classList.add("leaving");
    window.setTimeout(() => el.remove(), 220);
  }

  function showToast(title, message, kind = "info", duration = 4300) {
    const signature = `${kind}|${String(title || "")}|${String(message || "")}`;
    const duplicateWindow = (kind === "error" || kind === "warning") ? 7000 : 2500;
    const lastShown = recentToastSignatures.get(signature) || 0;
    if (Date.now() - lastShown < duplicateWindow) return null;
    recentToastSignatures.set(signature, Date.now());
    if (recentToastSignatures.size > 40) {
      const cutoff = Date.now() - 30000;
      for (const [key, at] of recentToastSignatures) if (at < cutoff) recentToastSignatures.delete(key);
    }
    const stack = $("toastStack") || document.body;
    const el = document.createElement("article");
    el.className = `toast ${kind}`;
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    el.innerHTML = `
      <div class="toast-icon">${toastIcon(kind)}</div>
      <div class="toast-copy"><strong></strong><span></span></div>
      <button class="toast-close" type="button" aria-label="Đóng thông báo">×</button>
      <span class="toast-progress" aria-hidden="true"></span>`;
    el.querySelector("strong").textContent = title || "Thông báo";
    el.querySelector(".toast-copy span").textContent = message || "";
    el.querySelector(".toast-close").addEventListener("click", () => dismissToast(el));
    stack.append(el);
    while (stack.children.length > 4) {
      const oldest = stack.firstElementChild;
      if (!oldest || oldest === el) break;
      const oldTimer = toastTimers.get(oldest);
      if (oldTimer) clearTimeout(oldTimer);
      oldest.remove();
    }
    requestAnimationFrame(() => el.classList.add("show"));
    const progress = el.querySelector(".toast-progress");
    if (progress) progress.style.animationDuration = `${Math.max(1200, duration)}ms`;
    const timer = window.setTimeout(() => dismissToast(el), Math.max(1200, duration));
    toastTimers.set(el, timer);
    return el;
  }

  function systemDialog({ title = "Xác nhận", message = "", confirmText = "Xác nhận", cancelText = "Hủy", danger = false, input = false, inputPlaceholder = "" } = {}) {
    const modal = $("systemDialog");
    if (!modal) return Promise.resolve(input ? null : false);
    const titleEl = $("systemDialogTitle"), messageEl = $("systemDialogMessage");
    const inputEl = $("systemDialogInput"), confirm = $("systemDialogConfirm"), cancel = $("systemDialogCancel");
    titleEl.textContent = title;
    messageEl.textContent = message;
    confirm.textContent = confirmText;
    cancel.textContent = cancelText;
    confirm.classList.toggle("danger-button", danger);
    inputEl.classList.toggle("hidden", !input);
    inputEl.value = ""; inputEl.placeholder = inputPlaceholder || "";
    modal.classList.remove("hidden");
    document.body.classList.add("modal-open");
    if (input) setTimeout(() => inputEl.focus(), 50); else setTimeout(() => confirm.focus(), 50);
    return new Promise(resolve => {
      const finish = value => {
        modal.classList.add("hidden");
        document.body.classList.remove("modal-open");
        confirm.onclick = cancel.onclick = null;
        modal.onclick = null;
        resolve(value);
      };
      confirm.onclick = () => finish(input ? inputEl.value : true);
      cancel.onclick = () => finish(input ? null : false);
      modal.onclick = e => { if (e.target === modal) finish(input ? null : false); };
    });
  }

  window.NTS = window.NTS || {};
  Object.assign(window.NTS, {
    showToast,
    currentUser: null,
    supabase: null,
    configured,
    getClient: () => client,
    dialog: { confirm: (opts={}) => systemDialog(opts), prompt: (opts={}) => systemDialog({ ...opts, input: true }) }
  });

  function dispatchUser(user, event = "SIGNED_IN", { force = false } = {}) {
    const next = user || null;
    const id = next?.id || null;
    window.NTS.currentUser = next;
    const now = Date.now();
    const passive = event === "TOKEN_REFRESHED";
    const duplicateBoot = id && id === lastAuthUserId && (event === "INITIAL_SESSION" || event === "SIGNED_IN") && (now - lastAuthDispatchAt < 2500);
    if (!force && (passive && id === lastAuthUserId || duplicateBoot)) return false;
    if (!id && lastAuthUserId === null && !force && now - lastAuthDispatchAt < 1200) return false;
    lastAuthUserId = id;
    lastAuthDispatchAt = now;
    window.dispatchEvent(new CustomEvent("nts:auth-user", { detail: { user: next, event } }));
    return true;
  }

  // Supabase documents a deadlock when an API call is started from inside
  // onAuthStateChange. All app modules listen to nts:auth-user and some of them
  // immediately query Supabase, so this event MUST be dispatched on a later task.
  function scheduleDispatchUser(user, event = "SIGNED_IN", { force = false } = {}) {
    const next = user || null;
    window.NTS.currentUser = next;
    if (pendingAuthDispatchTimer) clearTimeout(pendingAuthDispatchTimer);
    const run = () => {
      pendingAuthDispatchTimer = 0;
      dispatchUser(next, event, { force });
    };
    if (document.readyState === "loading") {
      if (pendingAuthDomReady) document.removeEventListener("DOMContentLoaded", pendingAuthDomReady);
      pendingAuthDomReady = () => {
        pendingAuthDomReady = null;
        pendingAuthDispatchTimer = setTimeout(run, 0);
      };
      document.addEventListener("DOMContentLoaded", pendingAuthDomReady, { once: true });
    } else {
      pendingAuthDispatchTimer = setTimeout(run, 0);
    }
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
    scheduleDispatchUser(user, event);
  }

  function showAnonymous(event = "SIGNED_OUT") {
    appView.classList.add("hidden");
    authView.classList.remove("hidden");
    userMenu?.classList.add("hidden");
    userMenuButton?.setAttribute("aria-expanded", "false");
    document.title = cfg.APP_NAME || "NTS Logo Studio Pro Web";
    scheduleDispatchUser(null, event);
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
  userMenu?.addEventListener("click", (event) => {
    if (!event.target.closest("[data-page], #logoutButton")) return;
    userMenu.classList.add("hidden");
    userMenuButton?.setAttribute("aria-expanded", "false");
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

  async function ensurePerformanceDataCore() {
    if (window.NTS?.data?.bootstrap) return true;
    const existing = document.querySelector('script[data-nts-data-core="1"]');
    if (existing) {
      await new Promise((resolve) => {
        if (window.NTS?.data?.bootstrap) return resolve();
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", resolve, { once: true });
        setTimeout(resolve, 1800);
      });
      return Boolean(window.NTS?.data?.bootstrap);
    }
    await new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "js/data-core.js?v=3.18.4";
      script.async = true;
      script.dataset.ntsDataCore = "1";
      script.onload = resolve;
      script.onerror = resolve;
      document.head.appendChild(script);
      setTimeout(resolve, 1800);
    });
    return Boolean(window.NTS?.data?.bootstrap);
  }

  async function boot() {
    applyLoginBranding();
    await ensurePerformanceDataCore();
    setMode("login");
    if (!configured) {
      showAnonymous("UNCONFIGURED"); googleLogin.disabled = true;
      setTimeout(() => showToast("Cần cấu hình Supabase", "Điền Project URL và Publishable Key trong js/config.js để bật đăng nhập thật.", "warning", 9000), 450);
      return;
    }
    try {
      client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        // Current Supabase guidance recommends worker heartbeats for background tabs.
        realtime: {
          worker: true,
          heartbeatCallback: (status) => {
            window.dispatchEvent(new CustomEvent("nts:realtime-heartbeat", { detail: { status } }));
            if (status === "disconnected") {
              setTimeout(() => { try { client?.realtime?.connect?.(); } catch (_) {} }, 250);
            }
          }
        }
      });
      window.NTS.supabase = client;
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      if (data.session?.user) showAuthenticated(data.session.user, "INITIAL_SESSION"); else showAnonymous("INITIAL_SESSION");
      client.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_OUT" || !session?.user) { showAnonymous(event); return; }
        if (event === "TOKEN_REFRESHED") {
          window.NTS.currentUser = session.user;
          updateBaseUserUI(session.user);
          return;
        }
        if (event === "USER_UPDATED") {
          window.NTS.currentUser = session.user;
          updateBaseUserUI(session.user);
          window.dispatchEvent(new CustomEvent("nts:user-metadata-updated", { detail: { user: session.user } }));
          return;
        }
        if (["SIGNED_IN", "INITIAL_SESSION"].includes(event)) showAuthenticated(session.user, event);
      });
    } catch (error) { showAnonymous("ERROR"); showToast("Lỗi kết nối Supabase", authErrorMessage(error), "error", 8500); }
  }

  boot();
})();
