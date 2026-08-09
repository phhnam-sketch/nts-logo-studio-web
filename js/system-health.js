(() => {
  "use strict";
  const NTS = window.NTS = window.NTS || {};
  const state = {
    last: null,
    lastError: null,
    checkedAt: 0,
    ensuring: null,
    running: null,
    notified: new Set()
  };

  const client = () => NTS.supabase;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function messageOf(error) {
    return String(error?.message || error?.details || error?.hint || error || "").trim();
  }

  function statusOf(error) {
    return Number(error?.status || error?.statusCode || error?.context?.status || 0);
  }

  function isTransient(error) {
    const msg = messageOf(error).toLowerCase();
    const status = statusOf(error);
    return error instanceof TypeError
      || /failed to fetch|networkerror|network error|load failed|fetch failed|timeout|timed out|connection reset|connection closed|gateway|temporarily unavailable/.test(msg)
      || [408, 425, 429, 500, 502, 503, 504, 520, 522, 524].includes(status);
  }

  function isSchemaError(error) {
    const code = String(error?.code || "").toUpperCase();
    const msg = messageOf(error).toLowerCase();
    return ["42P01", "42703", "42883", "42P13", "PGRST202", "PGRST204", "PGRST205"].includes(code)
      || /does not exist|schema cache|could not find the function|could not find.*column|relation .* does not exist|column .* does not exist|function .* does not exist/.test(msg);
  }

  function isAuthError(error) {
    const code = String(error?.code || "").toUpperCase();
    const msg = messageOf(error).toLowerCase();
    return ["401", "403", "PGRST301"].includes(code)
      || /jwt|not_authenticated|auth_required|permission denied|not authorized|unauthorized/.test(msg);
  }

  function classify(error) {
    if (isTransient(error)) return "network";
    if (isSchemaError(error)) return "schema";
    if (isAuthError(error)) return "auth";
    return "unknown";
  }

  function friendly(error, feature = "dữ liệu") {
    const kind = classify(error);
    const raw = messageOf(error) || "Lỗi không xác định";
    if (kind === "network") return {
      kind,
      title: "Kết nối dữ liệu tạm thời gián đoạn",
      message: `Không tải được ${feature}. Hệ thống sẽ tự thử lại; kiểm tra mạng rồi bấm Làm mới nếu cần.`,
      detail: raw
    };
    if (kind === "schema") return {
      kind,
      title: "Database chưa đồng bộ với web",
      message: "Hãy chạy duy nhất migration `supabase/017_v3_16_full_system_repair.sql`, sau đó tải lại trang.",
      detail: raw
    };
    if (kind === "auth") return {
      kind,
      title: "Phiên đăng nhập không đủ quyền",
      message: `Không thể đọc ${feature}. Hãy đăng xuất rồi đăng nhập lại; nếu là Admin hãy kiểm tra role trong memberships.`,
      detail: raw
    };
    return { kind, title: `Không tải được ${feature}`, message: raw, detail: raw };
  }

  async function retry(operation, { attempts = 3, baseDelay = 220, transientOnly = true } = {}) {
    let last = null;
    for (let i = 0; i < attempts; i += 1) {
      try {
        const result = await operation();
        if (result?.error) throw result.error;
        return result;
      } catch (error) {
        last = error;
        const retryable = transientOnly ? isTransient(error) : (isTransient(error) || isSchemaError(error));
        if (!retryable || i >= attempts - 1) throw error;
        await sleep(Math.round(baseDelay * (2 ** i) + Math.random() * 100));
      }
    }
    throw last || new Error("RETRY_FAILED");
  }

  async function withTimeout(promiseLike, ms = 9000, label = "request") {
    let timer = 0;
    try {
      return await Promise.race([
        Promise.resolve(promiseLike),
        new Promise((_, reject) => {
          timer = window.setTimeout(() => {
            const e = new Error(`${label.toUpperCase()}_TIMEOUT`);
            e.name = "TimeoutError";
            reject(e);
          }, ms);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function ensureAccount({ force = false } = {}) {
    if (!client() || !NTS.currentUser) return false;
    if (state.ensuring && !force) return state.ensuring;
    state.ensuring = (async () => {
      try {
        const result = await withTimeout(client().rpc("ensure_my_account_v316"), 8000, "ensure account");
        if (result?.error) {
          // Old DB simply has no repair RPC yet. Leave it to system health / migration notice.
          if (isSchemaError(result.error)) return false;
          throw result.error;
        }
        return Boolean(result?.data ?? true);
      } catch (error) {
        if (!isSchemaError(error)) console.warn("ensure_my_account_v316", error);
        return false;
      } finally {
        state.ensuring = null;
      }
    })();
    return state.ensuring;
  }

  async function run({ force = false } = {}) {
    if (!client() || !NTS.currentUser) return null;
    if (!force && state.last && Date.now() - state.checkedAt < 30000) return state.last;
    if (state.running && !force) return state.running;
    state.running = (async () => {
      try {
        await ensureAccount();
        const result = await retry(
          () => withTimeout(client().rpc("system_health_v316"), 8000, "system health"),
          { attempts: 2 }
        );
        state.last = result?.data || null;
        state.lastError = null;
        state.checkedAt = Date.now();
        window.dispatchEvent(new CustomEvent("nts:system-health", { detail: { health: state.last, error: null } }));
        return state.last;
      } catch (error) {
        state.lastError = error;
        state.checkedAt = Date.now();
        window.dispatchEvent(new CustomEvent("nts:system-health", { detail: { health: state.last, error } }));
        return null;
      } finally {
        state.running = null;
      }
    })();
    return state.running;
  }

  function notifyOnce(key, title, message, kind = "warning", duration = 8000) {
    if (state.notified.has(key)) return;
    state.notified.add(key);
    NTS.showToast?.(title, message, kind, duration);
  }

  function missingFeatures(health = state.last) {
    if (!health) return [];
    return [
      ["core_ready", "Tài khoản / quota"],
      ["community_ready", "Cộng đồng / tin nhắn"],
      ["payment_ready", "Thanh toán"],
      ["avatar_ready", "Avatar đồng bộ"],
      ["admin_ready", "Quản trị"]
    ].filter(([key]) => health[key] === false).map(([, label]) => label);
  }

  window.addEventListener("nts:auth-user", event => {
    if (!event.detail?.user) {
      state.last = null; state.lastError = null; state.checkedAt = 0; state.notified.clear();
      return;
    }
    // Do not block first paint/login. Repair + health run in the background.
    setTimeout(() => run({ force: true }), 0);
  });

  NTS.health = {
    state,
    run,
    ensureAccount,
    retry,
    withTimeout,
    classify,
    friendly,
    isTransient,
    isSchemaError,
    isAuthError,
    missingFeatures,
    notifyOnce
  };
  if (NTS.currentUser) setTimeout(() => run({ force: true }), 0);
})();
