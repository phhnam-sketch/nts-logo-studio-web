(() => {
  "use strict";

  const NTS = window.NTS = window.NTS || {};
  const state = {
    bootstrapUserId: null,
    bootstrapPromise: null,
    bootstrapData: null,
    bootstrapAt: 0,
    bootstrapError: null,
    online: navigator.onLine !== false,
    lastNetworkErrorAt: 0,
    deferred: new Map()
  };

  const CACHE_PREFIX = "nts:v317:bootstrap:";
  const CACHE_MAX_AGE = 30 * 60 * 1000;
  const FRESH_WINDOW = 20 * 1000;

  const client = () => NTS.supabase;
  const now = () => Date.now();

  function safeParse(value) {
    try { return JSON.parse(value); } catch (_) { return null; }
  }

  function cacheKey(userId) { return `${CACHE_PREFIX}${userId}`; }

  function readCache(userId) {
    if (!userId) return null;
    try {
      const row = safeParse(sessionStorage.getItem(cacheKey(userId)) || "");
      if (!row?.data || !row?.at || now() - Number(row.at) > CACHE_MAX_AGE) return null;
      return row;
    } catch (_) { return null; }
  }

  function writeCache(userId, data) {
    if (!userId || !data) return;
    try { sessionStorage.setItem(cacheKey(userId), JSON.stringify({ at: now(), data })); }
    catch (_) {}
  }

  function clearCache(userId) {
    if (!userId) return;
    try { sessionStorage.removeItem(cacheKey(userId)); } catch (_) {}
  }

  function normalizeBootstrap(raw, userId) {
    const data = raw && typeof raw === "object" ? raw : {};
    return {
      user_id: data.user_id || userId || null,
      profile: data.profile && typeof data.profile === "object" ? data.profile : null,
      account: data.account && typeof data.account === "object" ? data.account : null,
      settings: data.settings && typeof data.settings === "object" ? data.settings : null,
      server_at: data.server_at || null,
      schema_version: data.schema_version || null
    };
  }

  function emitBootstrap(data, { cached = false, stale = false, error = null } = {}) {
    if (!data) return;
    window.dispatchEvent(new CustomEvent("nts:bootstrap-data", {
      detail: { data, cached, stale, error }
    }));
  }

  function defer(key, delay, fn) {
    const existing = state.deferred.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      state.deferred.delete(key);
      try { fn(); } catch (error) { console.warn(`deferred task ${key}`, error); }
    }, Math.max(0, Number(delay) || 0));
    state.deferred.set(key, timer);
    return timer;
  }

  function cancelDeferred(key) {
    const timer = state.deferred.get(key);
    if (timer) clearTimeout(timer);
    state.deferred.delete(key);
  }

  async function bootstrap(user, { force = false } = {}) {
    const userId = user?.id || NTS.currentUser?.id || null;
    if (!userId || !client()) return null;

    if (!force && state.bootstrapUserId === userId && state.bootstrapData && now() - state.bootstrapAt < FRESH_WINDOW) {
      return state.bootstrapData;
    }
    if (state.bootstrapPromise && state.bootstrapUserId === userId) return state.bootstrapPromise;

    state.bootstrapUserId = userId;

    // Stale-while-revalidate: show the last known account/profile instantly while the
    // single bootstrap RPC refreshes in the background.
    const cached = readCache(userId);
    if (!state.bootstrapData && cached?.data) {
      const normalized = normalizeBootstrap(cached.data, userId);
      state.bootstrapData = normalized;
      state.bootstrapAt = Number(cached.at) || 0;
      emitBootstrap(normalized, { cached: true, stale: true });
    }

    state.bootstrapPromise = (async () => {
      try {
        const result = await client().rpc("app_bootstrap_v317");
        if (result?.error) throw result.error;
        const normalized = normalizeBootstrap(result?.data, userId);
        state.bootstrapData = normalized;
        state.bootstrapAt = now();
        state.bootstrapError = null;
        writeCache(userId, normalized);
        emitBootstrap(normalized, { cached: false, stale: false });
        return normalized;
      } catch (error) {
        state.bootstrapError = error;
        state.lastNetworkErrorAt = now();
        window.dispatchEvent(new CustomEvent("nts:bootstrap-error", { detail: { userId, error } }));
        if (state.bootstrapData) return state.bootstrapData;
        throw error;
      } finally {
        state.bootstrapPromise = null;
      }
    })();

    return state.bootstrapPromise;
  }

  function scheduleBootstrap(user, delay = 0) {
    const userId = user?.id || null;
    if (!userId) return;
    defer(`bootstrap:${userId}`, delay, () => {
      bootstrap(user).catch(error => {
        const info = NTS.health?.friendly?.(error, "dữ liệu tài khoản");
        if (info?.kind === "network") {
          NTS.health?.notifyOnce?.("network-global", info.title, info.message, "warning", 7000);
        } else if (info) {
          NTS.showToast?.(info.title, info.message, info.kind === "schema" ? "warning" : "error", 8500);
        }
      });
    });
  }

  function setNetworkState(online, source = "browser") {
    const next = Boolean(online);
    if (state.online === next) return;
    state.online = next;
    window.dispatchEvent(new CustomEvent("nts:network-state", { detail: { online: next, source } }));
  }

  window.addEventListener("online", () => {
    setNetworkState(true, "online");
    if (NTS.currentUser) scheduleBootstrap(NTS.currentUser, 250);
  });
  window.addEventListener("offline", () => setNetworkState(false, "offline"));

  window.addEventListener("nts:auth-user", event => {
    const user = event.detail?.user || null;
    if (!user) {
      state.bootstrapUserId = null;
      state.bootstrapPromise = null;
      state.bootstrapData = null;
      state.bootstrapAt = 0;
      return;
    }
    scheduleBootstrap(user, 0);
  });

  NTS.data = {
    state,
    bootstrap,
    scheduleBootstrap,
    defer,
    cancelDeferred,
    clearCache,
    get bootstrapData() { return state.bootstrapData; }
  };
})();
