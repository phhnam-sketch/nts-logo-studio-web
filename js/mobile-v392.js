(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const isMobile = () => window.matchMedia("(max-width: 900px)").matches;

  function closeStudioDrawers() {
    $("libraryPanel")?.classList.remove("mobile-open");
    $("settingsPanel")?.classList.remove("mobile-open");
    document.body.classList.remove("v392-drawer-open");
  }
  function openLibrary() {
    if (!isMobile()) return;
    $("settingsPanel")?.classList.remove("mobile-open");
    $("libraryPanel")?.classList.add("mobile-open");
    document.body.classList.add("v392-drawer-open");
    window.setTimeout(() => $("imageSearch")?.focus({ preventScroll: true }), 80);
  }
  function observeDrawers() {
    for (const id of ["libraryPanel", "settingsPanel"]) {
      const el = $(id); if (!el || typeof MutationObserver === "undefined") continue;
      new MutationObserver(() => {
        const any = $("libraryPanel")?.classList.contains("mobile-open") || $("settingsPanel")?.classList.contains("mobile-open");
        document.body.classList.toggle("v392-drawer-open", Boolean(any));
      }).observe(el, { attributes: true, attributeFilter: ["class"] });
    }
  }

  function init() {
    $("mobileLibraryQuick")?.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); openLibrary(); });
    $("mobileLibraryClose")?.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); closeStudioDrawers(); });

    // Existing hamburger remains a fallback. Keep body state synchronized.
    $("mobileLibraryToggle")?.addEventListener("click", () => requestAnimationFrame(() => {
      document.body.classList.toggle("v392-drawer-open", Boolean($("libraryPanel")?.classList.contains("mobile-open")));
    }));
    $("mobileSettingsToggle")?.addEventListener("click", () => requestAnimationFrame(() => {
      document.body.classList.toggle("v392-drawer-open", Boolean($("settingsPanel")?.classList.contains("mobile-open")));
    }));

    // Messenger must always receive pointer input above the Studio mobile dock/nav.
    const launcher = $("messengerLauncher");
    if (launcher) {
      launcher.style.touchAction = "manipulation";
      launcher.addEventListener("pointerdown", () => launcher.classList.add("v392-pressed"), { passive: true });
      launcher.addEventListener("pointerup", () => launcher.classList.remove("v392-pressed"), { passive: true });
      launcher.addEventListener("pointercancel", () => launcher.classList.remove("v392-pressed"), { passive: true });
    }
    observeDrawers();
    window.addEventListener("resize", () => { if (!isMobile()) closeStudioDrawers(); }, { passive: true });
    window.addEventListener("nts:page-changed", () => closeStudioDrawers());
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
