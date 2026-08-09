(() => {
  "use strict";
  const NTS = window.NTS = window.NTS || {};
  const failedCanonical = new Set();
  const fallback = () => window.APP_CONFIG?.BRAND?.defaultAvatarUrl || "assets/brand/avatar-default.png";
  const uidOf = member => String(member?.user_id || member?.peer_id || member?.id || "").trim();
  const roleClass = member => member?.role === "admin" ? "admin" : (member?.is_vip || member?.plan === "vip") ? "vip" : "free";
  const roleLabel = member => member?.role === "admin" ? "ADMIN" : (member?.is_vip || member?.plan === "vip") ? "VIP" : "FREE";

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

  function canonicalAvatar(member) {
    const id = uidOf(member);
    if (!id || failedCanonical.has(id) || !NTS.supabase?.storage) return null;
    try {
      const { data } = NTS.supabase.storage.from("profile-media").getPublicUrl(`${id}/avatar.jpg`);
      return data?.publicUrl ? addVersion(data.publicUrl, member?.avatar_version || member?.updated_at) : null;
    } catch (_) { return null; }
  }

  function candidates(member) {
    const id = uidOf(member);
    const raw = String(member?.avatar_url || "").trim();
    const cropVersion = Number(member?.avatar_crop_version || 0);
    const canonical = canonicalAvatar(member);
    const values = [];
    // Canonical Storage path is always tried first. Older releases could leave
    // profiles.avatar_url stale/default while uid/avatar.jpg had already been uploaded.
    if (canonical) values.push(canonical);
    if (raw) values.push(addVersion(raw, member?.avatar_version || member?.updated_at));
    values.push(fallback());
    return [...new Set(values.filter(Boolean))];
  }

  function bindImage(img, member, { lazy = true } = {}) {
    if (!img) return;
    const list = candidates(member);
    const id = uidOf(member);
    let index = 0;
    img.decoding = "async";
    if (lazy) img.loading = "lazy";
    img.alt ||= member?.display_name ? `Ảnh đại diện ${member.display_name}` : "Ảnh đại diện";
    const set = () => { img.src = list[index] || fallback(); };
    img.onerror = () => {
      const failed = list[index];
      if (id && failed && canonicalAvatar(member) && failed.split("?")[0] === canonicalAvatar(member)?.split("?")[0]) failedCanonical.add(id);
      index += 1;
      if (index < list.length) return set();
      img.onerror = null;
      img.src = fallback();
    };
    // Final V3.11 crops are already rendered pixels. Legacy profiles retain old transform behavior.
    if (Number(member?.avatar_crop_version || 0) >= 1) {
      img.style.objectPosition = "50% 50%";
      img.style.transform = "none";
    } else {
      const x = Math.max(0, Math.min(100, Number(member?.avatar_pos_x ?? 50)));
      const y = Math.max(0, Math.min(100, Number(member?.avatar_pos_y ?? 50)));
      const zoom = Math.max(25, Math.min(500, Number(member?.avatar_zoom ?? 100)));
      img.style.objectPosition = "50% 50%";
      img.style.transform = `translate3d(${x - 50}%, ${y - 50}%, 0) scale(${zoom / 100})`;
    }
    set();
  }

  function invalidate(userId) { if (userId) failedCanonical.delete(String(userId)); }

  NTS.avatar = { fallback, uidOf, roleClass, roleLabel, addVersion, canonicalAvatar, candidates, bindImage, invalidate };
})();
