(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const NTS = window.NTS = window.NTS || {};
  const state = {
    open: false, kind: "avatar", file: null, sourceUrl: null, objectUrl: null,
    img: null, naturalW: 0, naturalH: 0,
    x: 50, y: 50, zoom: 100,
    left: 0, top: 0, drawW: 0, drawH: 0, baseScale: 1,
    pointers: new Map(), dragStart: null, pinchStart: null, saving: false
  };
  const clamp = (n, min, max) => Math.max(min, Math.min(max, Number(n) || 0));
  const toast = (t, m, k="info", d) => NTS.showToast?.(t,m,k,d);

  function els() {
    return {
      modal: $("profileMediaModal"), title: $("profileMediaModalTitle"), subtitle: $("profileMediaModalSubtitle"),
      viewport: $("profileMediaModalViewport"), image: $("profileMediaModalImage"), zoom: $("profileMediaModalZoom"),
      zoomValue: $("profileMediaModalZoomValue"), save: $("profileMediaModalSave"), cancel: $("profileMediaModalCancel"),
      close: $("profileMediaModalClose"), reset: $("profileMediaModalReset"), replace: $("profileMediaModalReplace"),
      remove: $("profileMediaModalRemove"), loader: $("profileMediaModalLoader"), hint: $("profileMediaModalHint"),
      fileInput: state.kind === "avatar" ? $("profileAvatarCameraInput") : $("profileCoverCameraInput")
    };
  }

  function revokeObjectUrl() {
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
  }

  function viewportSize() {
    const r = els().viewport?.getBoundingClientRect();
    return { w: Math.max(1, r?.width || 1), h: Math.max(1, r?.height || 1) };
  }

  function computeLayout({ deriveFocal = false, left = null, top = null } = {}) {
    if (!state.naturalW || !state.naturalH) return;
    const { w: vw, h: vh } = viewportSize();
    state.baseScale = Math.max(vw / state.naturalW, vh / state.naturalH);
    const scale = state.baseScale * clamp(state.zoom, 100, 500) / 100;
    state.drawW = state.naturalW * scale;
    state.drawH = state.naturalH * scale;

    let nextLeft = left == null ? (vw / 2 - state.drawW * clamp(state.x, 0, 100) / 100) : left;
    let nextTop = top == null ? (vh / 2 - state.drawH * clamp(state.y, 0, 100) / 100) : top;
    const minLeft = Math.min(0, vw - state.drawW);
    const minTop = Math.min(0, vh - state.drawH);
    nextLeft = clamp(nextLeft, minLeft, 0);
    nextTop = clamp(nextTop, minTop, 0);
    state.left = nextLeft;
    state.top = nextTop;

    if (deriveFocal) {
      state.x = clamp(((vw / 2 - nextLeft) / state.drawW) * 100, 0, 100);
      state.y = clamp(((vh / 2 - nextTop) / state.drawH) * 100, 0, 100);
    }
  }

  function paint() {
    const e = els();
    if (!e.image || !state.naturalW || !state.naturalH) return;
    computeLayout();
    Object.assign(e.image.style, {
      width: `${state.drawW}px`, height: `${state.drawH}px`, left: `${state.left}px`, top: `${state.top}px`,
      transform: "none", objectFit: "fill", objectPosition: "50% 50%"
    });
    if (e.zoom) e.zoom.value = String(Math.round(state.zoom));
    if (e.zoomValue) e.zoomValue.textContent = `${Math.round(state.zoom)}%`;
  }

  function paintFromDrag(left, top) {
    const e = els();
    if (!e.image) return;
    computeLayout({ deriveFocal: true, left, top });
    Object.assign(e.image.style, { width:`${state.drawW}px`, height:`${state.drawH}px`, left:`${state.left}px`, top:`${state.top}px`, transform:"none" });
  }

  function resetCrop() {
    state.x = 50; state.y = 50; state.zoom = 100; paint();
  }

  async function loadImage(url) {
    const e = els();
    if (!e.image) throw new Error("Không tìm thấy vùng preview ảnh.");
    e.image.crossOrigin = /^https?:/i.test(String(url)) ? "anonymous" : "";
    e.image.src = url;
    await new Promise((resolve, reject) => {
      if (e.image.complete && e.image.naturalWidth) return resolve();
      e.image.onload = () => resolve();
      e.image.onerror = () => reject(new Error("Không tải được ảnh nguồn để căn chỉnh."));
    });
    state.naturalW = e.image.naturalWidth;
    state.naturalH = e.image.naturalHeight;
    paint();
  }

  async function open(kind, { file = null, existing = false } = {}) {
    if (!NTS.profile?.state?.user) return;
    state.kind = kind === "cover" ? "cover" : "avatar";
    state.file = file || null;
    state.naturalW = state.naturalH = 0;
    state.pointers.clear(); state.dragStart = state.pinchStart = null;
    revokeObjectUrl();
    const e = els();
    e.modal?.classList.remove("hidden");
    document.body.classList.add("profile-media-modal-open");
    state.open = true;
    e.viewport?.classList.toggle("avatar-mode", state.kind === "avatar");
    e.viewport?.classList.toggle("cover-mode", state.kind === "cover");
    if (e.viewport && state.kind === "cover") {
      const hero = document.querySelector(".v311-profile-hero")?.getBoundingClientRect();
      const ratio = hero?.width && hero?.height ? hero.width / hero.height : 16 / 7;
      e.viewport.style.aspectRatio = String(Math.max(1.8, Math.min(5, ratio)));
    } else if (e.viewport) e.viewport.style.aspectRatio = "1 / 1";
    if (e.title) e.title.textContent = state.kind === "avatar" ? "Cập nhật ảnh đại diện" : "Cập nhật ảnh bìa";
    if (e.subtitle) e.subtitle.textContent = state.kind === "avatar"
      ? "Kéo ảnh bên trong khung tròn và zoom đến khi khuôn mặt nằm đúng vùng bạn muốn."
      : "Kéo ảnh lên/xuống hoặc sang ngang để chọn đúng vùng sẽ xuất hiện trên ảnh bìa.";
    if (e.hint) e.hint.textContent = state.kind === "avatar" ? "Khung tròn là kết quả cuối cùng" : "Khung chữ nhật là kết quả cuối cùng";
    e.remove?.classList.toggle("hidden", !NTS.profile?.hasSavedMedia?.(state.kind));
    setBusy(false);

    const saved = NTS.profile?.getSavedCrop?.(state.kind) || { x:50,y:50,zoom:100 };
    state.x = clamp(file ? 50 : saved.x, 0, 100);
    state.y = clamp(file ? 50 : saved.y, 0, 100);
    state.zoom = clamp(file ? 100 : Math.max(100, saved.zoom), 100, 500);

    try {
      let url;
      if (file) {
        if (!String(file.type || "").startsWith("image/")) throw new Error("Chỉ chấp nhận file hình ảnh.");
        if (file.size > 30 * 1024 * 1024) throw new Error("Ảnh nguồn phải nhỏ hơn 30 MB.");
        state.objectUrl = URL.createObjectURL(file); url = state.objectUrl;
      } else if (existing) {
        url = await NTS.profile.getMediaSourceUrl(state.kind);
      }
      if (!url) throw new Error("Chưa có ảnh để căn chỉnh.");
      state.sourceUrl = url;
      await loadImage(url);
    } catch (error) {
      close();
      toast("Không mở được trình chỉnh ảnh", error.message || String(error), "error");
    }
  }

  function close() {
    const e = els();
    state.open = false; state.pointers.clear(); state.dragStart = state.pinchStart = null;
    e.modal?.classList.add("hidden");
    document.body.classList.remove("profile-media-modal-open");
    revokeObjectUrl();
    if (e.image) { e.image.removeAttribute("src"); e.image.style.cssText = ""; }
    const input = state.kind === "avatar" ? $("profileAvatarCameraInput") : $("profileCoverCameraInput");
    if (input) input.value = "";
  }

  function setBusy(on, text = "Đang lưu ảnh...") {
    state.saving = Boolean(on);
    const e = els();
    [e.save,e.cancel,e.close,e.reset,e.replace,e.remove,e.zoom].forEach(el => { if (el) el.disabled = Boolean(on); });
    e.loader?.classList.toggle("hidden", !on);
    if (e.loader) e.loader.querySelector("span") && (e.loader.querySelector("span").textContent = text);
    if (e.save) e.save.textContent = on ? "Đang lưu..." : "Lưu";
  }

  async function cropBlob() {
    const e = els();
    if (!e.image || !state.naturalW || !state.naturalH) throw new Error("Ảnh chưa sẵn sàng.");
    computeLayout();
    const { w: vw, h: vh } = viewportSize();
    const scale = state.drawW / state.naturalW;
    const sx = clamp(-state.left / scale, 0, state.naturalW);
    const sy = clamp(-state.top / scale, 0, state.naturalH);
    const sw = Math.min(vw / scale, state.naturalW - sx);
    const sh = Math.min(vh / scale, state.naturalH - sy);
    const outW = state.kind === "avatar" ? 1024 : 1920;
    const outH = state.kind === "avatar" ? 1024 : Math.max(360, Math.round(outW * vh / vw));
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(outW, outH) : document.createElement("canvas");
    canvas.width = outW; canvas.height = outH;
    const ctx = canvas.getContext("2d", { alpha:false, desynchronized:true });
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0,0,outW,outH);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(e.image, sx, sy, sw, sh, 0, 0, outW, outH);
    const blob = canvas.convertToBlob
      ? await canvas.convertToBlob({ type:"image/jpeg", quality: state.kind === "avatar" ? .94 : .92 })
      : await new Promise((resolve,reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error("Không tạo được ảnh crop.")), "image/jpeg", state.kind === "avatar" ? .94 : .92));
    canvas.width = canvas.height = 1;
    return blob;
  }

  async function save() {
    if (state.saving) return;
    setBusy(true, "Đang cắt và tải ảnh...");
    try {
      const blob = await cropBlob();
      await NTS.profile.saveMediaCrop(state.kind, {
        sourceFile: state.file,
        cropBlob: blob,
        crop: { x:state.x, y:state.y, zoom:state.zoom }
      });
      close();
      toast(state.kind === "avatar" ? "Đã cập nhật ảnh đại diện" : "Đã cập nhật ảnh bìa", "Ảnh đã cập nhật trên giao diện mà không cần tải lại trang.", "success");
    } catch (error) {
      console.error("profile media modal save", error);
      toast("Không lưu được ảnh", error.message || String(error), "error", 9000);
      setBusy(false);
    }
  }

  async function remove() {
    if (state.saving) return;
    const yes = await NTS.dialog?.confirm?.({
      title: state.kind === "avatar" ? "Xóa ảnh đại diện?" : "Xóa ảnh bìa?",
      message: "Ảnh hiện tại sẽ được xóa khỏi hồ sơ. Bạn có thể tải ảnh mới bất cứ lúc nào.",
      confirmText: "Xóa ảnh", danger: true
    });
    if (!yes) return;
    setBusy(true, "Đang xóa ảnh...");
    try { await NTS.profile.removeMedia(state.kind); close(); }
    catch (error) { toast("Không xóa được ảnh", error.message || String(error), "error"); setBusy(false); }
  }

  function onPointerDown(event) {
    if (!state.open || state.saving) return;
    const e = els();
    e.viewport?.setPointerCapture?.(event.pointerId);
    state.pointers.set(event.pointerId, { x:event.clientX, y:event.clientY });
    if (state.pointers.size === 1) {
      state.dragStart = { px:event.clientX, py:event.clientY, left:state.left, top:state.top };
      e.viewport?.classList.add("dragging");
    } else if (state.pointers.size === 2) {
      const pts = [...state.pointers.values()];
      state.pinchStart = { distance: Math.hypot(pts[1].x-pts[0].x, pts[1].y-pts[0].y), zoom:state.zoom };
    }
  }
  function onPointerMove(event) {
    if (!state.pointers.has(event.pointerId) || state.saving) return;
    state.pointers.set(event.pointerId, { x:event.clientX, y:event.clientY });
    if (state.pointers.size >= 2 && state.pinchStart) {
      const pts=[...state.pointers.values()];
      const distance=Math.hypot(pts[1].x-pts[0].x, pts[1].y-pts[0].y);
      if (state.pinchStart.distance > 0) {
        state.zoom = clamp(state.pinchStart.zoom * distance/state.pinchStart.distance, 100, 500); paint();
      }
      return;
    }
    if (state.pointers.size === 1 && state.dragStart) {
      paintFromDrag(state.dragStart.left + event.clientX - state.dragStart.px, state.dragStart.top + event.clientY - state.dragStart.py);
    }
  }
  function onPointerUp(event) {
    state.pointers.delete(event.pointerId);
    if (state.pointers.size < 2) state.pinchStart = null;
    if (!state.pointers.size) { state.dragStart = null; els().viewport?.classList.remove("dragging"); }
  }
  function onWheel(event) {
    if (!state.open || state.saving) return;
    event.preventDefault(); state.zoom = clamp(state.zoom + (event.deltaY < 0 ? 8 : -8), 100, 500); paint();
  }

  function bind() {
    const e=els();
    e.viewport?.addEventListener("pointerdown", onPointerDown);
    e.viewport?.addEventListener("pointermove", onPointerMove);
    e.viewport?.addEventListener("pointerup", onPointerUp);
    e.viewport?.addEventListener("pointercancel", onPointerUp);
    e.viewport?.addEventListener("wheel", onWheel, { passive:false });
    e.zoom?.addEventListener("input", ev => { state.zoom=clamp(ev.target.value,100,500); paint(); });
    e.reset?.addEventListener("click", resetCrop);
    e.cancel?.addEventListener("click", close); e.close?.addEventListener("click", close);
    e.save?.addEventListener("click", save); e.remove?.addEventListener("click", remove);
    e.replace?.addEventListener("click", () => els().fileInput?.click());
    e.modal?.addEventListener("click", ev => { if (ev.target === e.modal && !state.saving) close(); });
    document.addEventListener("keydown", ev => { if (state.open && ev.key === "Escape" && !state.saving) close(); });
    window.addEventListener("resize", () => { if (state.open) paint(); });

    $("profileAvatarCameraInput")?.addEventListener("change", ev => { const f=ev.target.files?.[0]; if (f) open("avatar", { file:f }); });
    $("profileCoverCameraInput")?.addEventListener("change", ev => { const f=ev.target.files?.[0]; if (f) open("cover", { file:f }); });
    $("profileAvatarPreview")?.addEventListener("click", ev => { if (ev.target.closest?.(".profile-camera-button")) return; if (NTS.profile?.hasSavedMedia?.("avatar")) open("avatar", { existing:true }); });
    $("profileCoverPreview")?.addEventListener("click", () => { if (NTS.profile?.hasSavedMedia?.("cover")) open("cover", { existing:true }); });
  }

  bind();
  NTS.profileMediaModal = { state, open, close, reset:resetCrop };
})();
