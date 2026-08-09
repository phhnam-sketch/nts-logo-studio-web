(() => {
  "use strict";
  const NTS = window.NTS = window.NTS || {};
  const registry = new Map();
  const clamp = (n, min, max) => Math.max(min, Math.min(max, Number(n) || 0));

  function fireInput(el, value) {
    if (!el) return;
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function controls(kind) {
    const prefix = kind === "avatar" ? "avatar" : "cover";
    return {
      x: document.getElementById(`${prefix}PosX`),
      y: document.getElementById(`${prefix}PosY`),
      zoom: document.getElementById(`${prefix}Zoom`),
      surface: document.getElementById(`${prefix}EditorSurface`),
      image: document.getElementById(`${prefix}EditorPreview`)
    };
  }

  function transformValues(c) {
    const x = clamp(c.x?.value, 0, 100);
    const y = clamp(c.y?.value, 0, 100);
    const zoom = clamp(c.zoom?.value, 25, 500);
    return { x, y, zoom, tx: x - 50, ty: y - 50, scale: zoom / 100 };
  }

  function paintImage(img, values) {
    if (!img) return;
    // Facebook-like crop: the viewport never moves. Only the image layer moves.
    img.style.objectPosition = "50% 50%";
    img.style.setProperty("--profile-media-x", String(values.x));
    img.style.setProperty("--profile-media-y", String(values.y));
    img.style.setProperty("--profile-media-zoom", String(values.scale));
    img.style.transform = `translate3d(${values.tx}%, ${values.ty}%, 0) scale(${values.scale})`;
  }

  function apply(kind) {
    const c = controls(kind);
    if (!c.image || !c.x || !c.y || !c.zoom) return;
    paintImage(c.image, transformValues(c));
  }

  function setXYZ(kind, x, y, zoom) {
    const c = controls(kind);
    fireInput(c.x, clamp(x, 0, 100));
    fireInput(c.y, clamp(y, 0, 100));
    fireInput(c.zoom, clamp(zoom, 25, 500));
    apply(kind);
  }

  function containZoom(kind) {
    const c = controls(kind);
    const img = c.image, surface = c.surface;
    if (!img || !surface || !img.naturalWidth || !img.naturalHeight) return 100;
    const sw = surface.clientWidth || 1, sh = surface.clientHeight || 1;
    const nw = img.naturalWidth, nh = img.naturalHeight;
    const cover = Math.max(sw / nw, sh / nh);
    const contain = Math.min(sw / nw, sh / nh);
    return clamp((contain / cover) * 100, 25, 100);
  }

  function fill(kind) { setXYZ(kind, 50, 50, 100); }
  function fit(kind) { setXYZ(kind, 50, 50, containZoom(kind)); }
  function center(kind) {
    const c = controls(kind);
    setXYZ(kind, 50, 50, c.zoom?.value || 100);
  }
  function reset(kind) { setXYZ(kind, 50, 50, 100); }

  function bind(kind) {
    if (registry.has(kind)) return registry.get(kind);
    const c = controls(kind);
    if (!c.surface || !c.image || !c.x || !c.y || !c.zoom) return null;

    c.zoom.min = "25";
    c.zoom.max = "500";
    c.zoom.step = "1";
    c.surface.classList.add("v3101-fixed-crop");

    const state = { pointers: new Map(), dragStart: null, pinchStart: null };

    const beginOnePointerDrag = (event) => {
      state.dragStart = {
        clientX: event.clientX,
        clientY: event.clientY,
        x: Number(c.x.value) || 50,
        y: Number(c.y.value) || 50
      };
      c.surface.classList.add("dragging");
    };

    const updateFromDrag = (event) => {
      if (!state.dragStart) return;
      const rect = c.surface.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dx = event.clientX - state.dragStart.clientX;
      const dy = event.clientY - state.dragStart.clientY;
      // Image follows finger/mouse exactly. X/Y remain normalized so the same crop
      // can be reproduced in tiny avatars throughout the site.
      const nextX = clamp(state.dragStart.x + (dx / rect.width) * 100, 0, 100);
      const nextY = clamp(state.dragStart.y + (dy / rect.height) * 100, 0, 100);
      fireInput(c.x, nextX);
      fireInput(c.y, nextY);
      apply(kind);
    };

    c.surface.addEventListener("pointerdown", (event) => {
      if (event.button != null && event.button !== 0) return;
      c.surface.setPointerCapture?.(event.pointerId);
      state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (state.pointers.size === 1) beginOnePointerDrag(event);
      if (state.pointers.size === 2) {
        const pts = [...state.pointers.values()];
        state.pinchStart = {
          distance: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
          zoom: Number(c.zoom.value) || 100
        };
        state.dragStart = null;
        c.surface.classList.remove("dragging");
      }
      event.preventDefault();
    }, { passive: false });

    c.surface.addEventListener("pointermove", (event) => {
      if (!state.pointers.has(event.pointerId)) return;
      state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (state.pointers.size === 2 && state.pinchStart) {
        const pts = [...state.pointers.values()];
        const distance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        fireInput(c.zoom, clamp(state.pinchStart.zoom * (distance / state.pinchStart.distance), 25, 500));
        apply(kind);
      } else if (state.pointers.size === 1) {
        updateFromDrag(event);
      }
      event.preventDefault();
    }, { passive: false });

    const release = (event) => {
      state.pointers.delete(event.pointerId);
      if (state.pointers.size === 0) {
        state.dragStart = null;
        state.pinchStart = null;
        c.surface.classList.remove("dragging");
      } else if (state.pointers.size === 1) {
        const [pt] = [...state.pointers.values()];
        state.dragStart = {
          clientX: pt.x,
          clientY: pt.y,
          x: Number(c.x.value) || 50,
          y: Number(c.y.value) || 50
        };
        state.pinchStart = null;
        c.surface.classList.add("dragging");
      }
    };
    c.surface.addEventListener("pointerup", release);
    c.surface.addEventListener("pointercancel", release);
    c.surface.addEventListener("lostpointercapture", release);

    c.surface.addEventListener("wheel", (event) => {
      const current = Number(c.zoom.value) || 100;
      const step = Math.max(3, Math.round(current * 0.05));
      fireInput(c.zoom, clamp(current + (event.deltaY < 0 ? step : -step), 25, 500));
      apply(kind);
      event.preventDefault();
    }, { passive: false });

    c.surface.addEventListener("dblclick", () => center(kind));
    [c.x, c.y, c.zoom].forEach(el => el?.addEventListener("input", () => apply(kind)));
    c.image.addEventListener("load", () => apply(kind));

    document.querySelector(`[data-profile-command="${kind}-fit"]`)?.addEventListener("click", () => fit(kind));
    document.querySelector(`[data-profile-command="${kind}-fill"]`)?.addEventListener("click", () => fill(kind));
    document.querySelector(`[data-profile-command="${kind}-reset"]`)?.addEventListener("click", () => reset(kind));

    const entry = { kind, apply: () => apply(kind), fit: () => fit(kind), fill: () => fill(kind), center: () => center(kind), reset: () => reset(kind) };
    registry.set(kind, entry);
    apply(kind);
    return entry;
  }

  function refresh() {
    ["avatar", "cover"].forEach(kind => { bind(kind); apply(kind); });
  }

  NTS.profileTransform = { bind, refresh, fit, fill, center, reset, apply, paintImage };
  document.addEventListener("DOMContentLoaded", refresh, { once: true });
  window.addEventListener("nts:profile-saved", refresh);
})();
