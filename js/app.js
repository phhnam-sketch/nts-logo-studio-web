(() => {
  "use strict";
  // V3.2: orientation-aware Smart Apply + direct-source watermark rendering + HiDPI preview + functional zoom/Fit.

  const $ = (id) => document.getElementById(id);
  const toast = (title, message, kind = "info", duration) => window.NTS?.showToast?.(title, message, kind, duration);

  const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
  const COARSE_POINTER = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
  const IS_MOBILE = MOBILE_UA || (COARSE_POINTER && Math.min(window.innerWidth, window.innerHeight) < 1100);
  const MOBILE_MAX_PIXELS = 16_000_000;
  const MOBILE_SHARE_MAX_FILES = 8;
  const MOBILE_ZIP_MAX_INPUT = 40 * 1024 ** 2;
  const DESKTOP_ZIP_MAX_INPUT = 280 * 1024 ** 2;

  function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(message || "Tác vụ mất quá nhiều thời gian.")), ms);
    });
    return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
  }

  function safeLocalGet(key) {
    try { return window.localStorage?.getItem(key) ?? null; } catch (_) { return null; }
  }

  function cleanupSurface(surface) {
    try {
      if (surface && "width" in surface) surface.width = 1;
      if (surface && "height" in surface) surface.height = 1;
    } catch (_) {}
  }

  const state = {
    images: [],
    selectedId: null,
    exporting: false,
    cancelExport: false,
    currentBitmap: null,
    currentBitmapId: null,
    logoFile: null,
    logoBitmap: null,
    logoUrl: null,
    split: 50,
    compareEnabled: true,
    renderToken: 0,
    renderRaf: 0,
    previewZoom: 1,
    lastFitScale: 1,
    forcePng: safeLocalGet("nts-export-lossless") === "1",
    settings: {
      pos: "SE",
      opacity: 92,
      size: 18,
      padding: 28,
      offsetX: 0,
      offsetY: 0,
      rotation: 0,
      keepInside: true,
      paddingRatio: null,
      offsetXRatio: null,
      offsetYRatio: null,
      referenceWidth: null,
      referenceHeight: null,
      referenceShortSide: null
    }
  };

  const els = {
    imageInput: $("imageInput"),
    logoInput: $("logoInput"),
    dropZone: $("dropZone"),
    imageList: $("imageList"),
    imageSearch: $("imageSearch"),
    imageCount: $("imageCount"),
    clearImages: $("clearImages"),
    selectAllImages: $("selectAllImages"),
    clearSelection: $("clearSelection"),
    selectedCount: $("selectedCount"),
    previewMeta: $("previewMeta"),
    previewStage: $("previewStage"),
    previewEmpty: $("previewEmpty"),
    compareFrame: $("compareFrame"),
    afterCanvas: $("afterCanvas"),
    beforeCanvas: $("beforeCanvas"),
    beforeClip: $("beforeClip"),
    splitDivider: $("splitDivider"),
    compareToggle: $("compareToggle"),
    fitPreview: $("fitPreview"),
    zoomOutPreview: $("zoomOutPreview"),
    zoomInPreview: $("zoomInPreview"),
    actualSizePreview: $("actualSizePreview"),
    previewZoomLabel: $("previewZoomLabel"),
    previewHud: $("previewHud"),
    previewHudText: $("previewHudText"),
    selectedImageStatus: $("selectedImageStatus"),
    logoPreviewBox: $("logoPreviewBox"),
    logoFileName: $("logoFileName"),
    logoQualityStatus: $("logoQualityStatus"),
    positionGrid: $("positionGrid"),
    opacityRange: $("opacityRange"),
    sizeRange: $("sizeRange"),
    paddingRange: $("paddingRange"),
    offsetXRange: $("offsetXRange"),
    offsetYRange: $("offsetYRange"),
    rotationRange: $("rotationRange"),
    opacityValue: $("opacityValue"),
    sizeValue: $("sizeValue"),
    paddingValue: $("paddingValue"),
    offsetXValue: $("offsetXValue"),
    offsetYValue: $("offsetYValue"),
    rotationValue: $("rotationValue"),
    keepInsideToggle: $("keepInsideToggle"),
    losslessExportToggle: $("losslessExportToggle"),
    resetTransform: $("resetTransform"),
    applySelectedButton: $("applySelectedButton"),
    applyAllButton: $("applyAllButton"),
    exportSelectedButton: $("exportSelectedButton"),
    exportAllButton: $("exportAllButton"),
    exportCurrentButton: $("exportCurrentButton"),
    cancelExportButton: $("cancelExportButton"),
    exportSelectionBadge: $("exportSelectionBadge"),
    batchProgressBar: $("batchProgressBar"),
    batchProgressText: $("batchProgressText"),
    mobileExportHint: $("mobileExportHint"),
    libraryPanel: $("libraryPanel"),
    settingsPanel: $("settingsPanel"),
    mobileLibraryToggle: $("mobileLibraryToggle"),
    mobileSettingsToggle: $("mobileSettingsToggle"),
    mobileSettingsClose: $("mobileSettingsClose")
  };

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** index);
    return `${value.toFixed(index === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[index]}`;
  }

  function uniqueId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function cloneSettings(settings = state.settings) {
    return { ...settings };
  }

  function currentItem() {
    return state.images.find((image) => image.id === state.selectedId) || null;
  }

  function selectedItems() {
    return state.images.filter((image) => image.selected);
  }

  function validDimension(value) {
    return Number.isFinite(Number(value)) && Number(value) > 0;
  }

  function captureRelativeSettings(settings = state.settings, item = currentItem()) {
    const out = cloneSettings(settings);
    const width = Number(item?.width || (state.currentBitmapId === item?.id ? state.currentBitmap?.width : 0));
    const height = Number(item?.height || (state.currentBitmapId === item?.id ? state.currentBitmap?.height : 0));
    if (validDimension(width) && validDimension(height)) {
      const shortSide = Math.min(width, height);
      out.paddingRatio = Number(out.padding || 0) / shortSide;
      out.offsetXRatio = Number(out.offsetX || 0) / width;
      out.offsetYRatio = Number(out.offsetY || 0) / height;
      out.referenceWidth = width;
      out.referenceHeight = height;
      out.referenceShortSide = shortSide;
    }
    return out;
  }

  function materializeSettings(settings, width, height) {
    const out = cloneSettings(settings);
    if (!validDimension(width) || !validDimension(height)) return out;
    const shortSide = Math.min(width, height);
    if (Number.isFinite(Number(out.paddingRatio))) out.padding = Math.round(Number(out.paddingRatio) * shortSide);
    else if (validDimension(out.referenceShortSide)) out.padding = Math.round(Number(out.padding || 0) * shortSide / Number(out.referenceShortSide));
    if (Number.isFinite(Number(out.offsetXRatio))) out.offsetX = Math.round(Number(out.offsetXRatio) * width);
    else if (validDimension(out.referenceWidth)) out.offsetX = Math.round(Number(out.offsetX || 0) * width / Number(out.referenceWidth));
    if (Number.isFinite(Number(out.offsetYRatio))) out.offsetY = Math.round(Number(out.offsetYRatio) * height);
    else if (validDimension(out.referenceHeight)) out.offsetY = Math.round(Number(out.offsetY || 0) * height / Number(out.referenceHeight));
    out.referenceWidth = width;
    out.referenceHeight = height;
    out.referenceShortSide = shortSide;
    return out;
  }

  function updateCurrentItemSettings() {
    const item = currentItem();
    if (item) item.settings = captureRelativeSettings(state.settings, item);
  }

  function syncSettingsControls() {
    if (!els.opacityRange) return;
    els.opacityRange.value = String(state.settings.opacity);
    els.sizeRange.value = String(state.settings.size);
    els.paddingRange.value = String(state.settings.padding);
    els.offsetXRange.value = String(state.settings.offsetX);
    els.offsetYRange.value = String(state.settings.offsetY);
    els.rotationRange.value = String(state.settings.rotation);
    els.keepInsideToggle.checked = Boolean(state.settings.keepInside);
    els.positionGrid.querySelectorAll("button[data-pos]").forEach((b) => b.classList.toggle("active", b.dataset.pos === state.settings.pos));
    syncControlLabels();
  }

  function setSettings(settings, item = currentItem()) {
    let next = cloneSettings(settings);
    if (item && validDimension(item.width) && validDimension(item.height)) next = materializeSettings(next, item.width, item.height);
    state.settings = next;
    syncSettingsControls();
  }

  function setBatchProgress(done, total, text) {
    const pct = total ? Math.round(done / total * 100) : 0;
    els.batchProgressBar.style.width = `${pct}%`;
    els.batchProgressText.textContent = text || (total ? `${done}/${total} ảnh` : "Sẵn sàng xuất.");
  }

  function yieldToUi() {
    return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }

  function isImageFile(file) {
    return file && file.type && file.type.startsWith("image/");
  }

  function addImages(fileList) {
    const incoming = Array.from(fileList || []).filter(isImageFile);
    if (!incoming.length) {
      toast("Không có ảnh hợp lệ", "Hãy chọn JPG, PNG, WebP hoặc định dạng ảnh mà trình duyệt hỗ trợ.", "warning");
      return;
    }

    const seen = new Set(state.images.map((item) => `${item.file.name}|${item.file.size}|${item.file.lastModified}`));
    let added = 0;
    for (const file of incoming) {
      const key = `${file.name}|${file.size}|${file.lastModified}`;
      if (seen.has(key)) continue;
      seen.add(key);
      state.images.push({
        id: uniqueId(), file, url: URL.createObjectURL(file),
        width: null, height: null,
        selected: true, status: "ready", error: "", settings: cloneSettings()
      });
      added += 1;
    }

    if (!state.selectedId && state.images.length) state.selectedId = state.images[0].id;
    renderImageList();
    schedulePreview();
    if (added) toast("Đã thêm ảnh", `${added} ảnh đã được đưa vào thư viện.`, "success");
  }

  function renderImageList() {
    const term = els.imageSearch.value.trim().toLowerCase();
    const filtered = state.images.filter((item) => item.file.name.toLowerCase().includes(term));
    const selected = selectedItems().length;
    els.imageCount.textContent = `${state.images.length} ảnh`;
    els.selectedCount.textContent = String(selected);
    els.exportSelectionBadge.textContent = `${selected} ảnh`;
    els.selectedImageStatus.textContent = `${selected}/${state.images.length} đã chọn`;
    els.exportSelectedButton.disabled = state.exporting || selected === 0;
    els.exportAllButton.disabled = state.exporting || state.images.length === 0;
    els.exportCurrentButton.disabled = state.exporting || !state.selectedId;

    if (!filtered.length) {
      els.imageList.innerHTML = `
        <div class="empty-list-state">
          <div class="empty-icon">▧</div>
          <strong>${state.images.length ? "Không tìm thấy ảnh" : "Chưa có ảnh"}</strong>
          <p>${state.images.length ? "Thử từ khóa khác." : "Thêm ảnh để bắt đầu preview."}</p>
        </div>`;
      return;
    }

    const statusLabel = {
      ready: ["●", "Sẵn sàng"], processing: ["…", "Đang xử lý"], done: ["✓", "Đã xuất"],
      error: ["!", "Lỗi"], cancelled: ["×", "Đã dừng"]
    };
    const frag = document.createDocumentFragment();
    for (const item of filtered) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `image-item${item.id === state.selectedId ? " active" : ""}${item.selected ? " batch-selected" : ""}`;
      button.dataset.id = item.id;

      const checkbox = document.createElement("span");
      checkbox.className = `image-select-box${item.selected ? " checked" : ""}`;
      checkbox.textContent = item.selected ? "✓" : "";
      checkbox.setAttribute("role", "checkbox");
      checkbox.setAttribute("aria-checked", String(Boolean(item.selected)));
      checkbox.setAttribute("aria-label", `Chọn ${item.file.name} để xuất`);
      checkbox.dataset.selectId = item.id;

      const img = document.createElement("img");
      img.className = "image-thumb";
      img.src = item.url;
      img.alt = "";
      img.loading = "lazy";

      const copy = document.createElement("span");
      copy.className = "image-item-copy";
      const strong = document.createElement("strong");
      strong.textContent = item.file.name;
      const meta = document.createElement("span");
      const statusText = statusLabel[item.status]?.[1] || "Sẵn sàng";
      meta.textContent = `${formatBytes(item.file.size)} · ${statusText}`;
      if (item.error) meta.title = item.error;
      copy.append(strong, meta);

      const status = document.createElement("span");
      status.className = `image-job-status ${item.status || "ready"}`;
      status.textContent = statusLabel[item.status]?.[0] || "●";
      status.title = statusText;

      button.append(checkbox, img, copy, status);
      frag.append(button);
    }
    els.imageList.replaceChildren(frag);
  }

  function selectImage(id) {
    if (id === state.selectedId) return;
    state.selectedId = id;
    state.previewZoom = 1;
    const item = currentItem();
    if (item?.settings) setSettings(item.settings, item);
    renderImageList();
    schedulePreview(true);
  }

  function toggleBatchSelection(id, checked) {
    const item = state.images.find((image) => image.id === id);
    if (!item) return;
    item.selected = checked;
    renderImageList();
  }

  async function ensureCurrentBitmap(token) {
    const item = state.images.find((image) => image.id === state.selectedId);
    if (!item) return null;
    if (state.currentBitmap && state.currentBitmapId === item.id) return { item, bitmap: state.currentBitmap };

    const bitmap = await createImageBitmap(item.file, { imageOrientation: "from-image" }).catch(() => createImageBitmap(item.file));
    if (token !== state.renderToken) {
      bitmap.close?.();
      return null;
    }
    state.currentBitmap?.close?.();
    state.currentBitmap = bitmap;
    state.currentBitmapId = item.id;
    item.width = bitmap.width;
    item.height = bitmap.height;
    if (item.settings) {
      item.settings = materializeSettings(item.settings, bitmap.width, bitmap.height);
      if (state.selectedId === item.id) {
        state.settings = cloneSettings(item.settings);
        syncSettingsControls();
      }
    }
    return { item, bitmap };
  }

  async function ensureLogoBitmap() {
    if (!state.logoFile) return null;
    if (state.logoBitmap) return state.logoBitmap;
    state.logoBitmap = await createImageBitmap(state.logoFile, { imageOrientation: "from-image" }).catch(() => createImageBitmap(state.logoFile));
    return state.logoBitmap;
  }

  function showHud(text) {
    els.previewHudText.textContent = text;
    els.previewHud.classList.remove("hidden");
  }

  function hideHud() {
    els.previewHud.classList.add("hidden");
  }

  function setupCanvas(canvas, cssWidth, cssHeight) {
    // V3.2: keep preview crisp on Retina/HiDPI without exploding canvas memory.
    const rawDpr = Math.max(1, Number(window.devicePixelRatio || 1));
    const dprCap = IS_MOBILE ? 2 : 2.5;
    const dpr = Math.min(rawDpr, dprCap);
    const pixelW = Math.max(1, Math.round(cssWidth * dpr));
    const pixelH = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
    }
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    const ctx = canvas.getContext("2d", { alpha: true });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    return ctx;
  }

  function containRect(srcW, srcH, boxW, boxH, padding = 22) {
    const availableW = Math.max(1, boxW - padding * 2);
    const availableH = Math.max(1, boxH - padding * 2);
    const scale = Math.min(availableW / srcW, availableH / srcH);
    const w = Math.max(1, srcW * scale);
    const h = Math.max(1, srcH * scale);
    return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h, scale };
  }

  function previewRect(srcW, srcH, boxW, boxH, padding = 22) {
    const fit = containRect(srcW, srcH, boxW, boxH, padding);
    state.lastFitScale = fit.scale;
    const zoom = Math.max(1, Math.min(8, Number(state.previewZoom) || 1));
    const w = fit.w * zoom;
    const h = fit.h * zoom;
    return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h, scale: fit.scale * zoom, fitScale: fit.scale, zoom };
  }

  function updateZoomUi() {
    const z = Math.max(1, Number(state.previewZoom) || 1);
    if (els.previewZoomLabel) els.previewZoomLabel.textContent = z === 1 ? "FIT" : `${Math.round(z * 100)}%`;
    if (els.fitPreview) els.fitPreview.classList.toggle("active", z === 1);
  }

  function createSurface(width, height) {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(width));
    c.height = Math.max(1, Math.ceil(height));
    return c;
  }

  function watermarkGeometry(logo, targetShortSide, rotationDeg, settings = state.settings) {
    const ratio = Number(settings.size || 0) / 100;
    let w, h;
    if (logo.width >= logo.height) {
      w = targetShortSide * ratio;
      h = w * (logo.height / logo.width);
    } else {
      h = targetShortSide * ratio;
      w = h * (logo.width / logo.height);
    }
    w = Math.max(1, w); h = Math.max(1, h);
    const rad = Number(rotationDeg || 0) * Math.PI / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    return {
      w, h, rad,
      width: Math.max(1, w * cos + h * sin),
      height: Math.max(1, w * sin + h * cos)
    };
  }

  function logoQualityMessage(logo, item = currentItem()) {
    if (!logo) return { kind: "info", title: "Chất lượng logo", text: "Chọn PNG/WebP nền trong suốt từ 1000 px trở lên để xuất nét nhất." };
    const longSide = Math.max(Number(logo.width || 0), Number(logo.height || 0));
    let targetLong = 0;
    if (item && validDimension(item.width) && validDimension(item.height)) {
      const short = Math.min(item.width, item.height);
      const ratio = Number(state.settings.size || 0) / 100;
      targetLong = short * ratio;
    }
    if (longSide < 600 || (targetLong && targetLong > longSide * 1.25)) {
      return { kind: "warning", title: `${logo.width}×${logo.height}px`, text: "Logo nguồn hơi nhỏ so với kích thước gắn. Hãy dùng PNG/WebP lớn hơn để tránh phải phóng ảnh logo." };
    }
    return { kind: "good", title: `${logo.width}×${logo.height}px · nguồn tốt`, text: "HiDPI preview + render trực tiếp từ logo nguồn đang bật. Export tránh resample hai lần để giữ nét tốt hơn." };
  }

  function renderLogoQuality(logo) {
    const el = els.logoQualityStatus; if (!el) return;
    const info = logoQualityMessage(logo);
    el.dataset.kind = info.kind;
    const strong = el.querySelector("strong"), small = el.querySelector("small");
    if (strong) strong.textContent = info.title;
    if (small) small.textContent = info.text;
  }

  function watermarkPosition(imgX, imgY, imgW, imgH, logoW, logoH, scaleFromSource, settings = state.settings) {
    const s = settings;
    const padding = s.padding * scaleFromSource;
    const offsetX = s.offsetX * scaleFromSource;
    const offsetY = s.offsetY * scaleFromSource;
    let x = imgX + (imgW - logoW) / 2;
    let y = imgY + (imgH - logoH) / 2;

    if (s.pos.includes("W")) x = imgX + padding;
    else if (s.pos.includes("E")) x = imgX + imgW - logoW - padding;
    if (s.pos.includes("N")) y = imgY + padding;
    else if (s.pos.includes("S")) y = imgY + imgH - logoH - padding;

    x += offsetX;
    y += offsetY;

    if (s.keepInside) {
      x = Math.min(Math.max(x, imgX), imgX + imgW - logoW);
      y = Math.min(Math.max(y, imgY), imgY + imgH - logoH);
    }
    return { x, y };
  }

  function drawWatermarkDirect(ctx, logo, imgRect, targetShortSide, scaleFromSource, settings = state.settings) {
    const g = watermarkGeometry(logo, targetShortSide, settings.rotation, settings);
    const pos = watermarkPosition(imgRect.x, imgRect.y, imgRect.w, imgRect.h, g.width, g.height, scaleFromSource, settings);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.globalAlpha = Math.max(0, Math.min(1, Number(settings.opacity || 0) / 100));
    ctx.translate(pos.x + g.width / 2, pos.y + g.height / 2);
    ctx.rotate(g.rad);
    // Draw from the original logo bitmap straight to the destination canvas.
    // Avoiding an intermediate resized raster prevents the extra resampling pass
    // that made text/logomarks look soft, especially on high-resolution exports.
    ctx.drawImage(logo, -g.w / 2, -g.h / 2, g.w, g.h);
    ctx.restore();
    return { x: pos.x, y: pos.y, width: g.width, height: g.height };
  }

  function drawBase(ctx, bitmap, rect) {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.fillStyle = "#120d0f";
    ctx.fillRect(0, 0, parseFloat(ctx.canvas.style?.width || ctx.canvas.width), parseFloat(ctx.canvas.style?.height || ctx.canvas.height));
    ctx.drawImage(bitmap, rect.x, rect.y, rect.w, rect.h);
  }

  async function renderPreviewNow() {
    const token = ++state.renderToken;
    window.cancelAnimationFrame(state.renderRaf);
    const item = state.images.find((image) => image.id === state.selectedId);
    if (!item) {
      state.currentBitmap?.close?.();
      state.currentBitmap = null;
      state.currentBitmapId = null;
      els.previewEmpty.classList.remove("hidden");
      els.compareFrame.classList.add("hidden");
      els.previewMeta.textContent = "Chưa có ảnh được chọn";
      hideHud();
      return;
    }

    showHud("Đang dựng preview...");
    try {
      const current = await ensureCurrentBitmap(token);
      if (!current || token !== state.renderToken) return;
      const logo = await ensureLogoBitmap();
      if (token !== state.renderToken) return;

      const frameW = Math.max(320, els.previewStage.clientWidth);
      const frameH = Math.max(260, els.previewStage.clientHeight);
      const beforeCtx = setupCanvas(els.beforeCanvas, frameW, frameH);
      const afterCtx = setupCanvas(els.afterCanvas, frameW, frameH);
      const rect = previewRect(current.bitmap.width, current.bitmap.height, frameW, frameH, frameW < 600 ? 10 : 22);
      const renderSettings = materializeSettings(state.settings, current.bitmap.width, current.bitmap.height);

      drawBase(beforeCtx, current.bitmap, rect);
      drawBase(afterCtx, current.bitmap, rect);

      if (logo) {
        drawWatermarkDirect(afterCtx, logo, rect, Math.min(rect.w, rect.h), rect.scale, renderSettings);
        renderLogoQuality(logo);
      }
      updateZoomUi();

      els.beforeCanvas.style.width = `${frameW}px`;
      els.beforeCanvas.style.height = `${frameH}px`;
      els.afterCanvas.style.width = `${frameW}px`;
      els.afterCanvas.style.height = `${frameH}px`;
      els.previewEmpty.classList.add("hidden");
      els.compareFrame.classList.remove("hidden");
      applySplit();
      els.previewMeta.textContent = `${current.item.file.name} · ${current.bitmap.width}×${current.bitmap.height} · ${formatBytes(current.item.file.size)}`;
    } catch (error) {
      console.error(error);
      toast("Không thể preview", "Ảnh này có thể dùng định dạng mà trình duyệt chưa hỗ trợ.", "error");
    } finally {
      if (token === state.renderToken) hideHud();
    }
  }

  function schedulePreview(immediate = false) {
    window.cancelAnimationFrame(state.renderRaf);
    if (immediate) {
      renderPreviewNow();
      return;
    }
    state.renderRaf = window.requestAnimationFrame(() => {
      window.clearTimeout(schedulePreview.timer);
      schedulePreview.timer = window.setTimeout(renderPreviewNow, 70);
    });
  }

  function applySplit() {
    const split = state.compareEnabled ? state.split : 0;
    els.beforeClip.style.width = `${split}%`;
    els.splitDivider.style.left = `${split}%`;
    els.splitDivider.classList.toggle("hidden", !state.compareEnabled);
    document.querySelectorAll(".compare-badge").forEach((el) => el.classList.toggle("hidden", !state.compareEnabled));
    els.splitDivider.setAttribute("aria-valuenow", String(Math.round(split)));
    els.compareToggle.classList.toggle("active", state.compareEnabled);
  }

  function setSplitFromClientX(clientX) {
    const rect = els.compareFrame.getBoundingClientRect();
    if (!rect.width) return;
    state.split = Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100));
    applySplit();
  }

  let draggingSplit = false;
  els.compareFrame.addEventListener("pointerdown", (event) => {
    if (!state.compareEnabled) return;
    draggingSplit = true;
    els.compareFrame.setPointerCapture?.(event.pointerId);
    setSplitFromClientX(event.clientX);
  });
  els.compareFrame.addEventListener("pointermove", (event) => {
    if (!draggingSplit) return;
    setSplitFromClientX(event.clientX);
  });
  els.compareFrame.addEventListener("pointerup", () => { draggingSplit = false; });
  els.compareFrame.addEventListener("pointercancel", () => { draggingSplit = false; });
  els.splitDivider.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      state.split = Math.min(100, Math.max(0, state.split + (event.key === "ArrowRight" ? 2 : -2)));
      applySplit();
    }
  });

  els.compareToggle.addEventListener("click", () => {
    state.compareEnabled = !state.compareEnabled;
    applySplit();
  });

  function syncControlLabels() {
    els.opacityValue.textContent = `${state.settings.opacity}%`;
    els.sizeValue.textContent = `${state.settings.size}%`;
    els.paddingValue.textContent = `${state.settings.padding} px`;
    els.offsetXValue.textContent = `${state.settings.offsetX} px`;
    els.offsetYValue.textContent = `${state.settings.offsetY} px`;
    els.rotationValue.textContent = `${state.settings.rotation}°`;
  }

  function bindRange(input, key) {
    input.addEventListener("input", () => {
      state.settings[key] = Number(input.value);
      updateCurrentItemSettings();
      syncControlLabels();
      schedulePreview();
    });
  }

  bindRange(els.opacityRange, "opacity");
  bindRange(els.sizeRange, "size");
  bindRange(els.paddingRange, "padding");
  bindRange(els.offsetXRange, "offsetX");
  bindRange(els.offsetYRange, "offsetY");
  bindRange(els.rotationRange, "rotation");

  els.keepInsideToggle.addEventListener("change", () => {
    state.settings.keepInside = els.keepInsideToggle.checked;
    updateCurrentItemSettings();
    schedulePreview();
  });

  els.positionGrid.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-pos]");
    if (!button) return;
    state.settings.pos = button.dataset.pos;
    updateCurrentItemSettings();
    els.positionGrid.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === button));
    schedulePreview();
  });

  document.querySelectorAll("[data-angle]").forEach((button) => {
    button.addEventListener("click", () => {
      state.settings.rotation = Number(button.dataset.angle);
      updateCurrentItemSettings();
      els.rotationRange.value = String(state.settings.rotation);
      syncControlLabels();
      schedulePreview();
    });
  });

  els.resetTransform.addEventListener("click", () => {
    state.settings.offsetX = 0;
    state.settings.offsetY = 0;
    state.settings.rotation = 0;
    updateCurrentItemSettings();
    els.offsetXRange.value = "0";
    els.offsetYRange.value = "0";
    els.rotationRange.value = "0";
    syncControlLabels();
    schedulePreview();
    toast("Đã reset transform", "X, Y và góc xoay đã trở về mặc định.", "success");
  });

  els.imageInput.addEventListener("change", () => {
    addImages(els.imageInput.files);
    els.imageInput.value = "";
  });

  ["dragenter", "dragover"].forEach((name) => els.dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    els.dropZone.classList.add("dragover");
  }));
  ["dragleave", "drop"].forEach((name) => els.dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    els.dropZone.classList.remove("dragover");
  }));
  els.dropZone.addEventListener("drop", (event) => addImages(event.dataTransfer.files));

  els.imageList.addEventListener("click", (event) => {
    const checkbox = event.target.closest(".image-select-box");
    if (checkbox) {
      event.stopPropagation();
      const target = state.images.find((image) => image.id === checkbox.dataset.selectId);
      toggleBatchSelection(checkbox.dataset.selectId, !target?.selected);
      return;
    }
    const item = event.target.closest(".image-item");
    if (item) selectImage(item.dataset.id);
  });
  els.imageSearch.addEventListener("input", renderImageList);

  els.selectAllImages.addEventListener("click", () => {
    state.images.forEach((item) => { item.selected = true; });
    renderImageList();
    toast("Đã chọn tất cả", `${state.images.length} ảnh đã sẵn sàng để xuất.`, "success");
  });

  els.clearSelection.addEventListener("click", () => {
    state.images.forEach((item) => { item.selected = false; });
    renderImageList();
    toast("Đã bỏ chọn", "Không còn ảnh nào trong hàng đợi xuất.", "info");
  });

  els.clearImages.addEventListener("click", () => {
    if (!state.images.length || state.exporting) return;
    for (const item of state.images) URL.revokeObjectURL(item.url);
    state.images = [];
    state.selectedId = null;
    state.currentBitmap?.close?.();
    state.currentBitmap = null;
    state.currentBitmapId = null;
    renderImageList();
    schedulePreview(true);
    toast("Đã dọn thư viện", "Danh sách ảnh trong phiên hiện tại đã được xóa.", "success");
  });

  els.logoInput.addEventListener("change", async () => {
    const file = els.logoInput.files?.[0];
    if (!file) return;
    if (!isImageFile(file)) {
      toast("Logo không hợp lệ", "Hãy dùng PNG, WebP hoặc JPEG.", "warning");
      return;
    }
    state.logoBitmap?.close?.();
    state.logoBitmap = null;
    if (state.logoUrl) URL.revokeObjectURL(state.logoUrl);
    state.logoFile = file;
    state.logoUrl = URL.createObjectURL(file);
    els.logoFileName.textContent = file.name;
    const img = document.createElement("img");
    img.src = state.logoUrl;
    img.alt = "Logo đã chọn";
    els.logoPreviewBox.replaceChildren(img);
    try {
      const logo = await ensureLogoBitmap();
      renderLogoQuality(logo);
      const quality = logoQualityMessage(logo);
      toast(quality.kind === "warning" ? "Logo cần độ phân giải cao hơn" : "Logo đã sẵn sàng", quality.text, quality.kind === "warning" ? "warning" : "success", 5600);
    } catch (_) { renderLogoQuality(null); }
    schedulePreview(true);
  });

  els.fitPreview.addEventListener("click", () => {
    state.previewZoom = 1;
    updateZoomUi();
    schedulePreview(true);
    toast("Đã vừa khung", "Preview đã trở về chế độ Fit và căn giữa toàn bộ ảnh.", "success", 2600);
  });
  els.zoomInPreview?.addEventListener("click", () => { state.previewZoom = Math.min(8, state.previewZoom * 1.25); updateZoomUi(); schedulePreview(true); });
  els.zoomOutPreview?.addEventListener("click", () => { state.previewZoom = Math.max(1, state.previewZoom / 1.25); updateZoomUi(); schedulePreview(true); });
  els.actualSizePreview?.addEventListener("click", () => {
    const fitScale = Number(state.lastFitScale) || 1;
    state.previewZoom = Math.max(1, Math.min(8, 1 / fitScale));
    updateZoomUi();
    schedulePreview(true);
  });

  function flashButton(button, text) {
    const old = button.textContent;
    button.textContent = text;
    button.disabled = true;
    window.setTimeout(() => {
      button.textContent = old;
      if (!state.exporting) button.disabled = false;
      renderImageList();
    }, 1300);
  }

  function applySettingsTo(items, label) {
    if (!items.length) {
      toast("Chưa có ảnh", "Hãy chọn ảnh trước khi áp dụng cấu hình.", "warning");
      return;
    }
    const master = currentItem();
    const snapshot = captureRelativeSettings(state.settings, master);
    items.forEach((item) => {
      item.settings = validDimension(item.width) && validDimension(item.height)
        ? materializeSettings(snapshot, item.width, item.height)
        : cloneSettings(snapshot);
    });
    if (master) master.settings = materializeSettings(snapshot, master.width || snapshot.referenceWidth, master.height || snapshot.referenceHeight);
    toast("Smart Apply hoàn tất", `${items.length} ảnh đã được đồng bộ theo tỷ lệ riêng của từng khung ngang/dọc. X/Y theo chiều ảnh, lề theo cạnh ngắn.`, "success", 5600);
    label?.();
  }

  els.applySelectedButton.addEventListener("click", () => {
    const items = selectedItems();
    applySettingsTo(items, () => flashButton(els.applySelectedButton, `✓ ${items.length} ẢNH`));
  });

  els.applyAllButton.addEventListener("click", () => {
    applySettingsTo(state.images, () => flashButton(els.applyAllButton, `✓ ${state.images.length} ẢNH`));
  });

  async function canvasToBlob(surface, mime, quality) {
    const work = surface.convertToBlob
      ? surface.convertToBlob({ type: mime, quality })
      : new Promise((resolve, reject) => surface.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Không tạo được file ảnh.")), mime, quality));
    return withTimeout(work, IS_MOBILE ? 30000 : 60000, "Điện thoại mất quá lâu khi mã hóa ảnh. Hãy thử ít ảnh hơn hoặc ảnh có độ phân giải thấp hơn.");
  }

  function outputSpec(item) {
    const name = item.file.name;
    const stem = name.replace(/\.[^.]+$/, "");
    if (state.forcePng) return { mime: "image/png", ext: "png", quality: 1, name: `${stem}_watermarked.png` };
    if (/jpe?g$/i.test(name) || item.file.type === "image/jpeg") return { mime: "image/jpeg", ext: "jpg", quality: .995, name: `${stem}_watermarked.jpg` };
    if (/webp$/i.test(name) || item.file.type === "image/webp") return { mime: "image/webp", ext: "webp", quality: .99, name: `${stem}_watermarked.webp` };
    return { mime: "image/png", ext: "png", quality: 1, name: `${stem}_watermarked.png` };
  }

  async function renderExportBlob(item) {
    let bitmap = null;
    let surface = null;
    try {
      bitmap = await withTimeout(
        createImageBitmap(item.file, { imageOrientation: "from-image" }).catch(() => createImageBitmap(item.file)),
        IS_MOBILE ? 20000 : 45000,
        `Không thể giải mã ${item.file.name} đủ nhanh trên thiết bị này.`
      );
      const pixels = bitmap.width * bitmap.height;
      const rawRam = Number(navigator.deviceMemory);
      const ramGb = Number.isFinite(rawRam) && rawRam > 0 ? rawRam : (IS_MOBILE ? 3 : 8);
      const maxPixels = IS_MOBILE ? MOBILE_MAX_PIXELS : (ramGb <= 4 ? 45_000_000 : 90_000_000);
      if (pixels > maxPixels) {
        const mp = Math.round(pixels / 1e6);
        const limitMp = Math.round(maxPixels / 1e6);
        throw new Error(`Ảnh ${item.file.name} là ${mp} MP. Mobile Safe hiện giới hạn khoảng ${limitMp} MP để tránh treo trình duyệt. Hãy giảm độ phân giải ảnh hoặc xuất trên máy tính.`);
      }
      const logo = await ensureLogoBitmap();
      if (!logo) throw new Error("Chưa chọn logo.");
      item.width = bitmap.width;
      item.height = bitmap.height;
      const settings = materializeSettings(item.settings ? cloneSettings(item.settings) : cloneSettings(), bitmap.width, bitmap.height);
      item.settings = cloneSettings(settings);
      surface = createSurface(bitmap.width, bitmap.height);
      const ctx = surface.getContext("2d", { alpha: true, desynchronized: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0);
      drawWatermarkDirect(
        ctx, logo,
        { x: 0, y: 0, w: bitmap.width, h: bitmap.height },
        Math.min(bitmap.width, bitmap.height),
        1, settings
      );
      const spec = outputSpec(item);
      const blob = await canvasToBlob(surface, spec.mime, spec.quality);
      if (!blob || blob.size === 0) throw new Error("Trình duyệt tạo ra file ảnh rỗng.");
      return { blob, fileName: spec.name };
    } finally {
      bitmap?.close?.();
      cleanupSurface(surface);
    }
  }

  function uniqueOutputName(name, used) {
    const lower = name.toLowerCase();
    if (!used.has(lower)) { used.add(lower); return name; }
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let i = 2;
    let candidate;
    do { candidate = `${stem}_${i++}${ext}`; } while (used.has(candidate.toLowerCase()));
    used.add(candidate.toLowerCase());
    return candidate;
  }

  async function saveBlobToDirectory(dirHandle, fileName, blob) {
    const handle = await dirHandle.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    try { await writable.write(blob); } finally { await writable.close(); }
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function blobAsFile(blob, fileName) {
    return new File([blob], fileName, { type: blob.type || "image/jpeg", lastModified: Date.now() });
  }

  function canNativeShareFiles(files) {
    try {
      return Boolean(navigator.share && navigator.canShare && files?.length && navigator.canShare({ files }));
    } catch (_) {
      return false;
    }
  }

  async function shareFilesNative(files, title = "NTS Logo Studio") {
    if (!canNativeShareFiles(files)) return false;
    await navigator.share({ files, title });
    return true;
  }

  function setExportUi(running) {
    state.exporting = running;
    els.cancelExportButton.classList.toggle("hidden", !running);
    els.applySelectedButton.disabled = running;
    els.applyAllButton.disabled = running;
    els.clearImages.disabled = running;
    els.selectAllImages.disabled = running;
    els.clearSelection.disabled = running;
    renderImageList();
  }

  async function exportMobileShareBatch(items, label) {
    if (items.length > MOBILE_SHARE_MAX_FILES) {
      throw new Error(`Trên điện thoại, hãy chọn tối đa ${MOBILE_SHARE_MAX_FILES} ảnh mỗi lần để lưu vào Photos/Gallery ổn định. Với lô lớn hơn, hãy chia thành nhiều lượt hoặc dùng máy tính.`);
    }
    const files = [];
    const usedNames = new Set();
    let done = 0;
    for (let index = 0; index < items.length; index += 1) {
      if (state.cancelExport) break;
      const item = items[index];
      item.status = "processing";
      item.error = "";
      renderImageList();
      setBatchProgress(index, items.length, `Mobile Safe ${index + 1}/${items.length} · ${item.file.name}`);
      showHud(`Mobile ${index + 1}/${items.length} · ${item.file.name}`);
      await yieldToUi();
      try {
        const { blob, fileName } = await renderExportBlob(item);
        const safeName = uniqueOutputName(fileName, usedNames);
        files.push(blobAsFile(blob, safeName));
        item.status = "done";
        done += 1;
      } catch (error) {
        item.status = "error";
        item.error = error?.message || String(error);
        throw error;
      } finally {
        renderImageList();
        await yieldToUi();
      }
    }
    if (!files.length) return;
    if (!canNativeShareFiles(files)) {
      throw new Error("Trình duyệt này không hỗ trợ chia sẻ nhiều file ảnh. Hãy dùng Safari/Chrome mới hơn, chọn ít ảnh hơn, hoặc xuất ZIP.");
    }
    setBatchProgress(done, items.length, `Đã dựng ${done} ảnh. Đang mở bảng Chia sẻ…`);
    showHud("Đang mở Lưu/Chia sẻ vào Ảnh…");
    await shareFilesNative(files, `NTS Logo Studio · ${done} ảnh`);
    toast("Đã mở bảng Chia sẻ", "Trên iPhone chọn “Lưu hình ảnh/Save Images”; trên Android chọn Photos/Gallery nếu thiết bị hiển thị tùy chọn đó.", "success", 8500);
    return done;
  }

  async function exportBatch(items, label = "đã chọn") {
    if (state.exporting) return;
    if (!items.length) {
      toast("Chưa chọn ảnh", "Tick một hoặc nhiều ảnh trong thư viện, hoặc dùng Chọn tất cả.", "warning");
      return;
    }
    if (!state.logoFile) {
      toast("Chưa có logo", "Hãy chọn logo trước khi xuất.", "warning");
      return;
    }

    let quotaReservation = null;
    let quotaFinished = false;
    let delivered = 0;
    try {
      if (window.NTS?.membership?.beginExport) {
        quotaReservation = await window.NTS.membership.beginExport(items.length);
      }
    } catch (error) {
      toast("Không thể bắt đầu xuất", error?.message || String(error), "warning", 8000);
      return;
    }

    state.cancelExport = false;

    // Mobile: native Share Sheet. Quota chỉ ghi nhận sau khi bảng Share hoàn tất.
    if (IS_MOBILE && navigator.share && navigator.canShare) {
      try {
        setExportUi(true);
        delivered = await exportMobileShareBatch(items, label) || 0;
        if (quotaReservation && window.NTS?.membership?.finishExport) {
          await window.NTS.membership.finishExport(quotaReservation, delivered);
          quotaFinished = true;
        }
      } catch (error) {
        if (error?.name !== "AbortError") {
          console.error(error);
          toast("Không thể lưu/chia sẻ batch", error?.message || "Thiết bị không xử lý được lô ảnh này.", "error", 9000);
          setBatchProgress(0, items.length, error?.message || "Batch mobile bị lỗi.");
        }
      } finally {
        if (quotaReservation && !quotaFinished && window.NTS?.membership?.cancelExport) {
          await window.NTS.membership.cancelExport(quotaReservation).catch(()=>{});
        }
        hideHud(); setExportUi(false); state.cancelExport = false;
      }
      return;
    }

    const usedNames = new Set();
    let done = 0, failed = 0, cancelled = 0;
    let dirHandle = null, zip = null, zipMode = false;

    try {
      if (typeof window.showDirectoryPicker === "function") {
        try {
          dirHandle = await window.showDirectoryPicker({ mode: "readwrite", id: "nts-logo-export" });
        } catch (error) {
          if (error?.name === "AbortError") return;
          throw error;
        }
      } else {
        const totalInput = items.reduce((sum, item) => sum + (item.file.size || 0), 0);
        const safeZipLimit = IS_MOBILE ? MOBILE_ZIP_MAX_INPUT : DESKTOP_ZIP_MAX_INPUT;
        if (totalInput > safeZipLimit) {
          throw new Error(IS_MOBILE ? "Lô ảnh quá lớn để đóng ZIP an toàn trên điện thoại. Hãy chọn ít ảnh hơn hoặc dùng máy tính." : "Lô ảnh quá lớn để đóng ZIP an toàn trong trình duyệt này. Hãy mở web bằng Chrome/Edge trên máy tính để xuất trực tiếp vào thư mục.");
        }
        if (!window.JSZip) throw new Error("Không tải được mô-đun ZIP. Kiểm tra kết nối Internet rồi thử lại.");
        zip = new window.JSZip(); zipMode = true;
      }

      setExportUi(true);
      setBatchProgress(0, items.length, `Chuẩn bị xuất ${items.length} ảnh ${label}...`);
      showHud(`Batch 0/${items.length} · đang chuẩn bị`);

      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (state.cancelExport) {
          for (let j = index; j < items.length; j += 1) if (items[j].status !== "done" && items[j].status !== "error") items[j].status = "cancelled";
          cancelled = items.length - index; break;
        }
        item.status = "processing"; item.error = ""; renderImageList();
        const progressText = `${index + 1}/${items.length} · ${item.file.name}`;
        setBatchProgress(index, items.length, `Đang xử lý ${progressText}`); showHud(`Batch ${progressText}`); await yieldToUi();
        try {
          const { blob, fileName } = await renderExportBlob(item);
          const safeName = uniqueOutputName(fileName, usedNames);
          if (dirHandle) { await saveBlobToDirectory(dirHandle, safeName, blob); delivered += 1; }
          else zip.file(safeName, blob);
          item.status = "done"; done += 1;
        } catch (error) {
          console.error(error); item.status = "error"; item.error = error?.message || String(error); failed += 1;
        }
        renderImageList(); setBatchProgress(index + 1, items.length, `Đã xử lý ${index + 1}/${items.length} ảnh`); await yieldToUi();
      }

      if (zipMode && done > 0 && !state.cancelExport) {
        showHud("Đang đóng gói ZIP..."); setBatchProgress(items.length, items.length, "Đang đóng gói ZIP — giữ nguyên chất lượng ảnh...");
        const zipBlob = await zip.generateAsync({ type: "blob", compression: "STORE", streamFiles: true }, meta => { els.batchProgressText.textContent = `Đóng ZIP ${Math.round(meta.percent)}%`; });
        downloadBlob(zipBlob, `NTS_Logo_Studio_${Date.now()}.zip`);
        delivered = done;
      }

      if (quotaReservation && window.NTS?.membership?.finishExport) {
        await window.NTS.membership.finishExport(quotaReservation, delivered);
        quotaFinished = true;
      }
      const summary = state.cancelExport ? `Đã dừng. Thành công ${done}, lỗi ${failed}, chưa xử lý ${cancelled}.` : `Hoàn tất ${done}/${items.length} ảnh${failed ? `, lỗi ${failed}` : ""}.`;
      setBatchProgress(done + failed, items.length, summary);
      toast(state.cancelExport ? "Đã dừng batch" : "Xuất hàng loạt hoàn tất", summary, failed ? "warning" : "success", 7000);
    } catch (error) {
      console.error(error); toast("Không thể xuất hàng loạt", error?.message || "Đã xảy ra lỗi khi chuẩn bị batch.", "error", 8000); setBatchProgress(0, items.length, error?.message || "Batch bị lỗi.");
    } finally {
      if (quotaReservation && !quotaFinished && window.NTS?.membership?.cancelExport) await window.NTS.membership.cancelExport(quotaReservation).catch(()=>{});
      hideHud(); setExportUi(false); state.cancelExport = false;
    }
  }

  async function exportCurrent() {
    const item = currentItem();
    if (!item) return toast("Chưa có ảnh", "Chọn một ảnh để xuất.", "warning");
    if (state.exporting) return;
    if (!state.logoFile) return toast("Chưa có logo", "Hãy chọn logo trước khi xuất.", "warning");
    let reservation=null, finished=false;
    try {
      if (window.NTS?.membership?.beginExport) reservation=await window.NTS.membership.beginExport(1);
    } catch (error) { toast("Không thể xuất ảnh", error?.message||String(error), "warning", 8000); return; }
    setExportUi(true); showHud("Đang dựng ảnh full resolution...");
    try {
      const { blob, fileName } = await renderExportBlob(item); const file = blobAsFile(blob, fileName);
      if (IS_MOBILE && canNativeShareFiles([file])) { await shareFilesNative([file], "NTS Logo Studio"); toast("Đã mở bảng Chia sẻ", "Chọn “Lưu hình ảnh/Save Image” hoặc Photos/Gallery để đưa ảnh vào thư viện ảnh.", "success", 8000); }
      else { downloadBlob(blob, fileName); toast("Xuất ảnh thành công", IS_MOBILE ? `${fileName} đã được tải xuống. Nếu không thấy trong Photos, hãy kiểm tra Downloads/Files.` : fileName, "success", 7000); }
      if (reservation && window.NTS?.membership?.finishExport) { await window.NTS.membership.finishExport(reservation,1); finished=true; }
      item.status="done"; renderImageList();
    } catch (error) {
      item.status="error"; item.error=error?.message||String(error); renderImageList(); toast("Không thể xuất ảnh",item.error,"error",7000);
    } finally {
      if (reservation && !finished && window.NTS?.membership?.cancelExport) await window.NTS.membership.cancelExport(reservation).catch(()=>{});
      hideHud(); setExportUi(false);
    }
  }

  if (els.losslessExportToggle) {
    els.losslessExportToggle.checked = state.forcePng;
    els.losslessExportToggle.addEventListener("change", () => {
      state.forcePng = Boolean(els.losslessExportToggle.checked);
      try { localStorage.setItem("nts-export-lossless", state.forcePng ? "1" : "0"); } catch (_) {}
      toast(
        state.forcePng ? "PNG siêu nét đã bật" : "Đã dùng định dạng gốc",
        state.forcePng ? "Ảnh xuất sẽ dùng PNG lossless để logo/text sắc nét nhất. Dung lượng file sẽ lớn hơn." : "JPG/WebP sẽ được xuất ở chất lượng rất cao để cân bằng độ nét và dung lượng.",
        state.forcePng ? "success" : "info", 4200
      );
    });
  }

  els.exportSelectedButton.addEventListener("click", () => exportBatch(selectedItems(), "đã chọn"));
  els.exportAllButton.addEventListener("click", () => exportBatch([...state.images], "trong thư viện"));
  els.exportCurrentButton.addEventListener("click", exportCurrent);
  els.cancelExportButton.addEventListener("click", () => {
    if (!state.exporting) return;
    state.cancelExport = true;
    els.cancelExportButton.disabled = true;
    els.cancelExportButton.textContent = "Đang dừng sau ảnh hiện tại...";
    toast("Đã nhận lệnh dừng", "Ảnh đang xử lý sẽ hoàn tất an toàn, sau đó batch sẽ dừng.", "warning", 5200);
    window.setTimeout(() => {
      els.cancelExportButton.disabled = false;
      els.cancelExportButton.textContent = "Dừng sau ảnh đang xử lý";
    }, 1200);
  });

  if (els.mobileExportHint && IS_MOBILE) {
    els.mobileExportHint.classList.remove("hidden");
    els.mobileExportHint.textContent = `Mobile Safe: tối đa ~${Math.round(MOBILE_MAX_PIXELS / 1e6)} MP/ảnh, tối đa ${MOBILE_SHARE_MAX_FILES} ảnh/lượt khi lưu vào Photos/Gallery.`;
  }

  function closeMobileDrawers() {
    els.libraryPanel.classList.remove("mobile-open");
    els.settingsPanel.classList.remove("mobile-open");
  }
  els.mobileLibraryToggle.addEventListener("click", () => {
    const open = !els.libraryPanel.classList.contains("mobile-open");
    closeMobileDrawers();
    if (open) els.libraryPanel.classList.add("mobile-open");
  });
  els.mobileSettingsToggle.addEventListener("click", () => {
    const open = !els.settingsPanel.classList.contains("mobile-open");
    closeMobileDrawers();
    if (open) els.settingsPanel.classList.add("mobile-open");
  });
  els.mobileSettingsClose.addEventListener("click", closeMobileDrawers);

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => schedulePreview(true), 120);
  });

  window.addEventListener("beforeunload", () => {
    state.currentBitmap?.close?.();
    state.logoBitmap?.close?.();
    state.images.forEach((item) => URL.revokeObjectURL(item.url));
    if (state.logoUrl) URL.revokeObjectURL(state.logoUrl);
  });

  syncControlLabels();
  setBatchProgress(0, 0, "Sẵn sàng xuất.");
  renderImageList();
})();
