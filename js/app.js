(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const toast = (title, message, kind = "info", duration) => window.NTS?.showToast?.(title, message, kind, duration);

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
    settings: {
      pos: "SE",
      opacity: 92,
      size: 18,
      padding: 28,
      offsetX: 0,
      offsetY: 0,
      rotation: 0,
      keepInside: true
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
    previewHud: $("previewHud"),
    previewHudText: $("previewHudText"),
    selectedImageStatus: $("selectedImageStatus"),
    logoPreviewBox: $("logoPreviewBox"),
    logoFileName: $("logoFileName"),
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

  function updateCurrentItemSettings() {
    const item = currentItem();
    if (item) item.settings = cloneSettings();
  }

  function setSettings(settings) {
    state.settings = cloneSettings(settings);
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
    const item = currentItem();
    if (item?.settings) setSettings(item.settings);
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
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
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

  function createSurface(width, height) {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(width));
    c.height = Math.max(1, Math.ceil(height));
    return c;
  }

  function rotatedLogoSurface(logo, targetShortSide, rotationDeg, settings = state.settings) {
    const ratio = settings.size / 100;
    let w;
    let h;
    if (logo.width >= logo.height) {
      w = targetShortSide * ratio;
      h = w * (logo.height / logo.width);
    } else {
      h = targetShortSide * ratio;
      w = h * (logo.width / logo.height);
    }
    w = Math.max(1, w);
    h = Math.max(1, h);

    const rad = rotationDeg * Math.PI / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const rw = Math.max(1, w * cos + h * sin);
    const rh = Math.max(1, w * sin + h * cos);
    const surface = createSurface(rw, rh);
    const ctx = surface.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.translate(surface.width / 2, surface.height / 2);
    ctx.rotate(rad);
    ctx.globalAlpha = settings.opacity / 100;
    ctx.drawImage(logo, -w / 2, -h / 2, w, h);
    ctx.globalAlpha = 1;
    return surface;
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
      const rect = containRect(current.bitmap.width, current.bitmap.height, frameW, frameH, frameW < 600 ? 10 : 22);

      drawBase(beforeCtx, current.bitmap, rect);
      drawBase(afterCtx, current.bitmap, rect);

      if (logo) {
        const rotated = rotatedLogoSurface(logo, Math.min(rect.w, rect.h), state.settings.rotation);
        const pos = watermarkPosition(rect.x, rect.y, rect.w, rect.h, rotated.width, rotated.height, rect.scale);
        afterCtx.drawImage(rotated, pos.x, pos.y);
      }

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
    schedulePreview(true);
    toast("Đã nạp logo", file.name, "success");
  });

  els.fitPreview.addEventListener("click", () => schedulePreview(true));

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
    const snapshot = cloneSettings();
    items.forEach((item) => { item.settings = cloneSettings(snapshot); });
    toast("Đã đồng bộ cấu hình", `${items.length} ảnh đã nhận đúng cấu hình đang preview.`, "success", 4600);
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
    if (surface.convertToBlob) return surface.convertToBlob({ type: mime, quality });
    return new Promise((resolve, reject) => surface.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Không tạo được file ảnh.")), mime, quality));
  }

  function outputSpec(item) {
    const name = item.file.name;
    const stem = name.replace(/\.[^.]+$/, "");
    if (/jpe?g$/i.test(name) || item.file.type === "image/jpeg") return { mime: "image/jpeg", ext: "jpg", quality: .96, name: `${stem}_watermarked.jpg` };
    if (/webp$/i.test(name) || item.file.type === "image/webp") return { mime: "image/webp", ext: "webp", quality: .96, name: `${stem}_watermarked.webp` };
    return { mime: "image/png", ext: "png", quality: 1, name: `${stem}_watermarked.png` };
  }

  async function renderExportBlob(item) {
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(item.file, { imageOrientation: "from-image" }).catch(() => createImageBitmap(item.file));
      const pixels = bitmap.width * bitmap.height;
      const ramGb = Number(navigator.deviceMemory || 8);
      const maxPixels = ramGb <= 4 ? 45_000_000 : 90_000_000;
      if (pixels > maxPixels) {
        throw new Error(`Ảnh ${item.file.name} quá lớn (${Math.round(pixels / 1e6)} MP) so với giới hạn an toàn của trình duyệt này.`);
      }
      const logo = await ensureLogoBitmap();
      if (!logo) throw new Error("Chưa chọn logo.");
      const settings = item.settings ? cloneSettings(item.settings) : cloneSettings();
      const surface = createSurface(bitmap.width, bitmap.height);
      const ctx = surface.getContext("2d", { alpha: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0);
      const rotated = rotatedLogoSurface(logo, Math.min(bitmap.width, bitmap.height), settings.rotation, settings);
      const pos = watermarkPosition(0, 0, bitmap.width, bitmap.height, rotated.width, rotated.height, 1, settings);
      ctx.drawImage(rotated, pos.x, pos.y);
      const spec = outputSpec(item);
      const blob = await canvasToBlob(surface, spec.mime, spec.quality);
      return { blob, fileName: spec.name };
    } finally {
      bitmap?.close?.();
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

    state.cancelExport = false;
    const usedNames = new Set();
    let done = 0, failed = 0, cancelled = 0;
    let dirHandle = null;
    let zip = null;
    let zipMode = false;

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
        const safeZipLimit = /Mobi|Android/i.test(navigator.userAgent) ? 120 * 1024 ** 2 : 280 * 1024 ** 2;
        if (totalInput > safeZipLimit) {
          throw new Error("Lô ảnh quá lớn để đóng ZIP an toàn trong trình duyệt này. Hãy mở web bằng Chrome/Edge trên máy tính để xuất trực tiếp vào thư mục.");
        }
        if (!window.JSZip) throw new Error("Không tải được mô-đun ZIP. Kiểm tra kết nối Internet rồi thử lại.");
        zip = new window.JSZip();
        zipMode = true;
      }

      setExportUi(true);
      setBatchProgress(0, items.length, `Chuẩn bị xuất ${items.length} ảnh ${label}...`);
      showHud(`Batch 0/${items.length} · đang chuẩn bị`);

      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (state.cancelExport) {
          for (let j = index; j < items.length; j += 1) {
            if (items[j].status !== "done" && items[j].status !== "error") items[j].status = "cancelled";
          }
          cancelled = items.length - index;
          break;
        }
        item.status = "processing";
        item.error = "";
        renderImageList();
        const progressText = `${index + 1}/${items.length} · ${item.file.name}`;
        setBatchProgress(index, items.length, `Đang xử lý ${progressText}`);
        showHud(`Batch ${progressText}`);
        await yieldToUi();

        try {
          const { blob, fileName } = await renderExportBlob(item);
          const safeName = uniqueOutputName(fileName, usedNames);
          if (dirHandle) await saveBlobToDirectory(dirHandle, safeName, blob);
          else zip.file(safeName, blob);
          item.status = "done";
          done += 1;
        } catch (error) {
          console.error(error);
          item.status = "error";
          item.error = error?.message || String(error);
          failed += 1;
        }
        renderImageList();
        setBatchProgress(index + 1, items.length, `Đã xử lý ${index + 1}/${items.length} ảnh`);
        await yieldToUi();
      }

      if (zipMode && done > 0 && !state.cancelExport) {
        showHud("Đang đóng gói ZIP...");
        setBatchProgress(items.length, items.length, "Đang đóng gói ZIP — giữ nguyên chất lượng ảnh...");
        const zipBlob = await zip.generateAsync(
          { type: "blob", compression: "STORE", streamFiles: true },
          (meta) => { els.batchProgressText.textContent = `Đóng ZIP ${Math.round(meta.percent)}%`; }
        );
        downloadBlob(zipBlob, `NTS_Logo_Studio_${Date.now()}.zip`);
      }

      const summary = state.cancelExport
        ? `Đã dừng. Thành công ${done}, lỗi ${failed}, chưa xử lý ${cancelled}.`
        : `Hoàn tất ${done}/${items.length} ảnh${failed ? `, lỗi ${failed}` : ""}.`;
      setBatchProgress(done + failed, items.length, summary);
      toast(state.cancelExport ? "Đã dừng batch" : "Xuất hàng loạt hoàn tất", summary, failed ? "warning" : "success", 7000);
    } catch (error) {
      console.error(error);
      toast("Không thể xuất hàng loạt", error?.message || "Đã xảy ra lỗi khi chuẩn bị batch.", "error", 8000);
      setBatchProgress(0, items.length, error?.message || "Batch bị lỗi.");
    } finally {
      hideHud();
      setExportUi(false);
      state.cancelExport = false;
    }
  }

  async function exportCurrent() {
    const item = currentItem();
    if (!item) {
      toast("Chưa có ảnh", "Chọn một ảnh để xuất.", "warning");
      return;
    }
    if (state.exporting) return;
    if (!state.logoFile) {
      toast("Chưa có logo", "Hãy chọn logo trước khi xuất.", "warning");
      return;
    }
    setExportUi(true);
    showHud("Đang dựng ảnh full resolution...");
    try {
      const { blob, fileName } = await renderExportBlob(item);
      downloadBlob(blob, fileName);
      item.status = "done";
      renderImageList();
      toast("Xuất ảnh thành công", fileName, "success");
    } catch (error) {
      item.status = "error";
      item.error = error?.message || String(error);
      renderImageList();
      toast("Không thể xuất ảnh", item.error, "error", 7000);
    } finally {
      hideHud();
      setExportUi(false);
    }
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
