-- NTS Logo Studio V3.17 - Data Stability Core
-- Purpose: replace the startup request fan-out with one bootstrap RPC.
-- This migration only ADDS new RPCs/indexes; it does not drop legacy tables/functions.

begin;

create table if not exists public.nts_schema_versions (
  version text primary key,
  applied_at timestamptz not null default now(),
  notes text
);

-- Low-risk indexes used by existing admin/payment reads. Keep the repair migration
-- safe even on an older database where one optional table is not installed yet.
do $$
begin
  if to_regclass('public.memberships') is not null then
    execute 'create index if not exists memberships_role_status_idx on public.memberships(role, status)';
  end if;
  if to_regclass('public.payment_requests') is not null then
    execute 'create index if not exists payment_requests_user_status_created_idx on public.payment_requests(user_id, status, created_at desc)';
  end if;
end $$;

create or replace function public.app_bootstrap_v317()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_profile jsonb := null;
  v_account jsonb := null;
  v_settings jsonb := null;
  v_name text;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  -- Self-heal only the two mandatory per-user rows. Existing data is never replaced.
  select coalesce(
    nullif(trim(coalesce(u.raw_user_meta_data->>'display_name','')), ''),
    nullif(trim(coalesce(u.raw_user_meta_data->>'full_name','')), ''),
    nullif(split_part(coalesce(u.email,''), '@', 1), ''),
    'Người dùng'
  ) into v_name
  from auth.users u where u.id = v_uid;

  insert into public.profiles(id, display_name)
  values (v_uid, coalesce(v_name, 'Người dùng'))
  on conflict (id) do nothing;

  insert into public.memberships(user_id)
  values (v_uid)
  on conflict (user_id) do nothing;

  select to_jsonb(p) into v_profile
  from public.profiles p
  where p.id = v_uid;

  select to_jsonb(a) into v_account
  from public.get_my_account_state() a
  limit 1;

  select to_jsonb(s) into v_settings
  from public.site_settings s
  where s.id = true;

  return jsonb_build_object(
    'user_id', v_uid,
    'profile', v_profile,
    'account', v_account,
    'settings', v_settings,
    'server_at', now(),
    'schema_version', '3.17.0'
  );
end;
$$;

revoke all on function public.app_bootstrap_v317() from public;
grant execute on function public.app_bootstrap_v317() to authenticated;

create or replace function public.system_health_v317()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_core boolean;
  v_community boolean;
  v_payment boolean;
  v_avatar boolean;
  v_admin boolean;
begin
  v_core := to_regclass('public.profiles') is not null
    and to_regclass('public.memberships') is not null
    and to_regclass('public.site_settings') is not null
    and to_regprocedure('public.get_my_account_state()') is not null
    and to_regprocedure('public.app_bootstrap_v317()') is not null;

  v_community := to_regclass('public.friendships') is not null
    and to_regclass('public.direct_messages') is not null
    and to_regprocedure('public.send_direct_message(uuid,text)') is not null;

  v_payment := to_regclass('public.payment_requests') is not null
    and to_regclass('public.payment_events') is not null;

  v_avatar := to_regclass('public.member_public_profiles') is not null
    and exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='profiles' and column_name='avatar_thumb_data'
    );

  v_admin := to_regprocedure('public.admin_stats()') is not null
    and to_regprocedure('public.admin_list_members(text)') is not null;

  return jsonb_build_object(
    'version', '3.17.0',
    'schema_version', '3.17.0',
    'bootstrap_ready', to_regprocedure('public.app_bootstrap_v317()') is not null,
    'core_ready', v_core,
    'community_ready', v_community,
    'payment_ready', v_payment,
    'avatar_ready', v_avatar,
    'admin_ready', v_admin,
    'checked_at', now()
  );
end;
$$;

revoke all on function public.system_health_v317() from public;
grant execute on function public.system_health_v317() to authenticated;

insert into public.nts_schema_versions(version, applied_at, notes)
values ('3.17.0', now(), 'Single bootstrap RPC, reduced startup request fan-out, stable data loading core')
on conflict (version) do update
set applied_at = excluded.applied_at,
    notes = excluded.notes;

-- Ask PostgREST to refresh function/schema metadata immediately after deployment.
notify pgrst, 'reload schema';

commit;
