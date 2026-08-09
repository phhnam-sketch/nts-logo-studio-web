import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "x-nts-request-id",
};

function json(data: unknown, status = 200, requestId = "") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      ...(requestId ? { "x-nts-request-id": requestId } : {}),
    },
  });
}

async function hmacHex(secret: string, message: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const log = (event: string, extra: Record<string, unknown> = {}) => {
    console.log(JSON.stringify({ scope: "create-payos-payment", requestId, event, ms: Date.now() - startedAt, ...extra }));
  };

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  log("request_received", {
    method: req.method,
    hasAuthorization: Boolean(req.headers.get("Authorization")),
    hasApiKey: Boolean(req.headers.get("apikey")),
  });

  if (req.method !== "POST") {
    log("method_not_allowed");
    return json({ ok: false, error: "METHOD_NOT_ALLOWED", requestId }, 405, requestId);
  }

  const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").trim();
  const ANON_KEY = (
    Deno.env.get("SUPABASE_ANON_KEY") ||
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ||
    ""
  ).trim();
  const SERVICE_ROLE = (
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SECRET_KEY") ||
    ""
  ).trim();
  const PAYOS_CLIENT_ID = (Deno.env.get("PAYOS_CLIENT_ID") || "").trim();
  const PAYOS_API_KEY = (Deno.env.get("PAYOS_API_KEY") || "").trim();
  const PAYOS_CHECKSUM_KEY = (Deno.env.get("PAYOS_CHECKSUM_KEY") || "").trim();

  const missing: string[] = [];
  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!ANON_KEY) missing.push("SUPABASE_ANON_KEY/PUBLISHABLE_KEY");
  if (!SERVICE_ROLE) missing.push("SUPABASE_SERVICE_ROLE_KEY/SECRET_KEY");
  if (!PAYOS_CLIENT_ID) missing.push("PAYOS_CLIENT_ID");
  if (!PAYOS_API_KEY) missing.push("PAYOS_API_KEY");
  if (!PAYOS_CHECKSUM_KEY) missing.push("PAYOS_CHECKSUM_KEY");

  if (missing.length) {
    log("missing_secrets", { missing });
    return json({ ok: false, error: "PAYOS_NOT_CONFIGURED", missing, requestId }, 503, requestId);
  }

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    log("authorization_header_missing");
    return json({ ok: false, error: "AUTHORIZATION_HEADER_MISSING", requestId }, 401, requestId);
  }

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userError || !user) {
    log("user_auth_failed", { message: userError?.message || "no_user" });
    return json({ ok: false, error: "NOT_AUTHENTICATED", requestId }, 401, requestId);
  }
  log("user_authenticated", { userId: user.id.slice(0, 8) });

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    log("invalid_json");
    return json({ ok: false, error: "INVALID_JSON", requestId }, 400, requestId);
  }

  const requestedMonths = Number(body.months);
  const months = [1, 3, 6, 12].includes(requestedMonths) ? requestedMonths : 1;
  const origin = String(body.origin || "").replace(/\/$/, "");
  if (!/^https?:\/\//i.test(origin)) {
    log("invalid_origin", { origin: origin.slice(0, 120) });
    return json({ ok: false, error: "INVALID_ORIGIN", requestId }, 400, requestId);
  }

  const { data: membership, error: membershipError } = await admin
    .from("memberships")
    .select("status")
    .eq("user_id", user.id)
    .maybeSingle();

  if (membershipError) {
    log("membership_lookup_failed", { message: membershipError.message });
    return json({ ok: false, error: "MEMBERSHIP_LOOKUP_FAILED", requestId }, 500, requestId);
  }
  if (membership?.status !== "active") {
    log("account_not_active", { status: membership?.status || null });
    return json({ ok: false, error: "ACCOUNT_SUSPENDED", requestId }, 403, requestId);
  }

  const { data: settings, error: settingsError } = await admin
    .from("site_settings")
    .select("vip_monthly_price")
    .eq("id", true)
    .single();

  if (settingsError) {
    log("site_settings_failed", { message: settingsError.message });
    return json({ ok: false, error: "SETTINGS_UNAVAILABLE", detail: settingsError.message, requestId }, 500, requestId);
  }

  const monthlyPrice = Number(settings?.vip_monthly_price || 200000);
  const amount = monthlyPrice * months;
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    log("invalid_amount", { monthlyPrice, months, amount });
    return json({ ok: false, error: "INVALID_AMOUNT", requestId }, 400, requestId);
  }

  const { data: oldPending, error: pendingError } = await admin
    .from("payment_requests")
    .select("id,checkout_url,provider_order_code,amount,months")
    .eq("user_id", user.id)
    .eq("status", "pending")
    .eq("payment_provider", "payos")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (pendingError) {
    log("pending_lookup_failed", { message: pendingError.message });
  }

  if (
    oldPending?.id &&
    Number(oldPending.amount) === amount &&
    Number(oldPending.months) === months &&
    oldPending.checkout_url
  ) {
    log("reusing_pending_order", { paymentId: oldPending.id, months, amount });
    return json({
      ok: true,
      reused: true,
      paymentId: oldPending.id,
      orderCode: oldPending.provider_order_code,
      amount,
      months,
      checkoutUrl: oldPending.checkout_url,
      requestId,
    }, 200, requestId);
  }

  // Keep inside JS safe integer range and unique enough for this app.
  const orderCode = Date.now() * 100 + Math.floor(Math.random() * 90 + 10);
  const description = `NTS${String(orderCode).slice(-6)}`.slice(0, 9);
  const returnUrl = `${origin}/?payment=success&orderCode=${orderCode}`;
  const cancelUrl = `${origin}/?payment=cancel&orderCode=${orderCode}`;

  const { data: row, error: insertError } = await admin
    .from("payment_requests")
    .insert({
      user_id: user.id,
      amount,
      months,
      reference: description,
      status: "pending",
      payment_provider: "payos",
      provider_order_code: orderCode,
      provider_state: "creating",
    })
    .select("id")
    .single();

  if (insertError || !row) {
    log("payment_row_insert_failed", { message: insertError?.message || "no_row" });
    return json({ ok: false, error: "CREATE_ORDER_FAILED", detail: insertError?.message || null, requestId }, 500, requestId);
  }

  log("payment_row_created", { paymentId: row.id, orderCode, months, amount });

  try {
    // payOS payment-request signature fields are amount, cancelUrl, description, orderCode, returnUrl sorted alphabetically.
    const dataToSign = `amount=${amount}&cancelUrl=${cancelUrl}&description=${description}&orderCode=${orderCode}&returnUrl=${returnUrl}`;
    const signature = await hmacHex(PAYOS_CHECKSUM_KEY, dataToSign);

    const payosRes = await fetch("https://api-merchant.payos.vn/v2/payment-requests", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-client-id": PAYOS_CLIENT_ID,
        "x-api-key": PAYOS_API_KEY,
      },
      body: JSON.stringify({
        orderCode,
        amount,
        description,
        buyerEmail: user.email || undefined,
        cancelUrl,
        returnUrl,
        expiredAt: Math.floor(Date.now() / 1000) + 30 * 60,
        signature,
      }),
    });

    const payos = await payosRes.json().catch(() => ({}));
    log("payos_response", {
      httpStatus: payosRes.status,
      code: payos?.code || null,
      desc: String(payos?.desc || "").slice(0, 160),
    });

    if (!payosRes.ok || payos?.code !== "00" || !payos?.data?.checkoutUrl) {
      throw new Error(payos?.desc || `payOS HTTP ${payosRes.status}`);
    }

    const d = payos.data;
    const { error: updateError } = await admin
      .from("payment_requests")
      .update({
        provider_payment_link_id: d.paymentLinkId || null,
        checkout_url: d.checkoutUrl,
        qr_payload: d.qrCode || null,
        provider_state: "pending",
      })
      .eq("id", row.id);

    if (updateError) {
      log("payment_row_update_failed", { message: updateError.message });
      throw new Error(`DB_UPDATE_FAILED: ${updateError.message}`);
    }

    log("payment_created_success", { paymentId: row.id, orderCode });
    return json({
      ok: true,
      paymentId: row.id,
      orderCode,
      amount,
      months,
      checkoutUrl: d.checkoutUrl,
      qrPayload: d.qrCode || null,
      accountNumber: d.accountNumber || null,
      accountName: d.accountName || null,
      bin: d.bin || null,
      description,
      requestId,
    }, 200, requestId);
  } catch (error) {
    const detail = String((error as Error)?.message || error).slice(0, 500);
    log("payment_create_failed", { detail });
    await admin
      .from("payment_requests")
      .update({
        status: "cancelled",
        provider_state: "failed",
        admin_note: detail,
      })
      .eq("id", row.id);

    return json({ ok: false, error: "PAYOS_CREATE_FAILED", detail, requestId }, 502, requestId);
  }
});
