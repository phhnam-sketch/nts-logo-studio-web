(() => {
  "use strict";
  // V3.2: deterministic profile media save + immediate display + cache-safe fallback.
  const $ = (id) => document.getElementById(id);
  const NTS = window.NTS = window.NTS || {};
  const cfg = window.APP_CONFIG || {};
  const state = {
    user: null,
    profile: null,
    saving: false,
    removeAvatar: false,
    removeCover: false,
    previewUrls: { avatar: null, cover: null },
    runtimeUrls: { avatar: null, cover: null }
  };
  const toast = (t, m, k = "info", d) => NTS.showToast?.(t, m, k, d);
  const client = () => NTS.supabase;

  function defaults() { return { display_name: "Người dùng", bio: "", avatar_url: null, cover_url: null, updated_at: null }; }
  function brandFallback(kind) {
    const brand = cfg.BRAND || {};
    return kind === "avatar"
      ? (brand.defaultAvatarUrl || "assets/brand/avatar-default.png")
      : (brand.defaultCoverUrl || "assets/brand/cover-default.png");
  }
  function mediaStatus(text, kind = "info") {
    const el = $("profileMediaStatus");
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind;
  }
  function revokeUrl(bucket, kind) {
    if (state[bucket]?.[kind]) URL.revokeObjectURL(state[bucket][kind]);
    state[bucket][kind] = null;
  }
  function revokeAllTransient() {
    ["avatar", "cover"].forEach(kind => {
      revokeUrl("previewUrls", kind);
      revokeUrl("runtimeUrls", kind);
    });
  }
  function cacheBust(url, stamp) {
    if (!url || String(url).startsWith("blob:")) return url;
    try {
      const parsed = new URL(url, window.location.href);
      parsed.searchParams.set("v", String(stamp || Date.now()));
      return parsed.href;
    } catch (_) {
      const base = String(url).split("#")[0];
      return `${base}${base.includes("?") ? "&" : "?"}v=${encodeURIComponent(stamp || Date.now())}`;
    }
  }
  function storagePathFromPublicUrl(url) {
    if (!url) return null;
    const marker = "/storage/v1/object/public/profile-media/";
    const index = String(url).indexOf(marker);
    if (index < 0) return null;
    return decodeURIComponent(String(url).slice(index + marker.length).split("?")[0].split("#")[0]);
  }
  function setImg(id, src, fallback) {
    const el = $(id);
    if (!el) return;
    el.onerror = () => {
      el.onerror = null;
      if (fallback && el.getAttribute("src") !== fallback) el.src = fallback;
    };
    el.src = src || fallback;
  }

  function effectiveMedia(kind) {
    const p = state.profile || defaults();
    const transient = state.previewUrls[kind] || state.runtimeUrls[kind];
    if (transient) return transient;
    if (kind === "avatar") {
      const raw = p.avatar_url || state.user?.user_metadata?.avatar_url || state.user?.user_metadata?.picture || null;
      return raw ? cacheBust(raw, p.updated_at || Date.now()) : brandFallback("avatar");
    }
    return p.cover_url ? cacheBust(p.cover_url, p.updated_at || Date.now()) : brandFallback("cover");
  }

  function render() {
    const p = state.profile || defaults();
    if ($("profileDisplayName")) $("profileDisplayName").value = p.display_name || "";
    if ($("profileBio")) $("profileBio").value = p.bio || "";
    if ($("profileEmail")) $("profileEmail").value = state.user?.email || "";
    if ($("profileNameHero")) $("profileNameHero").textContent = p.display_name || "Người dùng";
    if ($("profileEmailHero")) $("profileEmailHero").textContent = state.user?.email || "";

    const avatar = effectiveMedia("avatar");
    const cover = effectiveMedia("cover");
    setImg("profileAvatarPreview", avatar, brandFallback("avatar"));
    setImg("profileCoverPreview", cover, brandFallback("cover"));
    if ($("userAvatarImage")) {
      setImg("userAvatarImage", avatar, brandFallback("avatar"));
      $("userAvatarImage").classList.remove("hidden");
      $("userAvatarFallback")?.classList.add("hidden");
    }
    if ($("userDisplayName")) $("userDisplayName").textContent = p.display_name || "Người dùng";
    if ($("menuDisplayName")) $("menuDisplayName").textContent = p.display_name || "Người dùng";
  }

  function imageLoads(url) {
    return new Promise((resolve, reject) => {
      if (!url) return reject(new Error("EMPTY_URL"));
      const img = new Image();
      const timer = setTimeout(() => reject(new Error("IMAGE_TIMEOUT")), 8000);
      img.onload = () => { clearTimeout(timer); resolve(true); };
      img.onerror = () => { clearTimeout(timer); reject(new Error("IMAGE_LOAD_FAILED")); };
      img.src = url;
    });
  }

  async function ensureVisibleMedia(kind) {
    const p = state.profile || defaults();
    const raw = kind === "avatar" ? p.avatar_url : p.cover_url;
    if (!raw) return true;
    const remote = cacheBust(raw, p.updated_at || Date.now());
    try {
      await imageLoads(remote);
      revokeUrl("runtimeUrls", kind);
      if (!state.previewUrls[kind]) render();
      return true;
    } catch (_) {}

    // Fallback: authenticated download -> blob URL. This guarantees the owner can still see
    // the saved image even when a public URL is cached/stale or a CDN edge is slow.
    const path = storagePathFromPublicUrl(raw);
    if (!path || !state.user || !path.startsWith(`${state.user.id}/`)) return false;
    try {
      const { data, error } = await client().storage.from("profile-media").download(path);
      if (error) throw error;
      revokeUrl("runtimeUrls", kind);
      state.runtimeUrls[kind] = URL.createObjectURL(data);
      if (!state.previewUrls[kind]) render();
      mediaStatus("Ảnh hồ sơ đã lưu. Hệ thống đang dùng bản tải trực tiếp để tránh lỗi cache hiển thị.", "ok");
      return true;
    } catch (error) {
      console.warn("profile media fallback failed", kind, error);
      return false;
    }
  }

  async function refresh({ silent = false } = {}) {
    if (!state.user || !client()) return;
    try {
      const { data, error } = await client().from("profiles").select("*").eq("id", state.user.id).single();
      if (error) throw error;
      state.profile = { ...defaults(), ...data };
      state.removeAvatar = false;
      state.removeCover = false;
      render();
      if (!silent) mediaStatus("Hồ sơ đã đồng bộ. Ảnh mới sẽ hiển thị ngay sau khi lưu.", "ok");
      await Promise.allSettled([ensureVisibleMedia("avatar"), ensureVisibleMedia("cover")]);
    } catch (error) {
      console.error(error);
      toast("Không tải được hồ sơ", error.message || String(error), "error");
    }
  }

  async function decodeImage(file) {
    if (typeof createImageBitmap === "function") {
      try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
      catch (_) { try { return await createImageBitmap(file); } catch (_) {} }
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    try {
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("Trình duyệt không đọc được định dạng ảnh này."));
      });
      return img;
    } finally { URL.revokeObjectURL(url); }
  }
  function canvasBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Không tối ưu được ảnh hồ sơ.")), type, quality));
  }
  async function normalizeProfileImage(file, kind) {
    if (!file || !String(file.type || "").startsWith("image/")) throw new Error("Hãy chọn một file ảnh hợp lệ.");
    if (file.size > 30 * 1024 * 1024) throw new Error("Ảnh nguồn quá lớn. Vui lòng chọn ảnh dưới 30 MB.");
    const decoded = await decodeImage(file);
    try {
      const srcW = Number(decoded.width || decoded.naturalWidth);
      const srcH = Number(decoded.height || decoded.naturalHeight);
      if (!srcW || !srcH) throw new Error("Không đọc được kích thước ảnh.");
      const maxW = kind === "avatar" ? 1600 : 2800;
      const maxH = kind === "avatar" ? 1600 : 1800;
      const scale = Math.min(1, maxW / srcW, maxH / srcH);
      const width = Math.max(1, Math.round(srcW * scale));
      const height = Math.max(1, Math.round(srcH * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, width, height);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
      ctx.drawImage(decoded, 0, 0, width, height);
      // JPEG is intentionally used here for the widest mobile/browser compatibility.
      const blob = await canvasBlob(canvas, "image/jpeg", kind === "avatar" ? .93 : .91);
      canvas.width = canvas.height = 1;
      if (blob.size > 5 * 1024 * 1024) throw new Error("Ảnh sau tối ưu vẫn lớn hơn 5 MB. Hãy chọn ảnh khác.");
      return { blob, width, height, extension: "jpg" };
    } finally { decoded?.close?.(); }
  }

  async function removeStoredPath(url) {
    const path = storagePathFromPublicUrl(url);
    if (!path || !state.user || !path.startsWith(`${state.user.id}/`)) return;
    await client().storage.from("profile-media").remove([path]).catch(() => {});
  }

  async function uploadProfileMedia(file, kind, oldUrl) {
    const normalized = await normalizeProfileImage(file, kind);
    const path = `${state.user.id}/${kind}.jpg`;
    mediaStatus(`Đang tải ${kind === "avatar" ? "ảnh đại diện" : "ảnh bìa"}...`, "busy");
    const { error } = await client().storage.from("profile-media").upload(path, normalized.blob, {
      upsert: true,
      cacheControl: "0",
      contentType: "image/jpeg"
    });
    if (error) {
      const msg = String(error.message || error);
      if (/row-level security|policy|bucket|mime/i.test(msg)) {
        throw new Error("Supabase Storage đang chặn ảnh hồ sơ. Hãy chạy migration V3.2 `supabase/003_v3_2_profile_payment.sql` rồi thử lại.");
      }
      throw error;
    }
    const { data } = client().storage.from("profile-media").getPublicUrl(path);
    if (!data?.publicUrl) throw new Error("Upload thành công nhưng không tạo được URL ảnh.");
    if (oldUrl) {
      const oldPath = storagePathFromPublicUrl(oldUrl);
      if (oldPath && oldPath !== path) await removeStoredPath(oldUrl);
    }
    // Keep an immediate local copy until the CDN/public URL has been verified.
    revokeUrl("previewUrls", kind);
    state.previewUrls[kind] = URL.createObjectURL(normalized.blob);
    return cacheBust(data.publicUrl, Date.now());
  }

  async function save(event) {
    event.preventDefault();
    if (state.saving || !state.user || !client()) return;
    state.saving = true;
    const btn = $("saveProfileButton");
    if (btn) { btn.disabled = true; btn.textContent = "Đang lưu hồ sơ..."; }
    try {
      const displayName = $("profileDisplayName").value.trim();
      const bio = $("profileBio").value.trim();
      if (!displayName || displayName.length > 60) throw new Error("Tên hiển thị phải từ 1 đến 60 ký tự.");
      if (bio.length > 500) throw new Error("Bio tối đa 500 ký tự.");

      let avatarUrl = state.removeAvatar ? null : (state.profile?.avatar_url || null);
      let coverUrl = state.removeCover ? null : (state.profile?.cover_url || null);
      const avatarFile = $("profileAvatarInput")?.files?.[0];
      const coverFile = $("profileCoverInput")?.files?.[0];

      if (state.removeAvatar && state.profile?.avatar_url) await removeStoredPath(state.profile.avatar_url);
      if (state.removeCover && state.profile?.cover_url) await removeStoredPath(state.profile.cover_url);
      if (avatarFile) avatarUrl = await uploadProfileMedia(avatarFile, "avatar", state.profile?.avatar_url);
      if (coverFile) coverUrl = await uploadProfileMedia(coverFile, "cover", state.profile?.cover_url);

      const payload = { display_name: displayName, bio, avatar_url: avatarUrl, cover_url: coverUrl };
      const { data, error } = await client().from("profiles").update(payload).eq("id", state.user.id).select("*").single();
      if (error) throw error;
      if (!data) throw new Error("Không nhận được hồ sơ sau khi lưu. Hãy kiểm tra RLS của bảng profiles.");
      state.profile = { ...defaults(), ...data };
      render(); // immediate: local normalized blob is already visible here.

      await client().auth.updateUser({ data: { display_name: displayName, avatar_url: avatarUrl || null } }).catch(() => {});
      if ($("profileAvatarInput")) $("profileAvatarInput").value = "";
      if ($("profileCoverInput")) $("profileCoverInput").value = "";
      state.removeAvatar = false; state.removeCover = false;
      mediaStatus("Đã lưu thành công. Đang xác minh ảnh từ Storage...", "busy");

      const checks = await Promise.allSettled([ensureVisibleMedia("avatar"), ensureVisibleMedia("cover")]);
      ["avatar", "cover"].forEach((kind, i) => {
        const ok = checks[i].status === "fulfilled" && checks[i].value === true;
        if (ok) revokeUrl("previewUrls", kind);
      });
      render();
      mediaStatus("Đã lưu và hiển thị hồ sơ thành công.", "ok");
      toast("Hồ sơ đã cập nhật", "Ảnh đại diện, ảnh bìa và thông tin cá nhân đã được đồng bộ.", "success");
    } catch (error) {
      console.error(error);
      mediaStatus(error.message || String(error), "error");
      toast("Không lưu được hồ sơ", error.message || String(error), "error", 9000);
    } finally {
      state.saving = false;
      if (btn) { btn.disabled = false; btn.textContent = "Lưu thay đổi"; }
    }
  }

  function previewFile(file, kind) {
    if (!file) return;
    if (!String(file.type || "").startsWith("image/")) return toast("File không hợp lệ", "Hãy chọn một ảnh.", "warning");
    revokeUrl("previewUrls", kind);
    state.previewUrls[kind] = URL.createObjectURL(file);
    state[kind === "avatar" ? "removeAvatar" : "removeCover"] = false;
    render();
    mediaStatus(`${kind === "avatar" ? "Ảnh đại diện" : "Ảnh bìa"} mới đã sẵn sàng. Bấm “Lưu thay đổi” để upload.`, "pending");
  }
  function markRemove(kind) {
    state[kind === "avatar" ? "removeAvatar" : "removeCover"] = true;
    revokeUrl("previewUrls", kind); revokeUrl("runtimeUrls", kind);
    const input = $(kind === "avatar" ? "profileAvatarInput" : "profileCoverInput");
    if (input) input.value = "";
    const p = state.profile || defaults();
    if (kind === "avatar") p.avatar_url = null; else p.cover_url = null;
    render();
    mediaStatus(`${kind === "avatar" ? "Ảnh đại diện" : "Ảnh bìa"} sẽ được xóa khi bạn bấm “Lưu thay đổi”.`, "pending");
  }

  $("profileForm")?.addEventListener("submit", save);
  $("profileAvatarInput")?.addEventListener("change", e => previewFile(e.target.files?.[0], "avatar"));
  $("profileCoverInput")?.addEventListener("change", e => previewFile(e.target.files?.[0], "cover"));
  $("removeAvatarButton")?.addEventListener("click", () => markRemove("avatar"));
  $("removeCoverButton")?.addEventListener("click", () => markRemove("cover"));

  window.addEventListener("nts:auth-user", e => {
    const next = e.detail.user || null;
    if (state.user?.id && next?.id !== state.user.id) revokeAllTransient();
    state.user = next;
    if (state.user) refresh();
    else { state.profile = null; revokeAllTransient(); }
  });
  window.addEventListener("beforeunload", revokeAllTransient);
  NTS.profile = { state, refresh };
  if (NTS.currentUser) { state.user = NTS.currentUser; refresh(); }
})();
