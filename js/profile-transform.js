(() => {
  "use strict";
  const NTS = window.NTS = window.NTS || {};

  const clamp = (n, min, max) => Math.max(min, Math.min(max, Number(n) || 0));
  const registry = new Map();

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

  function apply(kind) {
    const c = controls(kind);
    if (!c.image || !c.x || !c.y || !c.zoom) return;
    const x = clamp(c.x.value, 0, 100);
    const y = clamp(c.y.value, 0, 100);
    const zoom = clamp(c.zoom.value, 35, 500);
    c.image.style.objectPosition = `${x}% ${y}%`;
    c.image.style.setProperty("--profile-media-zoom", String(zoom / 100));
  }

  function setXYZ(kind, x, y, zoom) {
    const c = controls(kind);
    fireInput(c.x, clamp(x, 0, 100));
    fireInput(c.y, clamp(y, 0, 100));
    fireInput(c.zoom, clamp(zoom, 35, 500));
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
    return clamp((contain / cover) * 100, 35, 100);
  }

  function fill(kind) { setXYZ(kind, 50, 50, 100); }
  function fit(kind) { setXYZ(kind, 50, 50, containZoom(kind)); }
  function center(kind) {
    const c = controls(kind);
    setXYZ(kind, 50, 50, c.zoom?.value || 100);
  }
  function reset(kind) { fill(kind); }

  function bind(kind) {
    if (registry.has(kind)) return registry.get(kind);
    const c = controls(kind);
    if (!c.surface || !c.image || !c.x || !c.y || !c.zoom) return null;

    c.zoom.min = "35";
    c.zoom.max = "500";
    c.zoom.step = "1";
    c.surface.classList.add("v310-free-transform");

    const state = { pointers: new Map(), dragStart: null, pinchStart: null };

    const updateFromDrag = (event) => {
      if (!state.dragStart) return;
      const rect = c.surface.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dx = event.clientX - state.dragStart.clientX;
      const dy = event.clientY - state.dragStart.clientY;
      // Direction follows the image: drag right -> focus moves left so the image itself follows the finger.
      const nextX = clamp(state.dragStart.x - (dx / rect.width) * 100, 0, 100);
      const nextY = clamp(state.dragStart.y - (dy / rect.height) * 100, 0, 100);
      fireInput(c.x, nextX);
      fireInput(c.y, nextY);
      apply(kind);
    };

    c.surface.addEventListener("pointerdown", (event) => {
      if (event.button != null && event.button !== 0) return;
      c.surface.setPointerCapture?.(event.pointerId);
      state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (state.pointers.size === 1) {
        state.dragStart = { clientX: event.clientX, clientY: event.clientY, x: Number(c.x.value), y: Number(c.y.value) };
        c.surface.classList.add("dragging");
      } else if (state.pointers.size === 2) {
        const pts = [...state.pointers.values()];
        state.pinchStart = {
          distance: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
          zoom: Number(c.zoom.value) || 100
        };
        state.dragStart = null;
      }
      event.preventDefault();
    }, { passive: false });

    c.surface.addEventListener("pointermove", (event) => {
      if (!state.pointers.has(event.pointerId)) return;
      state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (state.pointers.size === 2 && state.pinchStart) {
        const pts = [...state.pointers.values()];
        const distance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        fireInput(c.zoom, clamp(state.pinchStart.zoom * (distance / state.pinchStart.distance), 35, 500));
        apply(kind);
      } else if (state.pointers.size === 1) updateFromDrag(event);
      event.preventDefault();
    }, { passive: false });

    const release = (event) => {
      state.pointers.delete(event.pointerId);
      if (state.pointers.size === 0) {
        state.dragStart = null; state.pinchStart = null; c.surface.classList.remove("dragging");
      } else if (state.pointers.size === 1) {
        const [pt] = [...state.pointers.values()];
        state.dragStart = { clientX: pt.x, clientY: pt.y, x: Number(c.x.value), y: Number(c.y.value) };
        state.pinchStart = null;
      }
    };
    c.surface.addEventListener("pointerup", release);
    c.surface.addEventListener("pointercancel", release);

    c.surface.addEventListener("wheel", (event) => {
      const current = Number(c.zoom.value) || 100;
      const step = Math.max(4, Math.round(current * 0.055));
      fireInput(c.zoom, clamp(current + (event.deltaY < 0 ? step : -step), 35, 500));
      apply(kind);
      event.preventDefault();
    }, { passive: false });

    c.surface.addEventListener("dblclick", () => center(kind));
    [c.x, c.y, c.zoom].forEach(el => el?.addEventListener("input", () => apply(kind)));

    document.querySelector(`[data-profile-command="${kind}-fit"]`)?.addEventListener("click", () => fit(kind));
    document.querySelector(`[data-profile-command="${kind}-fill"]`)?.addEventListener("click", () => fill(kind));
    document.querySelector(`[data-profile-command="${kind}-reset"]`)?.addEventListener("click", () => reset(kind));

    const entry = { kind, apply: () => apply(kind), fit: () => fit(kind), fill: () => fill(kind), center: () => center(kind), reset: () => reset(kind) };
    registry.set(kind, entry);
    apply(kind);
    return entry;
  }

  function refresh() { ["avatar", "cover"].forEach(kind => { bind(kind); apply(kind); }); }
  NTS.profileTransform = { bind, refresh, fit, fill, center, reset, apply };
  document.addEventListener("DOMContentLoaded", refresh, { once: true });
  window.addEventListener("nts:profile-saved", refresh);
})();
