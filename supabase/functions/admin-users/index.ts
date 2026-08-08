import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !anonKey || !serviceKey) return json({ error: "SERVER_ENV_NOT_READY" }, 500);

    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "NOT_AUTHENTICATED" }, 401);

    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: callerData, error: callerError } = await userClient.auth.getUser();
    if (callerError || !callerData.user) return json({ error: "NOT_AUTHENTICATED" }, 401);

    const service = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: callerMembership, error: membershipError } = await service
      .from("memberships")
      .select("role,status")
      .eq("user_id", callerData.user.id)
      .single();
    if (membershipError || callerMembership?.role !== "admin" || callerMembership?.status !== "active") {
      return json({ error: "ADMIN_REQUIRED" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    if (action === "create") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const displayName = String(body.display_name || "").trim();
      const bio = String(body.bio || "").trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: "INVALID_EMAIL" }, 400);
      if (password.length < 8) return json({ error: "PASSWORD_TOO_SHORT" }, 400);
      if (!displayName || displayName.length > 60) return json({ error: "INVALID_DISPLAY_NAME" }, 400);

      const { data, error } = await service.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: displayName },
      });
      if (error || !data.user) return json({ error: error?.message || "CREATE_USER_FAILED" }, 400);

      const uid = data.user.id;
      await service.from("profiles").upsert({ id: uid, display_name: displayName, bio: bio.slice(0, 500) }, { onConflict: "id" });
      const plan = body.plan === "vip" ? "vip" : "free";
      const status = body.status === "suspended" ? "suspended" : "active";
      let vipUntil = body.vip_until || null;
      if (plan === "vip" && !vipUntil) vipUntil = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
      const membershipPatch: Record<string, unknown> = { plan, status, vip_until: plan === "vip" ? vipUntil : null };
      if (body.free_limit !== null && body.free_limit !== undefined && body.free_limit !== "") membershipPatch.free_limit = Number(body.free_limit);
      await service.from("memberships").upsert({ user_id: uid, ...membershipPatch }, { onConflict: "user_id" });
      return json({ ok: true, user_id: uid });
    }

    if (action === "update-auth") {
      const uid = String(body.user_id || "");
      if (!uid) return json({ error: "USER_ID_REQUIRED" }, 400);
      const { data: targetData, error: targetError } = await service.auth.admin.getUserById(uid);
      if (targetError || !targetData.user) return json({ error: targetError?.message || "USER_NOT_FOUND" }, 404);
      const patch: Record<string, unknown> = {};
      const email = String(body.email || "").trim().toLowerCase();
      if (email && email !== String(targetData.user.email || "").toLowerCase()) patch.email = email;
      const password = body.password ? String(body.password) : "";
      if (password) {
        if (password.length < 8) return json({ error: "PASSWORD_TOO_SHORT" }, 400);
        patch.password = password;
      }
      const displayName = String(body.display_name || "").trim();
      if (displayName) patch.user_metadata = { ...(targetData.user.user_metadata || {}), display_name: displayName };
      if (Object.keys(patch).length) {
        const { error } = await service.auth.admin.updateUserById(uid, patch);
        if (error) return json({ error: error.message }, 400);
      }
      return json({ ok: true });
    }

    if (action === "delete") {
      const uid = String(body.user_id || "");
      if (!uid) return json({ error: "USER_ID_REQUIRED" }, 400);
      if (uid === callerData.user.id) return json({ error: "CANNOT_DELETE_SELF" }, 400);

      // Best-effort cleanup of user-owned Storage files before Auth deletion.
      for (const bucket of ["profile-media", "payment-proofs"]) {
        const { data: objects } = await service.storage.from(bucket).list(uid, { limit: 1000 });
        const paths = (objects || []).filter((o) => o.name && o.name !== ".emptyFolderPlaceholder").map((o) => `${uid}/${o.name}`);
        if (paths.length) await service.storage.from(bucket).remove(paths);
      }

      const { error } = await service.auth.admin.deleteUser(uid);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "INVALID_ACTION" }, 400);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
