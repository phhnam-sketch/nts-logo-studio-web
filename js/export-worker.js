"use strict";

// NTS Logo Studio V3.3 - background-safe parallel export worker.
// All heavy decode/canvas/encode work is intentionally kept away from the DOM/main thread.

let logoBitmap = null;

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function hasFiniteNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function validDimension(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function normalizeSettingsShape(settings = {}) {
  const out = { ...settings };
  const legacyPadding = finiteNumber(out.padding, 28);
  if (!hasFiniteNumber(out.paddingX)) out.paddingX = legacyPadding;
  if (!hasFiniteNumber(out.paddingY)) out.paddingY = legacyPadding;
  out.paddingX = Math.max(0, finiteNumber(out.paddingX, legacyPadding));
  out.paddingY = Math.max(0, finiteNumber(out.paddingY, legacyPadding));
  out.offsetX = finiteNumber(out.offsetX, 0);
  out.offsetY = finiteNumber(out.offsetY, 0);
  out.opacity = Math.max(0, Math.min(100, finiteNumber(out.opacity, 92)));
  out.size = Math.max(2, Math.min(80, finiteNumber(out.size, 18)));
  out.rotation = Math.max(-180, Math.min(180, finiteNumber(out.rotation, 0)));
  out.padding = Math.round((out.paddingX + out.paddingY) / 2);
  out.keepInside = out.keepInside !== false;
  return out;
}

function materializeSettings(settings, width, height) {
  const out = normalizeSettingsShape(settings);
  if (!validDimension(width) || !validDimension(height)) return out;
  const shortSide = Math.min(width, height);
  if (hasFiniteNumber(out.paddingXRatio)) out.paddingX = Math.round(Number(out.paddingXRatio) * width);
  else if (hasFiniteNumber(out.paddingRatio)) out.paddingX = Math.round(Number(out.paddingRatio) * shortSide);
  else if (validDimension(out.referenceWidth)) out.paddingX = Math.round(finiteNumber(out.paddingX, out.padding) * width / Number(out.referenceWidth));

  if (hasFiniteNumber(out.paddingYRatio)) out.paddingY = Math.round(Number(out.paddingYRatio) * height);
  else if (hasFiniteNumber(out.paddingRatio)) out.paddingY = Math.round(Number(out.paddingRatio) * shortSide);
  else if (validDimension(out.referenceHeight)) out.paddingY = Math.round(finiteNumber(out.paddingY, out.padding) * height / Number(out.referenceHeight));

  if (hasFiniteNumber(out.offsetXRatio)) out.offsetX = Math.round(Number(out.offsetXRatio) * width);
  else if (validDimension(out.referenceWidth)) out.offsetX = Math.round(finiteNumber(out.offsetX, 0) * width / Number(out.referenceWidth));
  if (hasFiniteNumber(out.offsetYRatio)) out.offsetY = Math.round(Number(out.offsetYRatio) * height);
  else if (validDimension(out.referenceHeight)) out.offsetY = Math.round(finiteNumber(out.offsetY, 0) * height / Number(out.referenceHeight));

  out.paddingX = Math.max(0, out.paddingX);
  out.paddingY = Math.max(0, out.paddingY);
  out.padding = Math.round((out.paddingX + out.paddingY) / 2);
  out.referenceWidth = width;
  out.referenceHeight = height;
  out.referenceShortSide = shortSide;
  return out;
}

function watermarkGeometry(logo, targetShortSide, rotationDeg, settings) {
  const ratio = Number(settings.size || 0) / 100;
  let w, h;
  if (logo.width >= logo.height) {
    w = targetShortSide * ratio;
    h = w * (logo.height / logo.width);
  } else {
    h = targetShortSide * ratio;
    w = h * (logo.width / logo.height);
  }
  w = Math.max(1, w);
  h = Math.max(1, h);
  const rad = Number(rotationDeg || 0) * Math.PI / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  return {
    w, h, rad,
    width: Math.max(1, w * cos + h * sin),
    height: Math.max(1, w * sin + h * cos)
  };
}

function watermarkPosition(imgW, imgH, logoW, logoH, settings) {
  const s = normalizeSettingsShape(settings);
  let x = (imgW - logoW) / 2;
  let y = (imgH - logoH) / 2;
  if (s.pos.includes("W")) x = s.paddingX;
  else if (s.pos.includes("E")) x = imgW - logoW - s.paddingX;
  if (s.pos.includes("N")) y = s.paddingY;
  else if (s.pos.includes("S")) y = imgH - logoH - s.paddingY;
  x += s.offsetX;
  y += s.offsetY;
  if (s.keepInside) {
    x = Math.min(Math.max(x, 0), imgW - logoW);
    y = Math.min(Math.max(y, 0), imgH - logoH);
  }
  return { x, y };
}

function drawWatermark(ctx, logo, width, height, settings) {
  const g = watermarkGeometry(logo, Math.min(width, height), settings.rotation, settings);
  const pos = watermarkPosition(width, height, g.width, g.height, settings);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.globalAlpha = Math.max(0, Math.min(1, Number(settings.opacity || 0) / 100));
  ctx.translate(pos.x + g.width / 2, pos.y + g.height / 2);
  ctx.rotate(g.rad);
  ctx.drawImage(logo, -g.w / 2, -g.h / 2, g.w, g.h);
  ctx.restore();
}

async function decodeBitmap(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (_) {
    return await createImageBitmap(file);
  }
}

async function initLogo(file) {
  logoBitmap?.close?.();
  logoBitmap = await decodeBitmap(file);
  return { width: logoBitmap.width, height: logoBitmap.height };
}

async function renderTask(payload) {
  if (!logoBitmap) throw new Error("WORKER_LOGO_NOT_READY");
  let bitmap = null;
  try {
    bitmap = await decodeBitmap(payload.file);
    const width = bitmap.width;
    const height = bitmap.height;
    const pixels = width * height;
    if (payload.maxPixels && pixels > payload.maxPixels) {
      throw new Error(`Ảnh ${payload.fileName || ""} vượt giới hạn an toàn ${Math.round(payload.maxPixels / 1e6)} MP.`);
    }
    const settings = materializeSettings(payload.settings || {}, width, height);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
    if (!ctx) throw new Error("Trình duyệt không tạo được OffscreenCanvas 2D.");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0);
    drawWatermark(ctx, logoBitmap, width, height, settings);
    const blob = await canvas.convertToBlob({ type: payload.mime, quality: payload.quality });
    if (!blob || !blob.size) throw new Error("Worker tạo ra file ảnh rỗng.");
    return { blob, width, height, settings };
  } finally {
    bitmap?.close?.();
  }
}

self.onmessage = async (event) => {
  const data = event.data || {};
  try {
    if (data.type === "init") {
      if (!data.logoFile) throw new Error("Chưa có logo để khởi tạo worker.");
      const meta = await initLogo(data.logoFile);
      self.postMessage({ type: "ready", workerId: data.workerId, ...meta });
      return;
    }
    if (data.type === "render") {
      const result = await renderTask(data);
      self.postMessage({ type: "result", requestId: data.requestId, ok: true, ...result });
      return;
    }
    if (data.type === "dispose") {
      logoBitmap?.close?.();
      logoBitmap = null;
      self.close();
    }
  } catch (error) {
    self.postMessage({
      type: data.type === "init" ? "ready" : "result",
      requestId: data.requestId,
      workerId: data.workerId,
      ok: false,
      error: error?.message || String(error)
    });
  }
};
