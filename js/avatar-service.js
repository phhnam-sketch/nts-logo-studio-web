(() => {
  "use strict";
  const NTS = window.NTS = window.NTS || {};
  const fallback = () => window.APP_CONFIG?.BRAND?.defaultAvatarUrl || "assets/brand/avatar-default.png";
  const uidOf = member => String(member?.user_id || member?.peer_id || member?.id || "").trim();
  const roleClass = member => member?.role === "admin" ? "admin" : (member?.is_vip || member?.plan === "vip") ? "vip" : "free";
  const roleLabel = member => member?.role === "admin" ? "ADMIN" : (member?.is_vip || member?.plan === "vip") ? "VIP" : "FREE";
  const bound = new Map();
  const localOverrides = new Map();

  function versionOf(member) {
    return member?.avatar_revision || member?.avatar_storage_version || member?.avatar_version || member?.updated_at || Date.now();
  }
  function addVersion(url, version) {
    if (!url || /^(blob:|data:)/i.test(String(url))) return url;
    try {
      const u = new URL(String(url), window.location.href);
      const stamp = version instanceof Date ? version.getTime() : (Number(version) || new Date(version || Date.now()).getTime());
      u.searchParams.set("v", String(Number.isFinite(stamp) ? stamp : Date.now()));
      return u.href;
    } catch (_) {
      const text = String(url);
      return `${text}${text.includes("?") ? "&" : "?"}v=${encodeURIComponent(version || Date.now())}`;
    }
  }
  function isDefaultLike(url) {
    const text = String(url || "").toLowerCase();
    return !text || text.includes("avatar-default") || text.endsWith("/avatar-default.png");
  }
  function storagePath(member) {
    return String(member?.avatar_storage_path || member?.avatar_object_path || "").trim();
  }
  function publicStorageUrl(member) {
    const path = storagePath(member);
    if (!path || !NTS.supabase?.storage) return null;
    try {
      const { data } = NTS.supabase.storage.from("profile-media").getPublicUrl(path);
      return data?.publicUrl ? addVersion(data.publicUrl, versionOf(member)) : null;
    } catch (_) { return null; }
  }
  function overrideFor(member) {
    const id = uidOf(member);
    const row = id ? localOverrides.get(id) : null;
    if (!row) return null;
    if (row.expiresAt && row.expiresAt < Date.now()) { localOverrides.delete(id); return null; }
    return row.member;
  }
  function mergedMember(member) {
    const local = overrideFor(member);
    return local ? { ...(member || {}), ...local } : (member || {});
  }
  function candidates(member) {
    const m = mergedMember(member);
    const values = [];
    const raw = String(m?.avatar_url || "").trim();
    const exactStorage = publicStorageUrl(m);
    const revision = Number(m?.avatar_revision || 0);

    // V3.13 writes a unique immutable avatar_url per save. Prefer it immediately.
    if (revision > 0 && raw && !isDefaultLike(raw)) values.push(addVersion(raw, versionOf(m)));
    if (exactStorage) values.push(exactStorage);
    if (raw && !isDefaultLike(raw)) values.push(addVersion(raw, versionOf(m)));
    const oauth = String(m?.oauth_avatar_url || "").trim();
    if (oauth && !isDefaultLike(oauth)) values.push(addVersion(oauth, versionOf(m)));
    values.push(fallback());
    return [...new Set(values.filter(Boolean))];
  }
  async function signedAvatar(member) {
    const m = mergedMember(member);
    const path = storagePath(m);
    if (!path || !NTS.supabase?.storage) return null;
    try {
      const { data, error } = await NTS.supabase.storage.from("profile-media").createSignedUrl(path, 3600);
      if (error) return null;
      return data?.signedUrl ? addVersion(data.signedUrl, versionOf(m)) : null;
    } catch (_) { return null; }
  }
  function applyCrop(img, member) {
    // V3.11+ avatar pixels are physically cropped before upload. Never transform final pixels.
    if (Number(member?.avatar_crop_version || 0) >= 1 || Number(member?.avatar_revision || 0) > 0) {
      img.style.objectPosition = "50% 50%";
      img.style.transform = "none";
      return;
    }
    const x = Math.max(0, Math.min(100, Number(member?.avatar_pos_x ?? 50)));
    const y = Math.max(0, Math.min(100, Number(member?.avatar_pos_y ?? 50)));
    const zoom = Math.max(100, Math.min(500, Number(member?.avatar_zoom ?? 100)));
    img.style.objectPosition = "50% 50%";
    img.style.transform = `translate3d(${x - 50}%, ${y - 50}%, 0) scale(${zoom / 100})`;
  }
  function remember(img, member) {
    const id = uidOf(member); if (!id) return;
    if (!bound.has(id)) bound.set(id, new Set());
    bound.get(id).add(img);
    img.dataset.ntsAvatarUser = id;
  }
  function forgetDetached() {
    for (const [id, set] of bound) {
      for (const img of [...set]) if (!img.isConnected) set.delete(img);
      if (!set.size) bound.delete(id);
    }
  }
  function bindImage(img, member, { lazy = true } = {}) {
    if (!img) return;
    const m = mergedMember(member);
    remember(img, m);
    applyCrop(img, m);
    img.decoding = "async";
    if (lazy) img.loading = "lazy";
    img.alt ||= m?.display_name ? `Ảnh đại diện ${m.display_name}` : "Ảnh đại diện";
    const list = candidates(m);
    let index = 0;
    let signedTried = false;
    const set = () => { img.src = list[index] || fallback(); };
    img.onerror = async () => {
      index += 1;
      if (index < list.length) return set();
      if (!signedTried) {
        signedTried = true;
        const signed = await signedAvatar(m);
        if (signed) { img.src = signed; return; }
      }
      img.onerror = null;
      img.src = fallback();
    };
    set();
  }
  function refreshBound(userId, member) {
    const id = String(userId || ""); if (!id) return;
    const set = bound.get(id); if (!set) return;
    const effective = member || localOverrides.get(id)?.member || { user_id:id };
    for (const img of [...set]) {
      if (!img.isConnected) { set.delete(img); continue; }
      bindImage(img, effective, { lazy:false });
    }
    if (!set.size) bound.delete(id);
  }
  function publishLocal(userId, member, ttlMs = 10 * 60 * 1000) {
    const id = String(userId || uidOf(member) || ""); if (!id) return;
    const merged = { ...(member || {}), user_id:id };
    localOverrides.set(id, { member:merged, expiresAt:Date.now() + ttlMs });
    refreshBound(id, merged);
    window.dispatchEvent(new CustomEvent("nts:avatar-resolved", { detail:{ userId:id, member:merged } }));
  }
  function acceptRemote(member) {
    const id = uidOf(member); if (!id) return;
    // A database/realtime revision is authoritative and clears the temporary owner override.
    localOverrides.delete(id);
    refreshBound(id, member);
  }
  function invalidate(userId) {
    const id = String(userId || "");
    if (!id) return;
    localOverrides.delete(id);
    refreshBound(id, { user_id:id, avatar_storage_version:Date.now(), avatar_revision:Date.now() });
  }
  setInterval(forgetDetached, 60000);
  NTS.avatar = {
    fallback, uidOf, roleClass, roleLabel, addVersion, storagePath, publicStorageUrl,
    signedAvatar, candidates, bindImage, refreshBound, publishLocal, acceptRemote, invalidate
  };
})();
