import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
async function hmacHex(secret: string, message: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY") || "";
  const PAYOS_CLIENT_ID = Deno.env.get("PAYOS_CLIENT_ID") || "";
  const PAYOS_API_KEY = Deno.env.get("PAYOS_API_KEY") || "";
  const PAYOS_CHECKSUM_KEY = Deno.env.get("PAYOS_CHECKSUM_KEY") || "";
  if (!PAYOS_CLIENT_ID || !PAYOS_API_KEY || !PAYOS_CHECKSUM_KEY) return json({ error: "PAYOS_NOT_CONFIGURED" }, 503);

  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userError || !user) return json({ error: "NOT_AUTHENTICATED" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch (_) {}
  const months = [1, 3, 6, 12].includes(Number(body.months)) ? Number(body.months) : 1;
  const origin = String(body.origin || "").replace(/\/$/, "");
  if (!/^https?:\/\//i.test(origin)) return json({ error: "INVALID_ORIGIN" }, 400);

  const { data: membership } = await admin.from("memberships").select("status").eq("user_id", user.id).single();
  if (membership?.status !== "active") return json({ error: "ACCOUNT_SUSPENDED" }, 403);
  const { data: settings, error: settingsError } = await admin.from("site_settings").select("vip_monthly_price").eq("id", true).single();
  if (settingsError) return json({ error: "SETTINGS_UNAVAILABLE" }, 500);
  const amount = Math.max(0, Number(settings?.vip_monthly_price || 200000)) * months;
  if (!Number.isInteger(amount) || amount <= 0) return json({ error: "INVALID_AMOUNT" }, 400);

  // Giới hạn 1 đơn payOS đang chờ để tránh user tạo hàng loạt QR.
  const { data: oldPending } = await admin.from("payment_requests")
    .select("id,checkout_url,provider_order_code,amount,months")
    .eq("user_id", user.id).eq("status", "pending").eq("payment_provider", "payos")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (oldPending?.id && Number(oldPending.amount) === amount && Number(oldPending.months) === months && oldPending.checkout_url) {
    return json({ ok: true, reused: true, paymentId: oldPending.id, orderCode: oldPending.provider_order_code, amount, months, checkoutUrl: oldPending.checkout_url });
  }

  const orderCode = Date.now() * 100 + Math.floor(Math.random() * 90 + 10);
  const description = `NTS${String(orderCode).slice(-6)}`.slice(0, 9);
  const returnUrl = `${origin}/?payment=success&orderCode=${orderCode}`;
  const cancelUrl = `${origin}/?payment=cancel&orderCode=${orderCode}`;

  const { data: row, error: insertError } = await admin.from("payment_requests").insert({
    user_id: user.id,
    amount,
    months,
    reference: description,
    status: "pending",
    payment_provider: "payos",
    provider_order_code: orderCode,
    provider_state: "creating"
  }).select("id").single();
  if (insertError || !row) return json({ error: insertError?.message || "CREATE_ORDER_FAILED" }, 500);

  try {
    const dataToSign = `amount=${amount}&cancelUrl=${cancelUrl}&description=${description}&orderCode=${orderCode}&returnUrl=${returnUrl}`;
    const signature = await hmacHex(PAYOS_CHECKSUM_KEY, dataToSign);
    const payosRes = await fetch("https://api-merchant.payos.vn/v2/payment-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-client-id": PAYOS_CLIENT_ID, "x-api-key": PAYOS_API_KEY },
      body: JSON.stringify({ orderCode, amount, description, buyerEmail: user.email || undefined, cancelUrl, returnUrl, expiredAt: Math.floor(Date.now()/1000) + 30*60, signature })
    });
    const payos = await payosRes.json();
    if (!payosRes.ok || payos?.code !== "00" || !payos?.data?.checkoutUrl) throw new Error(payos?.desc || `payOS HTTP ${payosRes.status}`);
    const d = payos.data;
    await admin.from("payment_requests").update({
      provider_payment_link_id: d.paymentLinkId || null,
      checkout_url: d.checkoutUrl,
      qr_payload: d.qrCode || null,
      provider_state: "pending"
    }).eq("id", row.id);
    return json({ ok: true, paymentId: row.id, orderCode, amount, months, checkoutUrl: d.checkoutUrl, qrPayload: d.qrCode || null, accountNumber: d.accountNumber || null, accountName: d.accountName || null, bin: d.bin || null, description });
  } catch (error) {
    await admin.from("payment_requests").update({ status: "cancelled", provider_state: "failed", admin_note: String(error?.message || error).slice(0, 500) }).eq("id", row.id);
    return json({ error: "PAYOS_CREATE_FAILED", detail: String(error?.message || error) }, 502);
  }
});
