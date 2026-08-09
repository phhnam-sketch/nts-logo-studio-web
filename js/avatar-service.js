(() => {
  "use strict";
  const NTS = window.NTS = window.NTS || {};
  const fallback = () => window.APP_CONFIG?.BRAND?.defaultAvatarUrl || "assets/brand/avatar-default.png";
  const uidOf = member => String(member?.user_id || member?.peer_id || member?.id || "").trim();
  const roleClass = member => member?.role === "admin" ? "admin" : (member?.is_vip || member?.plan === "vip") ? "vip" : "free";
  const roleLabel = member => member?.role === "admin" ? "ADMIN" : (member?.is_vip || member?.plan === "vip") ? "VIP" : "FREE";
  const bound = new Map();

  function versionOf(member) {
    return member?.avatar_storage_version || member?.avatar_version || member?.updated_at || Date.now();
  }
  function addVersion(url, version) {
    if (!url || /^(blob:|data:)/i.test(String(url))) return url;
    try {
      const u = new URL(String(url), window.location.href);
      const stamp = version ? new Date(version).getTime() : Date.now();
      u.searchParams.set("v", String(Number.isFinite(stamp) ? stamp : version || Date.now()));
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
    const explicit = String(member?.avatar_storage_path || "").trim();
    if (explicit) return explicit;
    const id = uidOf(member);
    return id ? `${id}/avatar.jpg` : "";
  }
  function publicStorageUrl(member) {
    const path = storagePath(member);
    if (!path || !NTS.supabase?.storage) return null;
    try {
      const { data } = NTS.supabase.storage.from("profile-media").getPublicUrl(path);
      return data?.publicUrl ? addVersion(data.publicUrl, versionOf(member)) : null;
    } catch (_) { return null; }
  }
  function candidates(member) {
    const values = [];
    const exactStorage = publicStorageUrl(member);
    if (exactStorage) values.push(exactStorage);
    const raw = String(member?.avatar_url || "").trim();
    if (raw && !isDefaultLike(raw)) values.push(addVersion(raw, versionOf(member)));
    const oauth = String(member?.oauth_avatar_url || "").trim();
    if (oauth && !isDefaultLike(oauth)) values.push(addVersion(oauth, versionOf(member)));
    values.push(fallback());
    return [...new Set(values.filter(Boolean))];
  }
  async function signedAvatar(member) {
    const path = storagePath(member);
    if (!path || !NTS.supabase?.storage) return null;
    try {
      const { data, error } = await NTS.supabase.storage.from("profile-media").createSignedUrl(path, 3600);
      if (error) return null;
      return data?.signedUrl ? addVersion(data.signedUrl, versionOf(member)) : null;
    } catch (_) { return null; }
  }
  function applyCrop(img, member) {
    if (Number(member?.avatar_crop_version || 0) >= 1) {
      img.style.objectPosition = "50% 50%";
      img.style.transform = "none";
      return;
    }
    const x = Math.max(0, Math.min(100, Number(member?.avatar_pos_x ?? 50)));
    const y = Math.max(0, Math.min(100, Number(member?.avatar_pos_y ?? 50)));
    const zoom = Math.max(25, Math.min(500, Number(member?.avatar_zoom ?? 100)));
    img.style.objectPosition = "50% 50%";
    img.style.transform = `translate3d(${x - 50}%, ${y - 50}%, 0) scale(${zoom / 100})`;
  }
  function remember(img, member) {
    const id = uidOf(member); if (!id) return;
    if (!bound.has(id)) bound.set(id, new Set());
    bound.get(id).add(img);
  }
  function forgetDetached() {
    for (const [id, set] of bound) {
      for (const img of [...set]) if (!img.isConnected) set.delete(img);
      if (!set.size) bound.delete(id);
    }
  }
  function bindImage(img, member, { lazy = true } = {}) {
    if (!img) return;
    remember(img, member);
    applyCrop(img, member);
    img.decoding = "async";
    if (lazy) img.loading = "lazy";
    img.alt ||= member?.display_name ? `Ảnh đại diện ${member.display_name}` : "Ảnh đại diện";
    const list = candidates(member);
    let index = 0;
    let signedTried = false;
    const set = () => { img.src = list[index] || fallback(); };
    img.onerror = async () => {
      index += 1;
      if (index < list.length) return set();
      if (!signedTried) {
        signedTried = true;
        const signed = await signedAvatar(member);
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
    for (const img of [...set]) {
      if (!img.isConnected) { set.delete(img); continue; }
      bindImage(img, member || { user_id:id, avatar_storage_path:`${id}/avatar.jpg`, avatar_storage_version:Date.now() }, { lazy:false });
    }
    if (!set.size) bound.delete(id);
  }
  function invalidate(userId) {
    // V3.12 intentionally has NO permanent negative cache. A previously missing avatar
    // must be allowed to appear immediately after that member uploads one.
    if (userId) refreshBound(userId);
  }
  setInterval(forgetDetached, 60000);
  NTS.avatar = { fallback, uidOf, roleClass, roleLabel, addVersion, storagePath, publicStorageUrl, signedAvatar, candidates, bindImage, refreshBound, invalidate };
})();
