(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const NTS = window.NTS = window.NTS || {};

  function moneyText(months) {
    const id = months === 1 ? "price1Month" : `price${months}Month`;
    return $(id)?.textContent?.trim() || "—";
  }

  function openCheckout(months) {
    const m = [1,3,6,12].includes(Number(months)) ? Number(months) : 1;
    if (NTS.membership?.state) NTS.membership.state.paymentMonths = m;
    NTS.membership?.renderPaymentPlan?.();
    document.querySelectorAll("[data-plan-card]").forEach(card => card.classList.toggle("active", Number(card.dataset.planCard) === m));
    if ($("v36CheckoutPlan")) $("v36CheckoutPlan").textContent = `VIP ${m} tháng`;
    if ($("v36CheckoutAmount")) $("v36CheckoutAmount").textContent = moneyText(m);
    if ($("v36CheckoutOrderPlan")) $("v36CheckoutOrderPlan").textContent = `VIP ${m} tháng`;
    $("autoPaymentResult")?.classList.add("hidden");
    $("v36CheckoutIntro")?.classList.remove("hidden");
    $("membershipCheckoutModal")?.classList.remove("hidden");
    document.body.classList.add("modal-open");
    setTimeout(() => $("createAutoPaymentButton")?.focus(), 60);
  }

  function closeCheckout() {
    $("membershipCheckoutModal")?.classList.add("hidden");
    document.body.classList.remove("modal-open");
  }

  document.addEventListener("click", (e) => {
    const plan = e.target.closest(".v36-register-plan");
    if (plan) {
      e.preventDefault();
      openCheckout(Number(plan.dataset.months));
      return;
    }
    if (e.target === $("membershipCheckoutModal")) closeCheckout();
  });
  $("v36CheckoutClose")?.addEventListener("click", closeCheckout);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("membershipCheckoutModal")?.classList.contains("hidden")) closeCheckout();
  });

  function renderQr(payload) {
    const wrap = $("v36QrCanvas");
    if (!wrap) return;
    wrap.innerHTML = "";
    if (!payload || typeof window.QRCode === "undefined") {
      wrap.innerHTML = '<div class="v36-qr-placeholder">Mở payOS để xem QR</div>';
      return;
    }
    try {
      new window.QRCode(wrap, { text: String(payload), width: 220, height: 220, correctLevel: window.QRCode.CorrectLevel.M });
    } catch (err) {
      console.warn("QR render failed", err);
      wrap.innerHTML = '<div class="v36-qr-placeholder">Mở payOS để xem QR</div>';
    }
  }

  window.addEventListener("nts:payment-created", (e) => {
    const d = e.detail || {};
    $("v36CheckoutIntro")?.classList.add("hidden");
    $("autoPaymentResult")?.classList.remove("hidden");
    if ($("v36CheckoutOrderPlan")) $("v36CheckoutOrderPlan").textContent = `VIP ${Number(d.months || 1)} tháng`;
    renderQr(d.qrPayload);
  });

  window.addEventListener("nts:payment-error", () => {
    $("v36CheckoutIntro")?.classList.remove("hidden");
  });

  window.addEventListener("nts:payment-status", (e) => {
    const row = e.detail?.row;
    if (!row) return;
    const state = String(row.provider_state || row.status || "pending");
    const statusEl = $("autoPaymentState");
    if (!statusEl) return;
    if (row.status === "approved" || row.auto_verified) {
      statusEl.textContent = "Thanh toán thành công · VIP đã kích hoạt";
      statusEl.dataset.kind = "success";
    } else if (state === "underpaid") {
      statusEl.textContent = `Thiếu tiền · đã nhận ${NTS.membership?.money?.(row.paid_amount || 0) || row.paid_amount || 0}`;
      statusEl.dataset.kind = "warning";
    } else if (state === "overpaid") {
      statusEl.textContent = "Dư tiền · đang chờ xử lý";
      statusEl.dataset.kind = "warning";
    } else {
      statusEl.textContent = "Đang chờ thanh toán";
      statusEl.dataset.kind = "pending";
    }
  });

  function updateMembershipSummary(account) {
    if (!account) return;
    const admin = account.role === "admin";
    const vip = Boolean(account.is_vip);
    const name = admin ? "ADMIN" : vip ? "VIP" : "FREE";
    const detail = admin ? "Toàn quyền quản trị" : vip ? `Hết hạn ${NTS.membership?.dateTime?.(account.vip_until) || "—"}` : `${Math.max(0, Number(account.remaining || 0))} ảnh còn lại`;
    if ($("v36CurrentPlan")) $("v36CurrentPlan").textContent = name;
    if ($("v36CurrentPlanDetail")) $("v36CurrentPlanDetail").textContent = detail;
    const currentPlanCard = document.querySelector(".v36-current-membership");
    if (currentPlanCard) {
      currentPlanCard.classList.remove("v39-current-admin", "v39-current-vip", "v39-current-free");
      currentPlanCard.classList.add(admin ? "v39-current-admin" : vip ? "v39-current-vip" : "v39-current-free");
    }
    if ($("v36ProfilePlanName")) $("v36ProfilePlanName").textContent = name;
    if ($("v36ProfilePlanSub")) $("v36ProfilePlanSub").textContent = detail;
    if ($("v36ProfilePlanIcon")) $("v36ProfilePlanIcon").textContent = admin ? "◆" : vip ? "✦" : "◇";
  }
  window.addEventListener("nts:membership-updated", e => updateMembershipSummary(e.detail?.account));
  if (NTS.membership?.state?.account) updateMembershipSummary(NTS.membership.state.account);

  // Profile drag / zoom enhancement. Sliders remain the source of truth for backwards compatibility.
  function setupCropSurface(kind) {
    const prefix = kind === "avatar" ? "avatar" : "cover";
    const surface = $(`${prefix}EditorSurface`);
    const x = $(`${prefix}PosX`), y = $(`${prefix}PosY`), zoom = $(`${prefix}Zoom`);
    if (!surface || !x || !y || !zoom) return;
    const pointers = new Map();
    let start = null, startDist = 0, startZoom = 100;
    const fire = (el) => el.dispatchEvent(new Event("input", { bubbles: true }));
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    surface.addEventListener("pointerdown", (e) => {
      surface.setPointerCapture?.(e.pointerId);
      pointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
      if (pointers.size === 1) start = { px:e.clientX, py:e.clientY, x:Number(x.value), y:Number(y.value) };
      if (pointers.size === 2) {
        const p=[...pointers.values()]; startDist=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y); startZoom=Number(zoom.value);
      }
      surface.classList.add("dragging");
    });
    surface.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if (pointers.size >= 2) {
        const p=[...pointers.values()]; const dist=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);
        if (startDist > 0) { zoom.value=String(Math.round(clamp(startZoom*(dist/startDist),100,220))); fire(zoom); }
        return;
      }
      if (!start) return;
      const r=surface.getBoundingClientRect();
      x.value=String(Math.round(clamp(start.x + (e.clientX-start.px)/Math.max(1,r.width)*100,0,100)));
      y.value=String(Math.round(clamp(start.y + (e.clientY-start.py)/Math.max(1,r.height)*100,0,100)));
      fire(x); fire(y);
    });
    const end = (e) => { pointers.delete(e.pointerId); if (!pointers.size) { start=null; surface.classList.remove("dragging"); } };
    surface.addEventListener("pointerup", end); surface.addEventListener("pointercancel", end);
    surface.addEventListener("wheel", (e) => { e.preventDefault(); zoom.value=String(Math.round(clamp(Number(zoom.value)+(e.deltaY<0?5:-5),100,220))); fire(zoom); }, { passive:false });
  }
  setupCropSurface("avatar"); setupCropSurface("cover");

  // Small micro-interaction without heavy animation libraries.
  document.addEventListener("pointerdown", (e) => {
    const btn=e.target.closest("button,.media-file-button,.v36-plan-card");
    if (!btn) return;
    btn.classList.add("v36-pressed");
  });
  document.addEventListener("pointerup", () => document.querySelectorAll(".v36-pressed").forEach(el=>el.classList.remove("v36-pressed")));
})();
