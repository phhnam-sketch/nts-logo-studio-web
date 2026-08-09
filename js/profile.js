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
    runtimeUrls: { avatar: null, cover: null },
    preparedMedia: { avatar: null, cover: null },
    prepareTokens: { avatar: 0, cover: 0 }
  };
  const toast = (t, m, k = "info", d) => NTS.showToast?.(t, m, k, d);
  const client = () => NTS.supabase;

  function defaults() { return {
    display_name: "Người dùng", bio: "", avatar_url: null, cover_url: null, updated_at: null,
    avatar_pos_x: 50, avatar_pos_y: 50, avatar_zoom: 100,
    cover_pos_x: 50, cover_pos_y: 50, cover_zoom: 100,
    avatar_crop_version: 0, cover_crop_version: 0
  }; }
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

  function clamp(v, min, max, fallback) {
    const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  }
  function mediaAdjust(kind) {
    const p = state.profile || defaults();
    return kind === "avatar"
      ? { x: clamp(p.avatar_pos_x,0,100,50), y: clamp(p.avatar_pos_y,0,100,50), zoom: clamp(p.avatar_zoom,35,500,100) }
      : { x: clamp(p.cover_pos_x,0,100,50), y: clamp(p.cover_pos_y,0,100,50), zoom: clamp(p.cover_zoom,35,500,100) };
  }
  function applyMediaAdjust(kind) {
    const a = mediaAdjust(kind);
    const p = state.profile || defaults();
    const isFinalCrop = Number(kind === "avatar" ? p.avatar_crop_version : p.cover_crop_version) >= 1;
    // V3.11: summary/topbar are fixed frames. New media is already physically cropped,
    // so the saved image itself never changes the frame size. Legacy profiles retain
    // their old transform until the owner resaves through the new Facebook-like editor.
    const ids = kind === "avatar" ? ["profileAvatarPreview", "userAvatarImage"] : ["profileCoverPreview"];
    ids.forEach(id => {
      const img = $(id);
      if (!img) return;
      img.style.objectPosition = "50% 50%";
      img.style.transform = isFinalCrop ? "none" : `translate3d(${a.x - 50}%, ${a.y - 50}%, 0) scale(${a.zoom / 100})`;
    });
    // Legacy inline editor is kept for backward compatibility, but only its own image
    // receives draft transforms. The profile hero no longer follows sliders live.
    const editor = $(kind === "avatar" ? "avatarEditorPreview" : "coverEditorPreview");
    if (editor) {
      editor.style.objectPosition = "50% 50%";
      editor.style.transform = `translate3d(${a.x - 50}%, ${a.y - 50}%, 0) scale(${a.zoom / 100})`;
    }
    const prefix = kind === "avatar" ? "avatar" : "cover";
    [[`${prefix}PosX`, a.x],[`${prefix}PosY`, a.y],[`${prefix}Zoom`, a.zoom]].forEach(([id,val]) => { if ($(id)) $(id).value = String(val); });
    [[`${prefix}PosXValue`, `${Math.round(a.x)}%`],[`${prefix}PosYValue`, `${Math.round(a.y)}%`],[`${prefix}ZoomValue`, `${Math.round(a.zoom)}%`]].forEach(([id,val]) => { if ($(id)) $(id).textContent = val; });
  }

  function hasEditableMedia(kind) {
    const p = state.profile || defaults();
    if (state.previewUrls[kind] || state.runtimeUrls[kind]) return true;
    if (kind === "avatar") return Boolean(p.avatar_url || state.user?.user_metadata?.avatar_url || state.user?.user_metadata?.picture);
    return Boolean(p.cover_url);
  }

  function syncEditorVisibility(kind) {
    const prefix = kind === "avatar" ? "avatar" : "cover";
    const has = hasEditableMedia(kind);
    $(`${prefix}EditorBody`)?.classList.toggle("hidden", !has);
    $(`${prefix}EmptyHint`)?.classList.toggle("hidden", has);
    $(`${prefix}MediaEditor`)?.classList.toggle("has-media", has);
  }

  function render() {
    const p = state.profile || defaults();
    if ($("profileDisplayName")) $("profileDisplayName").value = p.display_name || "";
    if ($("profileBio")) $("profileBio").value = p.bio || "";
    if ($("profileEmail")) $("profileEmail").value = state.user?.email || "";
    if ($("profileNameHero")) $("profileNameHero").textContent = p.display_name || "Người dùng";
    if ($("profileEmailHero")) $("profileEmailHero").textContent = state.user?.email || "";
    if ($("profileBioSummary")) $("profileBioSummary").textContent = p.bio?.trim() || "Chưa có giới thiệu. Bấm “Chỉnh sửa hồ sơ” để bổ sung thông tin.";

    const avatar = effectiveMedia("avatar");
    const cover = effectiveMedia("cover");
    setImg("profileAvatarPreview", avatar, brandFallback("avatar"));
    setImg("profileCoverPreview", cover, brandFallback("cover"));
    setImg("avatarEditorPreview", avatar, brandFallback("avatar"));
    setImg("coverEditorPreview", cover, brandFallback("cover"));
    syncEditorVisibility("avatar");
    syncEditorVisibility("cover");
    const finalAvatar = Number(p.avatar_crop_version || 0) >= 1;
    $("profileAvatarPreview")?.classList.toggle("v311-final-avatar", finalAvatar);
    if ($("userAvatarImage")) {
      setImg("userAvatarImage", avatar, brandFallback("avatar"));
      $("userAvatarImage").classList.toggle("v311-final-avatar", finalAvatar);
      $("userAvatarImage").classList.remove("hidden");
      $("userAvatarFallback")?.classList.add("hidden");
    }
    if ($("userDisplayName")) $("userDisplayName").textContent = p.display_name || "Người dùng";
    if ($("menuDisplayName")) $("menuDisplayName").textContent = p.display_name || "Người dùng";
    applyMediaAdjust("avatar");
    applyMediaAdjust("cover");
    window.NTS?.profileTransform?.refresh?.();
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
      const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, width, height);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
      ctx.drawImage(decoded, 0, 0, width, height);
      const blob = canvas.convertToBlob
        ? await canvas.convertToBlob({ type: "image/jpeg", quality: kind === "avatar" ? .92 : .90 })
        : await canvasBlob(canvas, "image/jpeg", kind === "avatar" ? .92 : .90);
      canvas.width = canvas.height = 1;
      if (blob.size > 5 * 1024 * 1024) throw new Error("Ảnh sau tối ưu vẫn lớn hơn 5 MB. Hãy chọn ảnh khác.");
      return { blob, width, height, extension: "jpg" };
    } finally { decoded?.close?.(); }
  }

  async function removeStoredPath(url) {
    const path = storagePathFromPublicUrl(url);
    if (!path || !state.user || !path.startsWith(`${state.user.id}/`)) return;
    try { await client().storage.from("profile-media").remove([path]); } catch (_) {}
  }

  async function uploadProfileMedia(file, kind, oldUrl) {
    const normalized = state.preparedMedia[kind]?.file === file ? state.preparedMedia[kind].normalized : await normalizeProfileImage(file, kind);
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


  function canonicalMediaUrl(kind, stamp = Date.now()) {
    if (!state.user || !client()?.storage) return null;
    try {
      const { data } = client().storage.from("profile-media").getPublicUrl(`${state.user.id}/${kind}.jpg`);
      return data?.publicUrl ? cacheBust(data.publicUrl, stamp) : null;
    } catch (_) { return null; }
  }

  function sourceMediaUrl(kind, stamp = Date.now()) {
    if (!state.user || !client()?.storage) return null;
    try {
      const { data } = client().storage.from("profile-media").getPublicUrl(`${state.user.id}/${kind}-source.jpg`);
      return data?.publicUrl ? cacheBust(data.publicUrl, stamp) : null;
    } catch (_) { return null; }
  }

  async function uploadBlob(path, blob) {
    const { error } = await client().storage.from("profile-media").upload(path, blob, {
      upsert: true, cacheControl: "0", contentType: "image/jpeg"
    });
    if (error) throw error;
  }

  async function getMediaSourceUrl(kind) {
    const p = state.profile || defaults();
    if (!state.user) return null;
    if (Number(kind === "avatar" ? p.avatar_crop_version : p.cover_crop_version) >= 1) {
      const source = sourceMediaUrl(kind, p.updated_at || Date.now());
      if (source) {
        try { await imageLoads(source); return source; } catch (_) {}
      }
    }
    return effectiveMedia(kind);
  }

  function hasSavedMedia(kind) {
    const p = state.profile || defaults();
    return kind === "avatar" ? Boolean(p.avatar_url) : Boolean(p.cover_url);
  }

  function getSavedCrop(kind) {
    return mediaAdjust(kind);
  }

  async function saveMediaCrop(kind, { sourceFile = null, cropBlob, crop }) {
    if (!state.user || !client()) throw new Error("Bạn cần đăng nhập lại trước khi lưu ảnh.");
    if (!(cropBlob instanceof Blob)) throw new Error("Không tạo được dữ liệu ảnh sau khi cắt.");
    if (state.saving) throw new Error("Hồ sơ đang được lưu. Vui lòng đợi một chút.");
    state.saving = true;
    const path = `${state.user.id}/${kind}.jpg`;
    const sourcePath = `${state.user.id}/${kind}-source.jpg`;
    try {
      mediaStatus(`Đang cập nhật ${kind === "avatar" ? "ảnh đại diện" : "ảnh bìa"}...`, "busy");
      const jobs = [uploadBlob(path, cropBlob)];
      if (sourceFile) {
        const normalized = await normalizeProfileImage(sourceFile, kind);
        jobs.push(uploadBlob(sourcePath, normalized.blob));
      }
      await Promise.all(jobs);
      const { data: publicData } = client().storage.from("profile-media").getPublicUrl(path);
      if (!publicData?.publicUrl) throw new Error("Không tạo được URL ảnh sau khi tải lên.");
      const prefix = kind === "avatar" ? "avatar" : "cover";
      const payload = {
        [`${prefix}_url`]: publicData.publicUrl,
        [`${prefix}_pos_x`]: clamp(crop?.x, 0, 100, 50),
        [`${prefix}_pos_y`]: clamp(crop?.y, 0, 100, 50),
        [`${prefix}_zoom`]: clamp(crop?.zoom, 100, 500, 100),
        [`${prefix}_crop_version`]: 1
      };
      const { data, error } = await client().from("profiles").update(payload).eq("id", state.user.id).select("*").single();
      if (error) throw error;
      state.profile = { ...defaults(), ...data };
      revokeUrl("runtimeUrls", kind);
      revokeUrl("previewUrls", kind);
      state.runtimeUrls[kind] = URL.createObjectURL(cropBlob);
      if (kind === "avatar") {
        try {
          const authResult = await client().auth.updateUser({ data: { avatar_url: publicData.publicUrl } });
          if (authResult?.error) console.warn("avatar metadata sync", authResult.error);
        } catch (error) { console.warn("avatar metadata sync", error); }
        NTS.avatar?.invalidate?.(state.user.id);
      }
      render();
      mediaStatus("Ảnh đã lưu và đồng bộ ngay trên giao diện.", "ok");
      window.dispatchEvent(new CustomEvent("nts:profile-saved", { detail: { profile: state.profile, kind } }));
      // CDN verification is intentionally background-only; the UI already shows the local crop.
      Promise.resolve().then(async () => {
        try {
          const remote = cacheBust(publicData.publicUrl, state.profile.updated_at || Date.now());
          await imageLoads(remote);
          revokeUrl("runtimeUrls", kind);
          render();
        } catch (_) {}
      });
      return state.profile;
    } catch (error) {
      const message = String(error?.message || error);
      if (/row-level security|policy|bucket|mime/i.test(message)) {
        throw new Error("Supabase Storage đang chặn ảnh hồ sơ. Kiểm tra bucket profile-media và policy upload/update của chính người dùng.");
      }
      throw error;
    } finally { state.saving = false; }
  }

  async function removeMedia(kind) {
    if (!state.user || !client()) return;
    const prefix = kind === "avatar" ? "avatar" : "cover";
    const paths = [`${state.user.id}/${kind}.jpg`, `${state.user.id}/${kind}-source.jpg`];
    await Promise.allSettled(paths.map(path => client().storage.from("profile-media").remove([path])));
    const payload = { [`${prefix}_url`]: null, [`${prefix}_pos_x`]:50, [`${prefix}_pos_y`]:50, [`${prefix}_zoom`]:100, [`${prefix}_crop_version`]:0 };
    const { data, error } = await client().from("profiles").update(payload).eq("id", state.user.id).select("*").single();
    if (error) throw error;
    state.profile = { ...defaults(), ...data };
    revokeUrl("runtimeUrls", kind); revokeUrl("previewUrls", kind);
    if (kind === "avatar") {
      try { await client().auth.updateUser({ data: { avatar_url: null } }); } catch (_) {}
      NTS.avatar?.invalidate?.(state.user.id);
    }
    render();
    window.dispatchEvent(new CustomEvent("nts:profile-saved", { detail: { profile: state.profile, kind } }));
    return state.profile;
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

      const removalJobs = [];
      if (state.removeAvatar && state.profile?.avatar_url) removalJobs.push(removeStoredPath(state.profile.avatar_url));
      if (state.removeCover && state.profile?.cover_url) removalJobs.push(removeStoredPath(state.profile.cover_url));
      if (removalJobs.length) await Promise.allSettled(removalJobs);

      mediaStatus("Đang lưu ảnh và vị trí...", "busy");
      const [avatarResult, coverResult] = await Promise.all([
        avatarFile ? uploadProfileMedia(avatarFile, "avatar", state.profile?.avatar_url) : Promise.resolve(avatarUrl),
        coverFile ? uploadProfileMedia(coverFile, "cover", state.profile?.cover_url) : Promise.resolve(coverUrl)
      ]);
      avatarUrl = avatarResult; coverUrl = coverResult;

      const a = mediaAdjust("avatar"), c = mediaAdjust("cover");
      const payload = {
        display_name: displayName, bio, avatar_url: avatarUrl, cover_url: coverUrl,
        avatar_pos_x: a.x, avatar_pos_y: a.y, avatar_zoom: a.zoom,
        cover_pos_x: c.x, cover_pos_y: c.y, cover_zoom: c.zoom
      };
      const { data, error } = await client().from("profiles").update(payload).eq("id", state.user.id).select("*").single();
      if (error) throw error;
      if (!data) throw new Error("Không nhận được hồ sơ sau khi lưu. Hãy kiểm tra RLS của bảng profiles.");
      state.profile = { ...defaults(), ...data };
      render(); // immediate: local normalized blob is already visible here.

      try {
        const authResult = await client().auth.updateUser({ data: { display_name: displayName, avatar_url: avatarUrl || null } });
        if (authResult?.error) console.warn("auth avatar metadata sync", authResult.error);
      } catch (authSyncError) { console.warn("auth avatar metadata sync", authSyncError); }
      if ($("profileAvatarInput")) $("profileAvatarInput").value = "";
      if ($("profileCoverInput")) $("profileCoverInput").value = "";
      state.removeAvatar = false; state.removeCover = false;
      state.preparedMedia.avatar = null; state.preparedMedia.cover = null;
      mediaStatus("Đã lưu. Ảnh đang đồng bộ nền nhưng preview và vị trí đã được áp dụng ngay.", "ok");
      render();
      toast("Hồ sơ đã cập nhật", "Ảnh và vị trí hiển thị đã được lưu. Bạn có thể tiếp tục sử dụng app ngay.", "success");
      window.dispatchEvent(new CustomEvent("nts:profile-saved", { detail: { profile: state.profile } }));
      Promise.allSettled([ensureVisibleMedia("avatar"), ensureVisibleMedia("cover")]).then(checks => {
        ["avatar", "cover"].forEach((kind, i) => {
          const ok = checks[i].status === "fulfilled" && checks[i].value === true;
          if (ok) revokeUrl("previewUrls", kind);
        });
        render();
      });
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
    state.preparedMedia[kind] = null;
    const token = ++state.prepareTokens[kind];
    render();
    mediaStatus(`${kind === "avatar" ? "Ảnh đại diện" : "Ảnh bìa"} đã hiển thị. Bạn có thể chỉnh vị trí ngay; hệ thống đang tối ưu file nền...`, "pending");
    const prepareInBackground = () => {
      normalizeProfileImage(file, kind).then(normalized => {
        if (state.prepareTokens[kind] !== token) return;
        state.preparedMedia[kind] = { file, normalized };
        mediaStatus("Ảnh đã tối ưu xong trong nền. Bấm “Lưu thay đổi” để lưu rất nhanh.", "ok");
      }).catch(error => {
        if (state.prepareTokens[kind] !== token) return;
        console.warn("profile pre-prepare failed", error);
        mediaStatus("Preview vẫn dùng được; ảnh sẽ được tối ưu lại khi bấm Lưu.", "pending");
      });
    };
    if ("requestIdleCallback" in window) window.requestIdleCallback(prepareInBackground, { timeout: 900 });
    else window.setTimeout(prepareInBackground, 140);
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
  $("saveProfileButtonTop")?.addEventListener("click", () => $("profileForm")?.requestSubmit());
  $("profileAvatarInput")?.addEventListener("change", e => { const file=e.target.files?.[0]; if (file) NTS.profileMediaModal?.open?.("avatar", { file }); });
  $("profileCoverInput")?.addEventListener("change", e => { const file=e.target.files?.[0]; if (file) NTS.profileMediaModal?.open?.("cover", { file }); });
  $("removeAvatarButton")?.addEventListener("click", () => markRemove("avatar"));
  $("removeCoverButton")?.addEventListener("click", () => markRemove("cover"));

  function bindAdjust(kind) {
    const prefix = kind === "avatar" ? "avatar" : "cover";
    [[`${prefix}PosX`, kind === "avatar" ? "avatar_pos_x" : "cover_pos_x"],
     [`${prefix}PosY`, kind === "avatar" ? "avatar_pos_y" : "cover_pos_y"],
     [`${prefix}Zoom`, kind === "avatar" ? "avatar_zoom" : "cover_zoom"]].forEach(([id,key]) => {
      $(id)?.addEventListener("input", e => {
        state.profile = { ...defaults(), ...(state.profile || {}) };
        state.profile[key] = Number(e.target.value);
        applyMediaAdjust(kind);
        mediaStatus("Vị trí ảnh đã thay đổi. Bấm “Lưu thay đổi” để ghi nhớ.", "pending");
      });
    });
    $(kind === "avatar" ? "centerAvatarButton" : "centerCoverButton")?.addEventListener("click", () => {
      state.profile = { ...defaults(), ...(state.profile || {}) };
      if (kind === "avatar") Object.assign(state.profile, { avatar_pos_x:50, avatar_pos_y:50 });
      else Object.assign(state.profile, { cover_pos_x:50, cover_pos_y:50 });
      applyMediaAdjust(kind);
      mediaStatus("Đã căn giữa. Bấm “Lưu thay đổi” để ghi nhớ.", "pending");
    });
  }
  bindAdjust("avatar"); bindAdjust("cover");

  window.addEventListener("nts:auth-user", e => {
    const next = e.detail.user || null;
    if (state.user?.id && next?.id !== state.user.id) revokeAllTransient();
    state.user = next;
    if (state.user) refresh();
    else { state.profile = null; revokeAllTransient(); }
  });
  window.addEventListener("beforeunload", revokeAllTransient);
  NTS.profile = { state, refresh, saveMediaCrop, removeMedia, getMediaSourceUrl, hasSavedMedia, getSavedCrop, canonicalMediaUrl };
  if (NTS.currentUser) { state.user = NTS.currentUser; refresh(); }
})();
