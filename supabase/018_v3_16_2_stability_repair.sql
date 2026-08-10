-- NTS Logo Studio Web V3.16.2
-- STABILITY REPAIR: avatar RPC ambiguity + health version marker
-- Safe additive repair for databases that already ran V3.15/V3.16 migrations.
-- Does not delete messages, users, payments, memberships or media.

begin;

-- Ensure columns used by the stable avatar path exist even on partially migrated databases.
alter table public.profiles add column if not exists avatar_thumb_data text;
alter table public.member_public_profiles add column if not exists avatar_thumb_data text;
alter table public.profiles add column if not exists avatar_revision bigint not null default 0;
alter table public.member_public_profiles add column if not exists avatar_revision bigint not null default 0;
alter table public.member_public_profiles add column if not exists avatar_updated_at timestamptz;

-- New unambiguous RPC. Returns JSONB deliberately so OUT-parameter names can never
-- collide with columns such as user_id / avatar_revision / updated_at.
create or replace function public.set_my_avatar_thumb_v3162(
  p_thumb text,
  p_revision bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_revision bigint := 0;
  v_result jsonb;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;

  if p_thumb is not null then
    if char_length(p_thumb) > 180000 then raise exception 'AVATAR_THUMB_TOO_LARGE'; end if;
    if p_thumb !~ '^data:image/(jpeg|jpg|png|webp);base64,' then raise exception 'AVATAR_THUMB_INVALID'; end if;
  end if;

  select greatest(coalesce(p_revision,0), coalesce(pr.avatar_revision,0))
    into v_revision
  from public.profiles as pr
  where pr.id = v_uid;
  v_revision := coalesce(v_revision, coalesce(p_revision,0), 0);

  update public.profiles as pr
     set avatar_thumb_data = p_thumb,
         avatar_revision = greatest(coalesce(pr.avatar_revision,0), v_revision),
         updated_at = now()
   where pr.id = v_uid;

  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;

  -- Keep the public projection in sync without depending on the historical trigger chain.
  insert into public.member_public_profiles as mp (
    user_id, display_name, avatar_url, oauth_avatar_url, avatar_object_path,
    avatar_revision, avatar_updated_at, avatar_thumb_data,
    role, plan, status, vip_until, updated_at
  )
  select
    pr.id,
    coalesce(nullif(pr.display_name,''),'Hội viên'),
    pr.avatar_url,
    coalesce(nullif(au.raw_user_meta_data->>'avatar_url',''), nullif(au.raw_user_meta_data->>'picture','')),
    pr.avatar_object_path,
    greatest(coalesce(pr.avatar_revision,0), v_revision),
    now(),
    p_thumb,
    coalesce(ms.role,'member'),
    coalesce(ms.plan,'free'),
    coalesce(ms.status,'active'),
    ms.vip_until,
    now()
  from public.profiles as pr
  left join public.memberships as ms on ms.user_id = pr.id
  left join auth.users as au on au.id = pr.id
  where pr.id = v_uid
  on conflict (user_id) do update set
    display_name = excluded.display_name,
    avatar_url = excluded.avatar_url,
    oauth_avatar_url = excluded.oauth_avatar_url,
    avatar_object_path = excluded.avatar_object_path,
    avatar_revision = greatest(coalesce(mp.avatar_revision,0), coalesce(excluded.avatar_revision,0)),
    avatar_updated_at = excluded.avatar_updated_at,
    avatar_thumb_data = excluded.avatar_thumb_data,
    role = excluded.role,
    plan = excluded.plan,
    status = excluded.status,
    vip_until = excluded.vip_until,
    updated_at = now();

  select jsonb_build_object(
    'user_id', mp.user_id,
    'avatar_revision', mp.avatar_revision,
    'updated_at', mp.updated_at,
    'has_thumb', mp.avatar_thumb_data is not null
  ) into v_result
  from public.member_public_profiles as mp
  where mp.user_id = v_uid;

  return coalesce(v_result, jsonb_build_object('user_id',v_uid,'avatar_revision',v_revision,'has_thumb',p_thumb is not null));
end;
$$;
revoke all on function public.set_my_avatar_thumb_v3162(text,bigint) from public;
grant execute on function public.set_my_avatar_thumb_v3162(text,bigint) to authenticated;

-- Repair the historical V3.15 RPC too so older cached clients remain compatible.
-- Same return type/signature as V3.15; every column reference is fully qualified.
create or replace function public.set_my_avatar_thumb_v315(
  p_thumb text,
  p_revision bigint default null
)
returns table (
  user_id uuid,
  avatar_thumb_data text,
  avatar_revision bigint,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_revision bigint := 0;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_thumb is not null then
    if char_length(p_thumb) > 180000 then raise exception 'AVATAR_THUMB_TOO_LARGE'; end if;
    if p_thumb !~ '^data:image/(jpeg|jpg|png|webp);base64,' then raise exception 'AVATAR_THUMB_INVALID'; end if;
  end if;

  select greatest(coalesce(p_revision,0), coalesce(pr.avatar_revision,0))
    into v_revision
  from public.profiles as pr
  where pr.id = v_uid;
  v_revision := coalesce(v_revision, coalesce(p_revision,0), 0);

  update public.profiles as pr
     set avatar_thumb_data = p_thumb,
         avatar_revision = greatest(coalesce(pr.avatar_revision,0), v_revision),
         updated_at = now()
   where pr.id = v_uid;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;

  insert into public.member_public_profiles as mp (
    user_id, display_name, avatar_url, oauth_avatar_url, avatar_object_path,
    avatar_revision, avatar_updated_at, avatar_thumb_data,
    role, plan, status, vip_until, updated_at
  )
  select
    pr.id,
    coalesce(nullif(pr.display_name,''),'Hội viên'),
    pr.avatar_url,
    coalesce(nullif(au.raw_user_meta_data->>'avatar_url',''), nullif(au.raw_user_meta_data->>'picture','')),
    pr.avatar_object_path,
    greatest(coalesce(pr.avatar_revision,0), v_revision),
    now(), p_thumb,
    coalesce(ms.role,'member'), coalesce(ms.plan,'free'), coalesce(ms.status,'active'), ms.vip_until, now()
  from public.profiles as pr
  left join public.memberships as ms on ms.user_id = pr.id
  left join auth.users as au on au.id = pr.id
  where pr.id = v_uid
  on conflict (user_id) do update set
    display_name = excluded.display_name,
    avatar_url = excluded.avatar_url,
    oauth_avatar_url = excluded.oauth_avatar_url,
    avatar_object_path = excluded.avatar_object_path,
    avatar_revision = greatest(coalesce(mp.avatar_revision,0), coalesce(excluded.avatar_revision,0)),
    avatar_updated_at = excluded.avatar_updated_at,
    avatar_thumb_data = excluded.avatar_thumb_data,
    role = excluded.role,
    plan = excluded.plan,
    status = excluded.status,
    vip_until = excluded.vip_until,
    updated_at = now();

  return query
  select mp.user_id, mp.avatar_thumb_data, mp.avatar_revision, mp.updated_at
  from public.member_public_profiles as mp
  where mp.user_id = v_uid;
end;
$$;
revoke all on function public.set_my_avatar_thumb_v315(text,bigint) from public;
grant execute on function public.set_my_avatar_thumb_v315(text,bigint) to authenticated;

-- Lightweight health endpoint for the stabilized build.
create or replace function public.system_health_v3162()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_core boolean := false;
  v_community boolean := false;
  v_payment boolean := false;
  v_avatar boolean := false;
  v_admin boolean := false;
begin
  v_core := to_regclass('public.profiles') is not null
    and to_regclass('public.memberships') is not null
    and to_regprocedure('public.get_my_account_state()') is not null;
  v_community := to_regclass('public.friendships') is not null
    and to_regclass('public.direct_messages') is not null
    and (to_regprocedure('public.list_direct_messages_v311(uuid,integer,timestamp with time zone)') is not null
      or to_regprocedure('public.list_direct_messages_v3101(uuid,integer,timestamp with time zone)') is not null);
  v_payment := to_regclass('public.payment_requests') is not null
    and to_regclass('public.payment_events') is not null;
  v_avatar := to_regclass('public.member_public_profiles') is not null
    and to_regprocedure('public.set_my_avatar_thumb_v3162(text,bigint)') is not null
    and (to_regprocedure('public.list_member_directory_v316(text,integer)') is not null
      or to_regprocedure('public.list_member_directory_v3131(text,integer)') is not null);
  v_admin := to_regprocedure('public.admin_stats()') is not null
    and to_regprocedure('public.admin_list_members(text)') is not null;
  return jsonb_build_object(
    'version','3.16.2',
    'core_ready',v_core,
    'community_ready',v_community,
    'payment_ready',v_payment,
    'avatar_ready',v_avatar,
    'admin_ready',v_admin,
    'authenticated',v_uid is not null
  );
end;
$$;
revoke all on function public.system_health_v3162() from public;
grant execute on function public.system_health_v3162() to authenticated;

create table if not exists public.nts_schema_versions(
  version text primary key,
  applied_at timestamptz not null default now(),
  notes text
);
insert into public.nts_schema_versions(version,notes)
values('3.16.2','Runtime stability repair: avatar ambiguity + request storm hardening')
on conflict(version) do update set applied_at=now(),notes=excluded.notes;

notify pgrst, 'reload schema';
commit;
