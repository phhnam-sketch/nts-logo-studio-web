import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }); }
function sortObjDataByKey(object: Record<string, any>) {
  return Object.keys(object || {}).sort().reduce((obj: Record<string, any>, key) => { obj[key] = object[key]; return obj; }, {});
}
function convertObjToQueryStr(object: Record<string, any>) {
  return Object.keys(object).filter(key => object[key] !== undefined).map(key => {
    let value = object[key];
    if (value && Array.isArray(value)) value = JSON.stringify(value.map((val) => typeof val === "object" && val !== null ? sortObjDataByKey(val) : val));
    if ([null, undefined, "undefined", "null"].includes(value)) value = "";
    return `${key}=${value}`;
  }).join("&");
}
async function hmacHex(secret: string, message: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY") || "";
  const CHECKSUM = Deno.env.get("PAYOS_CHECKSUM_KEY") || "";
  if (!CHECKSUM) return json({ error: "PAYOS_NOT_CONFIGURED" }, 503);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  let body: any;
  try { body = await req.json(); } catch (_) { return json({ error: "INVALID_JSON" }, 400); }
  const data = body?.data || {};
  const signature = String(body?.signature || "");
  const expected = await hmacHex(CHECKSUM, convertObjToQueryStr(sortObjDataByKey(data)));
  if (!signature || expected.toLowerCase() !== signature.toLowerCase()) return json({ error: "INVALID_SIGNATURE" }, 400);

  // payOS gửi payload mẫu khi xác thực webhook; luôn trả 2xx sau khi signature hợp lệ.
  const orderCode = Number(data.orderCode);
  const amount = Math.max(0, Number(data.amount || 0));
  const providerReference = String(data.reference || `${orderCode}-${data.transactionDateTime || "unknown"}`);
  if (!Number.isFinite(orderCode) || orderCode <= 0) return json({ ok: true, ignored: "NO_ORDER_CODE" });

  const { data: payment } = await admin.from("payment_requests").select("id,user_id,amount,months,status,paid_amount")
    .eq("provider_order_code", orderCode).eq("payment_provider", "payos").maybeSingle();
  if (!payment) return json({ ok: true, ignored: "ORDER_NOT_FOUND" });

  const { data: inserted, error: eventError } = await admin.from("payment_events").insert({
    payment_id: payment.id,
    provider: "payos",
    provider_reference: providerReference,
    amount,
    payload: body
  }).select("id").maybeSingle();
  if (eventError && String(eventError.code) !== "23505") return json({ error: "EVENT_SAVE_FAILED" }, 500);
  if (!inserted) return json({ ok: true, duplicate: true });

  const { data: events } = await admin.from("payment_events").select("amount").eq("payment_id", payment.id).eq("provider", "payos");
  const totalPaid = (events || []).reduce((sum: number, e: any) => sum + Math.max(0, Number(e.amount || 0)), 0);
  const expectedAmount = Number(payment.amount || 0);
  let providerState = totalPaid < expectedAmount ? "underpaid" : totalPaid > expectedAmount ? "overpaid" : "paid";

  await admin.from("payment_requests").update({
    paid_amount: totalPaid,
    provider_reference: providerReference,
    paid_at: totalPaid > 0 ? new Date().toISOString() : null,
    provider_state: providerState
  }).eq("id", payment.id);

  // Chỉ kích hoạt khi TỔNG TIỀN = đúng số tiền đơn. Thiếu hoặc dư đều không tự mở VIP.
  if (providerState === "paid" && payment.status === "pending" && body?.success === true && String(data.code || "00") === "00") {
    const { data: membership } = await admin.from("memberships").select("vip_until").eq("user_id", payment.user_id).single();
    const now = new Date();
    const base = membership?.vip_until && new Date(membership.vip_until) > now ? new Date(membership.vip_until) : now;
    const until = new Date(base);
    until.setMonth(until.getMonth() + Math.max(1, Math.min(12, Number(payment.months || 1))));

    const { error: membershipError } = await admin.from("memberships").update({ plan: "vip", status: "active", vip_until: until.toISOString() }).eq("user_id", payment.user_id);
    if (membershipError) return json({ error: "MEMBERSHIP_UPDATE_FAILED" }, 500);
    await admin.from("payment_requests").update({
      status: "approved",
      auto_verified: true,
      reviewed_at: new Date().toISOString(),
      admin_note: "Tự động xác nhận đủ tiền qua payOS webhook"
    }).eq("id", payment.id);
  }

  return json({ ok: true, paymentId: payment.id, expectedAmount, totalPaid, providerState });
});
