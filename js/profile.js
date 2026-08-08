(() => {
  "use strict";
  // V3.1: robust profile media pipeline (mobile-friendly normalization + stable storage paths).
  const $ = (id) => document.getElementById(id);
  const NTS = window.NTS = window.NTS || {};
  const cfg = window.APP_CONFIG || {};
  const state = {
    user: null,
    profile: null,
    saving: false,
    removeAvatar: false,
    removeCover: false,
    previewUrls: { avatar: null, cover: null }
  };
  const toast = (t, m, k = "info", d) => NTS.showToast?.(t, m, k, d);
  const client = () => NTS.supabase;

  function defaults() { return { display_name: "Người dùng", bio: "", avatar_url: null, cover_url: null }; }
  function brandFallback(kind) {
    const brand = cfg.BRAND || {};
    return kind === "avatar"
      ? (brand.defaultAvatarUrl || "assets/brand/avatar-default.svg")
      : (brand.defaultCoverUrl || "assets/brand/cover-default.svg");
  }
  function mediaStatus(text, kind = "info") {
    const el = $("profileMediaStatus");
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind;
  }
  function revokePreview(kind) {
    if (state.previewUrls[kind]) URL.revokeObjectURL(state.previewUrls[kind]);
    state.previewUrls[kind] = null;
  }

  async function refresh() {
    if (!state.user || !client()) return;
    try {
      const { data, error } = await client().from("profiles").select("*").eq("id", state.user.id).single();
      if (error) throw error;
      state.profile = { ...defaults(), ...data };
      state.removeAvatar = false;
      state.removeCover = false;
      render();
    } catch (error) {
      console.error(error);
      toast("Không tải được hồ sơ", error.message || String(error), "error");
    }
  }

  function setImg(id, src, fallback) {
    const el = $(id);
    if (!el) return;
    el.onerror = () => {
      el.onerror = null;
      if (fallback && el.src !== fallback) el.src = fallback;
    };
    el.src = src || fallback;
  }

  function render() {
    const p = state.profile || defaults();
    if ($("profileDisplayName")) $("profileDisplayName").value = p.display_name || "";
    if ($("profileBio")) $("profileBio").value = p.bio || "";
    if ($("profileEmail")) $("profileEmail").value = state.user?.email || "";
    if ($("profileNameHero")) $("profileNameHero").textContent = p.display_name || "Người dùng";
    if ($("profileEmailHero")) $("profileEmailHero").textContent = state.user?.email || "";

    const avatar = p.avatar_url || state.user?.user_metadata?.avatar_url || state.user?.user_metadata?.picture || brandFallback("avatar");
    const cover = p.cover_url || brandFallback("cover");
    setImg("profileAvatarPreview", avatar, brandFallback("avatar"));
    setImg("profileCoverPreview", cover, brandFallback("cover"));
    if ($("userAvatarImage")) {
      setImg("userAvatarImage", avatar, brandFallback("avatar"));
      $("userAvatarImage").classList.remove("hidden");
      $("userAvatarFallback")?.classList.add("hidden");
    }
    if ($("userDisplayName")) $("userDisplayName").textContent = p.display_name;
    if ($("menuDisplayName")) $("menuDisplayName").textContent = p.display_name;
    mediaStatus("Hồ sơ đã đồng bộ. Ảnh mới sẽ được tự tối ưu trước khi tải lên.", "ok");
  }

  async function decodeImage(file) {
    if (typeof createImageBitmap === "function") {
      try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
      catch (_) { try { return await createImageBitmap(file); } catch (_) {} }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("Trình duyệt không đọc được định dạng ảnh này."));
      });
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function canvasBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Không tối ưu được ảnh hồ sơ.")), type, quality);
    });
  }

  async function normalizeProfileImage(file, kind) {
    if (!file || !String(file.type || "").startsWith("image/")) throw new Error("Hãy chọn một file ảnh hợp lệ.");
    if (file.size > 25 * 1024 * 1024) throw new Error("Ảnh nguồn quá lớn. Vui lòng chọn ảnh dưới 25 MB.");
    const decoded = await decodeImage(file);
    try {
      const srcW = Number(decoded.width || decoded.naturalWidth);
      const srcH = Number(decoded.height || decoded.naturalHeight);
      if (!srcW || !srcH) throw new Error("Không đọc được kích thước ảnh.");
      const maxW = kind === "avatar" ? 1400 : 2600;
      const maxH = kind === "avatar" ? 1400 : 1600;
      const scale = Math.min(1, maxW / srcW, maxH / srcH);
      const width = Math.max(1, Math.round(srcW * scale));
      const height = Math.max(1, Math.round(srcH * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(decoded, 0, 0, width, height);
      let blob;
      try { blob = await canvasBlob(canvas, "image/webp", .88); }
      catch (_) { blob = await canvasBlob(canvas, "image/jpeg", .9); }
      canvas.width = canvas.height = 1;
      if (blob.size > 5 * 1024 * 1024) throw new Error("Ảnh sau tối ưu vẫn lớn hơn 5 MB. Hãy chọn ảnh khác.");
      return { blob, width, height, extension: blob.type === "image/webp" ? "webp" : "jpg" };
    } finally {
      decoded?.close?.();
    }
  }

  function storagePathFromPublicUrl(url) {
    if (!url) return null;
    const marker = "/storage/v1/object/public/profile-media/";
    const index = String(url).indexOf(marker);
    if (index < 0) return null;
    return decodeURIComponent(String(url).slice(index + marker.length).split("?")[0]);
  }

  async function removeStoredPath(url) {
    const path = storagePathFromPublicUrl(url);
    if (!path || !path.startsWith(`${state.user.id}/`)) return;
    await client().storage.from("profile-media").remove([path]).catch(() => {});
  }

  async function uploadProfileMedia(file, kind, oldUrl) {
    const normalized = await normalizeProfileImage(file, kind);
    const path = `${state.user.id}/${kind}.${normalized.extension}`;
    mediaStatus(`Đang tải ${kind === "avatar" ? "ảnh đại diện" : "ảnh bìa"} đã tối ưu...`, "busy");
    const { error } = await client().storage.from("profile-media").upload(path, normalized.blob, {
      upsert: true,
      cacheControl: "3600",
      contentType: normalized.blob.type
    });
    if (error) {
      const msg = String(error.message || error);
      if (/row-level security|policy|bucket/i.test(msg)) {
        throw new Error("Supabase Storage đang chặn upload. Hãy chạy migration V3.1 `supabase/002_v3_1_production_fix.sql` rồi thử lại.");
      }
      throw error;
    }
    const { data } = client().storage.from("profile-media").getPublicUrl(path);
    if (!data?.publicUrl) throw new Error("Upload thành công nhưng không tạo được URL ảnh.");
    if (oldUrl && storagePathFromPublicUrl(oldUrl) && storagePathFromPublicUrl(oldUrl) !== path) await removeStoredPath(oldUrl);
    return `${data.publicUrl}?v=${Date.now()}`;
  }

  async function save(event) {
    event.preventDefault();
    if (state.saving) return;
    state.saving = true;
    const btn = $("saveProfileButton");
    if (btn) { btn.disabled = true; btn.textContent = "Đang lưu..."; }
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

      const { error } = await client().from("profiles").update({ display_name: displayName, bio, avatar_url: avatarUrl, cover_url: coverUrl }).eq("id", state.user.id);
      if (error) throw error;
      await client().auth.updateUser({ data: { display_name: displayName, avatar_url: avatarUrl || null } }).catch(() => {});

      revokePreview("avatar");
      revokePreview("cover");
      if ($("profileAvatarInput")) $("profileAvatarInput").value = "";
      if ($("profileCoverInput")) $("profileCoverInput").value = "";
      state.removeAvatar = false;
      state.removeCover = false;
      mediaStatus("Đã lưu ảnh và thông tin hồ sơ thành công.", "ok");
      toast("Đã cập nhật hồ sơ", "Ảnh đại diện, ảnh bìa và thông tin cá nhân đã được lưu.", "success");
      await refresh();
    } catch (error) {
      console.error(error);
      mediaStatus(error.message || String(error), "error");
      toast("Không lưu được hồ sơ", error.message || String(error), "error", 8000);
    } finally {
      state.saving = false;
      if (btn) { btn.disabled = false; btn.textContent = "Lưu thay đổi"; }
    }
  }

  function previewFile(file, kind) {
    if (!file) return;
    if (!String(file.type || "").startsWith("image/")) {
      toast("File không hợp lệ", "Hãy chọn một ảnh.", "warning");
      return;
    }
    revokePreview(kind);
    const url = URL.createObjectURL(file);
    state.previewUrls[kind] = url;
    state[kind === "avatar" ? "removeAvatar" : "removeCover"] = false;
    setImg(kind === "avatar" ? "profileAvatarPreview" : "profileCoverPreview", url, brandFallback(kind));
    mediaStatus(`${kind === "avatar" ? "Ảnh đại diện" : "Ảnh bìa"} mới đã sẵn sàng. Bấm “Lưu thay đổi” để upload.`, "pending");
  }

  function markRemove(kind) {
    state[kind === "avatar" ? "removeAvatar" : "removeCover"] = true;
    revokePreview(kind);
    const input = $(kind === "avatar" ? "profileAvatarInput" : "profileCoverInput");
    if (input) input.value = "";
    setImg(kind === "avatar" ? "profileAvatarPreview" : "profileCoverPreview", brandFallback(kind), brandFallback(kind));
    mediaStatus(`${kind === "avatar" ? "Ảnh đại diện" : "Ảnh bìa"} sẽ được xóa khi bạn bấm “Lưu thay đổi”.`, "pending");
  }

  $("profileForm")?.addEventListener("submit", save);
  $("profileAvatarInput")?.addEventListener("change", (e) => previewFile(e.target.files?.[0], "avatar"));
  $("profileCoverInput")?.addEventListener("change", (e) => previewFile(e.target.files?.[0], "cover"));
  $("removeAvatarButton")?.addEventListener("click", () => markRemove("avatar"));
  $("removeCoverButton")?.addEventListener("click", () => markRemove("cover"));

  window.addEventListener("nts:auth-user", (e) => {
    state.user = e.detail.user || null;
    if (state.user) refresh();
    else state.profile = null;
  });
  NTS.profile = { state, refresh };
  if (NTS.currentUser) { state.user = NTS.currentUser; refresh(); }
})();
