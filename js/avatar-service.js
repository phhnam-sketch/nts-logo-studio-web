(() => {
  "use strict";

  const NTS = window.NTS = window.NTS || {};
  const BUCKET = "profile-media";
  const FALLBACK_TTL = 5000;
  const REMOTE_TTL = 10 * 60 * 1000;
  const fallback = () => window.APP_CONFIG?.BRAND?.defaultAvatarUrl || "assets/brand/avatar-default.png";
  const uidOf = member => String(member?.user_id || member?.peer_id || member?.id || "").trim();
  const roleClass = member => member?.role === "admin" ? "admin" : (member?.is_vip || member?.plan === "vip") ? "vip" : "free";
  const roleLabel = member => member?.role === "admin" ? "ADMIN" : (member?.is_vip || member?.plan === "vip") ? "VIP" : "FREE";

  // All visible mini avatars are registered by user id. One resolved avatar can therefore
  // refresh Community, Messenger list, chat header and floating chat at the same time.
  const bound = new Map();
  const localOverrides = new Map();
  const remoteCache = new Map();
  const lastAttempt = new Map();
  const pendingIds = new Set();
  let pendingTimer = 0;
  let observer = null;

  function versionOf(member) {
    return member?.avatar_revision || member?.avatar_storage_version || member?.avatar_version || member?.avatar_updated_at || member?.updated_at || Date.now();
  }

  function addVersion(url, version) {
    if (!url || /^(blob:|data:)/i.test(String(url))) return url;
    try {
      const u = new URL(String(url), window.location.href);
      const raw = version instanceof Date ? version.getTime() : (Number(version) || new Date(version || Date.now()).getTime());
      u.searchParams.set("v", String(Number.isFinite(raw) ? raw : Date.now()));
      return u.href;
    } catch (_) {
      const text = String(url);
      return `${text}${text.includes("?") ? "&" : "?"}v=${encodeURIComponent(version || Date.now())}`;
    }
  }

  function isDefaultLike(url) {
    const text = String(url || "").toLowerCase();
    return !text || text.includes("avatar-default") || text.includes("default-avatar") || text.endsWith("/avatar-default.png");
  }

  function storagePath(member) {
    return String(member?.avatar_storage_path || member?.avatar_object_path || "").trim();
  }

  function publicStorageUrl(member) {
    const path = storagePath(member);
    if (!path || !NTS.supabase?.storage) return null;
    try {
      const { data } = NTS.supabase.storage.from(BUCKET).getPublicUrl(path);
      return data?.publicUrl ? addVersion(data.publicUrl, versionOf(member)) : null;
    } catch (_) { return null; }
  }

  function cacheRow(id) {
    const row = remoteCache.get(String(id || ""));
    if (!row) return null;
    if (row.expiresAt < Date.now()) { remoteCache.delete(String(id)); return null; }
    return row.member;
  }

  function overrideFor(member) {
    const id = uidOf(member);
    const row = id ? localOverrides.get(id) : null;
    if (!row) return null;
    if (row.expiresAt && row.expiresAt < Date.now()) { localOverrides.delete(id); return null; }
    return row.member;
  }

  function normalizeRemote(row) {
    if (!row) return null;
    const id = uidOf(row);
    if (!id) return null;
    return {
      ...row,
      user_id: id,
      peer_id: row.peer_id || id,
      avatar_storage_path: row.avatar_storage_path || row.avatar_object_path || null,
      avatar_storage_version: row.avatar_storage_version || row.avatar_updated_at || row.updated_at || null,
      avatar_revision: Number(row.avatar_revision || 0)
    };
  }

  function mergedMember(member) {
    const id = uidOf(member);
    const cached = id ? cacheRow(id) : null;
    const local = overrideFor(member || cached || { user_id:id });
    return { ...(member || {}), ...(cached || {}), ...(local || {}) };
  }

  function candidates(member) {
    const m = mergedMember(member);
    const values = [];
    const exactStorage = publicStorageUrl(m);
    const raw = String(m?.avatar_url || "").trim();
    const oauth = String(m?.oauth_avatar_url || "").trim();

    // V3.14 SOURCE OF TRUTH ORDER:
    // 1) actual Storage object path resolved from DB, 2) profile URL, 3) OAuth, 4) fallback.
    // This prevents a still-valid old avatar_url from blocking a newer Storage object.
    if (exactStorage) values.push(exactStorage);
    if (raw && !isDefaultLike(raw)) values.push(addVersion(raw, versionOf(m)));
    if (oauth && !isDefaultLike(oauth)) values.push(addVersion(oauth, versionOf(m)));
    values.push(fallback());
    return [...new Set(values.filter(Boolean))];
  }

  async function signedAvatar(member) {
    const m = mergedMember(member);
    const path = storagePath(m);
    if (!path || !NTS.supabase?.storage) return null;
    try {
      const { data, error } = await NTS.supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
      if (error) return null;
      return data?.signedUrl ? addVersion(data.signedUrl, versionOf(m)) : null;
    } catch (_) { return null; }
  }

  function applyCrop(img, member) {
    const m = mergedMember(member);
    // New avatar files are physically cropped. Mini frames stay fixed everywhere.
    if (Number(m?.avatar_crop_version || 0) >= 1 || Number(m?.avatar_revision || 0) > 0 || storagePath(m).includes("/avatar/")) {
      img.style.objectPosition = "50% 50%";
      img.style.transform = "none";
      return;
    }
    const x = Math.max(0, Math.min(100, Number(m?.avatar_pos_x ?? 50)));
    const y = Math.max(0, Math.min(100, Number(m?.avatar_pos_y ?? 50)));
    const zoom = Math.max(100, Math.min(500, Number(m?.avatar_zoom ?? 100)));
    img.style.objectPosition = `${x}% ${y}%`;
    img.style.transform = `scale(${zoom / 100})`;
  }

  function remember(img, member) {
    const id = uidOf(member);
    if (!id) return;
    if (!bound.has(id)) bound.set(id, new Set());
    bound.get(id).add(img);
    img.dataset.ntsAvatarUser = id;
    img.dataset.ntsAvatarBound = "1";
  }

  function forgetDetached() {
    for (const [id, set] of bound) {
      for (const img of [...set]) if (!img.isConnected) set.delete(img);
      if (!set.size) bound.delete(id);
    }
  }

  function scheduleHydrate(userId, { force = false } = {}) {
    const id = String(userId || "").trim();
    if (!id || !NTS.supabase?.rpc) return;
    if (!force && cacheRow(id)) return;
    const last = lastAttempt.get(id) || 0;
    if (!force && Date.now() - last < FALLBACK_TTL) return;
    pendingIds.add(id);
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(flushHydrationQueue, 18);
  }

  async function flushHydrationQueue() {
    const ids = [...pendingIds];
    pendingIds.clear();
    if (!ids.length || !NTS.supabase?.rpc) return [];
    ids.forEach(id => lastAttempt.set(id, Date.now()));
    try {
      const { data, error } = await NTS.supabase.rpc("get_member_avatar_map_v314", { p_user_ids: ids });
      if (error) throw error;
      const rows = Array.isArray(data) ? data.map(normalizeRemote).filter(Boolean) : [];
      const found = new Set();
      rows.forEach(row => { found.add(String(row.user_id)); acceptRemote(row); });
      // Missing users are intentionally NOT permanently cached. Retry is allowed after FALLBACK_TTL.
      return rows;
    } catch (error) {
      console.warn("NTS Avatar Hub hydration failed", error);
      return [];
    }
  }

  async function hydrateMembers(members, { force = false } = {}) {
    const list = Array.isArray(members) ? members : [members];
    const ids = [...new Set(list.map(uidOf).filter(Boolean))];
    if (!ids.length || !NTS.supabase?.rpc) return [];
    const need = ids.filter(id => force || !cacheRow(id));
    if (!need.length) return ids.map(id => cacheRow(id)).filter(Boolean);
    need.forEach(id => lastAttempt.set(id, Date.now()));
    try {
      const { data, error } = await NTS.supabase.rpc("get_member_avatar_map_v314", { p_user_ids: need });
      if (error) throw error;
      const rows = Array.isArray(data) ? data.map(normalizeRemote).filter(Boolean) : [];
      rows.forEach(acceptRemote);
      return rows;
    } catch (error) {
      // Migration 014 may not be present during rolling deployment. Fall back without breaking old code.
      console.warn("NTS Avatar Hub batch hydration unavailable", error);
      return [];
    }
  }

  function bindImage(img, member, { lazy = true, hydrate = true } = {}) {
    if (!img) return;
    const m = mergedMember(member);
    const id = uidOf(m);
    remember(img, m);
    applyCrop(img, m);
    img.decoding = "async";
    if (lazy) img.loading = "lazy";
    img.alt ||= m?.display_name ? `Ảnh đại diện ${m.display_name}` : "Ảnh đại diện";

    const token = `${id}:${Date.now()}:${Math.random()}`;
    img.dataset.ntsAvatarToken = token;
    const list = candidates(m);
    let index = 0;
    let signedTried = false;
    let rehydrated = false;

    const set = () => {
      if (img.dataset.ntsAvatarToken !== token) return;
      img.src = list[index] || fallback();
    };

    img.onerror = async () => {
      if (img.dataset.ntsAvatarToken !== token) return;
      index += 1;
      if (index < list.length) return set();
      if (!signedTried) {
        signedTried = true;
        const signed = await signedAvatar(m);
        if (signed && img.dataset.ntsAvatarToken === token) { img.src = signed; return; }
      }
      if (!rehydrated && id) {
        rehydrated = true;
        const rows = await hydrateMembers([{ user_id:id }], { force:true });
        if (rows.length && img.isConnected) return bindImage(img, { ...m, ...rows[0] }, { lazy:false, hydrate:false });
      }
      img.onerror = null;
      img.src = fallback();
    };

    set();
    // Even if the fallback image loads successfully, resolve the exact cross-account Storage path in parallel.
    if (hydrate && id && (!storagePath(m) || isDefaultLike(m.avatar_url))) scheduleHydrate(id);
  }

  function refreshBound(userId, member) {
    const id = String(userId || "");
    if (!id) return;
    const set = bound.get(id);
    if (!set) return;
    const effective = mergedMember(member || { user_id:id });
    for (const img of [...set]) {
      if (!img.isConnected) { set.delete(img); continue; }
      bindImage(img, effective, { lazy:false, hydrate:false });
    }
    if (!set.size) bound.delete(id);
  }

  function publishLocal(userId, member, ttlMs = 10 * 60 * 1000) {
    const id = String(userId || uidOf(member) || "");
    if (!id) return;
    const merged = normalizeRemote({ ...(member || {}), user_id:id }) || { ...(member || {}), user_id:id };
    localOverrides.set(id, { member:merged, expiresAt:Date.now() + ttlMs });
    remoteCache.set(id, { member:merged, expiresAt:Date.now() + REMOTE_TTL });
    refreshBound(id, merged);
    window.dispatchEvent(new CustomEvent("nts:avatar-resolved", { detail:{ userId:id, member:merged } }));
    try { avatarBroadcast?.postMessage({ type:"avatar", member:merged }); } catch (_) {}
  }

  function acceptRemote(member) {
    const row = normalizeRemote(member);
    const id = uidOf(row);
    if (!id) return;
    remoteCache.set(id, { member:row, expiresAt:Date.now() + REMOTE_TTL });
    // An authoritative DB revision supersedes the optimistic local version once it is equal/newer.
    const local = localOverrides.get(id)?.member;
    if (!local || Number(row.avatar_revision || 0) >= Number(local.avatar_revision || 0)) localOverrides.delete(id);
    refreshBound(id, row);
  }

  function invalidate(userId) {
    const id = String(userId || "");
    if (!id) return;
    localOverrides.delete(id);
    remoteCache.delete(id);
    lastAttempt.delete(id);
    refreshBound(id, { user_id:id, avatar_storage_version:Date.now(), avatar_revision:Date.now() });
    scheduleHydrate(id, { force:true });
  }

  // Self-heal any mini-avatar rendered by legacy/community code paths.
  function scanNode(root = document) {
    const nodes = [];
    if (root?.matches?.(".v37-member-avatar[data-user-id]")) nodes.push(root);
    root?.querySelectorAll?.(".v37-member-avatar[data-user-id]").forEach(el => nodes.push(el));
    nodes.forEach(wrap => {
      const id = String(wrap.dataset.userId || "").trim();
      const img = wrap.querySelector(".v310-avatar-frame > img, img");
      if (!id || !img) return;
      if (img.dataset.ntsAvatarUser !== id) bindImage(img, { user_id:id }, { lazy:true, hydrate:true });
      else scheduleHydrate(id);
    });
  }

  function installObserver() {
    if (observer || !document.documentElement) return;
    scanNode(document);
    observer = new MutationObserver(records => {
      for (const record of records) record.addedNodes.forEach(node => { if (node.nodeType === 1) scanNode(node); });
    });
    observer.observe(document.documentElement, { childList:true, subtree:true });
  }

  let avatarBroadcast = null;
  try {
    avatarBroadcast = new BroadcastChannel("nts-avatar-sync-v314");
    avatarBroadcast.onmessage = event => {
      if (event.data?.type === "avatar" && event.data?.member) acceptRemote(event.data.member);
    };
  } catch (_) {}

  window.addEventListener("nts:avatar-updated", event => {
    const d = event.detail || {};
    if (!d.userId) return;
    publishLocal(d.userId, {
      ...(d.profile || {}), user_id:d.userId, avatar_url:d.url || d.profile?.avatar_url || null,
      avatar_storage_path:d.path || d.profile?.avatar_object_path || null,
      avatar_revision:d.revision || d.profile?.avatar_revision || Date.now()
    });
  });

  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const ids = [...bound.keys()];
    if (ids.length) hydrateMembers(ids.map(user_id => ({ user_id })), { force:true });
  });

  setInterval(forgetDetached, 60000);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installObserver, { once:true });
  else installObserver();

  NTS.avatar = {
    fallback, uidOf, roleClass, roleLabel, addVersion, storagePath, publicStorageUrl,
    signedAvatar, candidates, bindImage, refreshBound, publishLocal, acceptRemote, invalidate,
    hydrateMembers, scheduleHydrate, mergedMember, scanNode
  };
})();
