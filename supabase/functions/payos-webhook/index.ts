import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function sortObjDataByKey(object: Record<string, any>) {
  return Object.keys(object || {})
    .sort()
    .reduce((obj: Record<string, any>, key) => {
      obj[key] = object[key];
      return obj;
    }, {});
}

// Matches payOS payment-request webhook signature algorithm.
function convertObjToQueryStr(object: Record<string, any>) {
  return Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .map((key) => {
      let value = object[key];
      if (value && Array.isArray(value)) {
        value = JSON.stringify(
          value.map((val) =>
            typeof val === "object" && val !== null ? sortObjDataByKey(val) : val
          )
        );
      }
      if ([null, undefined, "undefined", "null"].includes(value)) value = "";
      return `${key}=${value}`;
    })
    .join("&");
}

async function hmacHex(secret: string, message: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function safePrefix(value: string, length = 10) {
  if (!value) return "(empty)";
  return `${value.slice(0, length)}…(${value.length})`;
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();

  if (req.method === "GET") {
    // Health check only. Does not validate a payment.
    return json({ ok: true, service: "payos-webhook", version: "3.5.1", requestId });
  }
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED", requestId }, 405);

  const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").trim();
  const SERVICE_ROLE = (
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SECRET_KEY") ||
    ""
  ).trim();
  const CHECKSUM = (Deno.env.get("PAYOS_CHECKSUM_KEY") || "").trim();

  if (!SUPABASE_URL || !SERVICE_ROLE) {
    console.error("[payos-webhook] Supabase server credentials missing", { requestId });
    return json({ error: "SUPABASE_SERVER_NOT_CONFIGURED", requestId }, 503);
  }
  if (!CHECKSUM) {
    console.error("[payos-webhook] PAYOS_CHECKSUM_KEY missing", { requestId });
    return json({ error: "PAYOS_NOT_CONFIGURED", requestId }, 503);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: any;
  try {
    body = await req.json();
  } catch (error) {
    console.error("[payos-webhook] Invalid JSON", { requestId, error: String(error) });
    return json({ error: "INVALID_JSON", requestId }, 400);
  }

  const data = body?.data;
  const signature = String(body?.signature || "").trim();

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    console.error("[payos-webhook] Missing/invalid data object", {
      requestId,
      bodyKeys: Object.keys(body || {}),
    });
    return json({ error: "INVALID_PAYLOAD", requestId }, 400);
  }

  const canonical = convertObjToQueryStr(sortObjDataByKey(data));
  const expected = await hmacHex(CHECKSUM, canonical);

  if (!signature || expected.toLowerCase() !== signature.toLowerCase()) {
    // Never log the checksum secret or the full canonical payload.
    console.error("[payos-webhook] INVALID_SIGNATURE", {
      requestId,
      orderCode: data?.orderCode ?? null,
      dataKeys: Object.keys(data).sort(),
      checksumLength: CHECKSUM.length,
      incomingSignature: safePrefix(signature),
      expectedSignature: safePrefix(expected),
    });
    return json({ error: "INVALID_SIGNATURE", requestId }, 400);
  }

  console.log("[payos-webhook] Signature verified", {
    requestId,
    orderCode: data?.orderCode ?? null,
    reference: data?.reference ?? null,
    amount: data?.amount ?? null,
    success: body?.success === true,
  });

  // payOS sends a signed sample transaction while confirming a webhook URL.
  // If it is not one of our payment orders, acknowledge it with 200.
  const orderCode = Number(data.orderCode);
  const amount = Math.max(0, Number(data.amount || 0));
  const providerReference = String(
    data.reference || `${orderCode}-${data.transactionDateTime || "unknown"}`
  );

  if (!Number.isFinite(orderCode) || orderCode <= 0) {
    console.log("[payos-webhook] Signed sample ignored: no valid orderCode", { requestId });
    return json({ ok: true, ignored: "NO_ORDER_CODE", requestId });
  }

  const { data: payment, error: paymentError } = await admin
    .from("payment_requests")
    .select("id,user_id,amount,months,status,paid_amount")
    .eq("provider_order_code", orderCode)
    .eq("payment_provider", "payos")
    .maybeSingle();

  if (paymentError) {
    console.error("[payos-webhook] Order lookup failed", {
      requestId,
      code: paymentError.code,
      message: paymentError.message,
    });
    return json({ error: "ORDER_LOOKUP_FAILED", requestId }, 500);
  }

  if (!payment) {
    console.log("[payos-webhook] Signed payOS sample/order not found; acknowledged", {
      requestId,
      orderCode,
    });
    return json({ ok: true, ignored: "ORDER_NOT_FOUND", requestId });
  }

  const { data: inserted, error: eventError } = await admin
    .from("payment_events")
    .insert({
      payment_id: payment.id,
      provider: "payos",
      provider_reference: providerReference,
      amount,
      payload: body,
    })
    .select("id")
    .maybeSingle();

  if (eventError && String(eventError.code) !== "23505") {
    console.error("[payos-webhook] Event save failed", {
      requestId,
      code: eventError.code,
      message: eventError.message,
    });
    return json({ error: "EVENT_SAVE_FAILED", requestId }, 500);
  }

  if (!inserted) {
    console.log("[payos-webhook] Duplicate event ignored", { requestId, providerReference });
    return json({ ok: true, duplicate: true, requestId });
  }

  const { data: events, error: eventsError } = await admin
    .from("payment_events")
    .select("amount")
    .eq("payment_id", payment.id)
    .eq("provider", "payos");

  if (eventsError) {
    console.error("[payos-webhook] Event sum failed", {
      requestId,
      code: eventsError.code,
      message: eventsError.message,
    });
    return json({ error: "EVENT_SUM_FAILED", requestId }, 500);
  }

  const totalPaid = (events || []).reduce(
    (sum: number, e: any) => sum + Math.max(0, Number(e.amount || 0)),
    0
  );
  const expectedAmount = Number(payment.amount || 0);
  const providerState =
    totalPaid < expectedAmount ? "underpaid" :
    totalPaid > expectedAmount ? "overpaid" : "paid";

  const { error: paymentUpdateError } = await admin
    .from("payment_requests")
    .update({
      paid_amount: totalPaid,
      provider_reference: providerReference,
      paid_at: totalPaid > 0 ? new Date().toISOString() : null,
      provider_state: providerState,
    })
    .eq("id", payment.id);

  if (paymentUpdateError) {
    console.error("[payos-webhook] Payment update failed", {
      requestId,
      code: paymentUpdateError.code,
      message: paymentUpdateError.message,
    });
    return json({ error: "PAYMENT_UPDATE_FAILED", requestId }, 500);
  }

  // Strict rule requested by the product owner:
  // ONLY exact amount + valid successful payOS webhook activates VIP.
  if (
    providerState === "paid" &&
    payment.status === "pending" &&
    body?.success === true &&
    String(data.code || "00") === "00"
  ) {
    const { data: membership, error: memberReadError } = await admin
      .from("memberships")
      .select("vip_until")
      .eq("user_id", payment.user_id)
      .single();

    if (memberReadError) {
      console.error("[payos-webhook] Membership read failed", {
        requestId,
        code: memberReadError.code,
        message: memberReadError.message,
      });
      return json({ error: "MEMBERSHIP_READ_FAILED", requestId }, 500);
    }

    const now = new Date();
    const base = membership?.vip_until && new Date(membership.vip_until) > now
      ? new Date(membership.vip_until)
      : now;
    const until = new Date(base);
    until.setMonth(
      until.getMonth() + Math.max(1, Math.min(12, Number(payment.months || 1)))
    );

    const { error: membershipError } = await admin
      .from("memberships")
      .update({ plan: "vip", status: "active", vip_until: until.toISOString() })
      .eq("user_id", payment.user_id);

    if (membershipError) {
      console.error("[payos-webhook] Membership update failed", {
        requestId,
        code: membershipError.code,
        message: membershipError.message,
      });
      return json({ error: "MEMBERSHIP_UPDATE_FAILED", requestId }, 500);
    }

    const { error: approvalError } = await admin
      .from("payment_requests")
      .update({
        status: "approved",
        auto_verified: true,
        reviewed_at: new Date().toISOString(),
        admin_note: "Tự động xác nhận đủ tiền qua payOS webhook",
      })
      .eq("id", payment.id);

    if (approvalError) {
      console.error("[payos-webhook] Approval update failed", {
        requestId,
        code: approvalError.code,
        message: approvalError.message,
      });
      return json({ error: "APPROVAL_UPDATE_FAILED", requestId }, 500);
    }
  }

  console.log("[payos-webhook] Completed", {
    requestId,
    paymentId: payment.id,
    expectedAmount,
    totalPaid,
    providerState,
  });

  return json({
    ok: true,
    paymentId: payment.id,
    expectedAmount,
    totalPaid,
    providerState,
    requestId,
  });
});
