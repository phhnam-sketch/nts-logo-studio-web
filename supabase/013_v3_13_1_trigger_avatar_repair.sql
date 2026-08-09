-- NTS Logo Studio Web V3.13.1
-- TRIGGER + CROSS-ACCOUNT AVATAR REPAIR
-- Run AFTER migration 012 if V3.13 was already deployed.
-- This migration is additive/repair-only: no user data, messages, payments or old RPCs are deleted.

begin;

-- ---------------------------------------------------------------------------
-- 1) Replace the broken shared RECORD trigger with table-specific triggers.
--    public.profiles has NEW.id. public.memberships has NEW.user_id.
-- ---------------------------------------------------------------------------
create or replace function public.trg_sync_profile_public_v3131()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_member_public_profile_v313(new.id);
  return new;
end;
$$;

create or replace function public.trg_sync_membership_public_v3131()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_member_public_profile_v313(new.user_id);
  return new;
end;
$$;

-- Remove only the broken V3.13 projection triggers. Other historical triggers remain.
drop trigger if exists profiles_public_projection_v313 on public.profiles;
drop trigger if exists memberships_public_projection_v313 on public.memberships;

create trigger profiles_public_projection_v313
after insert or update on public.profiles
for each row execute function public.trg_sync_profile_public_v3131();

create trigger memberships_public_projection_v313
after insert or update on public.memberships
for each row execute function public.trg_sync_membership_public_v3131();

-- ---------------------------------------------------------------------------
-- 2) Owner-callable self-heal RPC. It does not accept another user's UUID,
--    therefore an authenticated browser can only refresh its own projection.
-- ---------------------------------------------------------------------------
create or replace function public.sync_my_public_profile_v3131()
returns public.member_public_profiles
language plpgsql
security definer
set search_path = public, auth, storage
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.member_public_profiles%rowtype;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  perform public.sync_member_public_profile_v313(v_uid);
  select * into v_row from public.member_public_profiles where user_id=v_uid;
  return v_row;
end;
$$;
revoke all on function public.sync_my_public_profile_v3131() from public;
grant execute on function public.sync_my_public_profile_v3131() to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Repair all current public projection rows immediately.
--    sync_member_public_profile_v313 discovers legacy avatar.jpg and versioned
--    USER_ID/avatar/*.jpg objects when profile.avatar_object_path is missing.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in select id from public.profiles loop
    perform public.sync_member_public_profile_v313(r.id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4) New RPC names for V3.13.1. Return the repaired projection directly.
--    Older RPCs remain available as fallback; nothing is dropped.
-- ---------------------------------------------------------------------------
create or replace function public.get_member_public_profile_v3131(p_user uuid)
returns table (
  user_id uuid,
  display_name text,
  avatar_url text,
  oauth_avatar_url text,
  avatar_storage_path text,
  avatar_storage_version timestamptz,
  avatar_revision bigint,
  role text,
  plan text,
  is_vip boolean,
  friendship_status text
)
language sql
stable
security definer
set search_path=public
as $$
  select
    mp.user_id, mp.display_name, mp.avatar_url, mp.oauth_avatar_url,
    mp.avatar_object_path, mp.avatar_updated_at, mp.avatar_revision,
    mp.role, mp.plan,
    (mp.role='admin' or (mp.plan='vip' and mp.status='active' and (mp.vip_until is null or mp.vip_until>now()))),
    f.status
  from public.member_public_profiles mp
  left join public.friendships f
    on ((f.requester_id=auth.uid() and f.addressee_id=mp.user_id)
     or (f.addressee_id=auth.uid() and f.requester_id=mp.user_id))
  where auth.uid() is not null
    and mp.user_id=p_user
    and mp.user_id<>auth.uid()
    and mp.status<>'suspended'
  limit 1;
$$;
revoke all on function public.get_member_public_profile_v3131(uuid) from public;
grant execute on function public.get_member_public_profile_v3131(uuid) to authenticated;

create or replace function public.list_member_directory_v3131(p_search text default '', p_limit integer default 60)
returns table (
  user_id uuid,
  display_name text,
  avatar_url text,
  oauth_avatar_url text,
  avatar_storage_path text,
  avatar_storage_version timestamptz,
  avatar_revision bigint,
  role text,
  plan text,
  is_vip boolean,
  friendship_id uuid,
  friendship_status text,
  friendship_direction text
)
language sql
stable
security definer
set search_path=public
as $$
  select
    mp.user_id, mp.display_name, mp.avatar_url, mp.oauth_avatar_url,
    mp.avatar_object_path, mp.avatar_updated_at, mp.avatar_revision,
    mp.role, mp.plan,
    (mp.role='admin' or (mp.plan='vip' and mp.status='active' and (mp.vip_until is null or mp.vip_until>now()))),
    f.id, f.status,
    case when f.requester_id=auth.uid() then 'outgoing'
         when f.addressee_id=auth.uid() then 'incoming'
         else null end
  from public.member_public_profiles mp
  left join public.friendships f
    on ((f.requester_id=auth.uid() and f.addressee_id=mp.user_id)
     or (f.addressee_id=auth.uid() and f.requester_id=mp.user_id))
  where auth.uid() is not null
    and mp.user_id<>auth.uid()
    and mp.status<>'suspended'
    and (coalesce(btrim(p_search),'')='' or mp.display_name ilike '%'||btrim(p_search)||'%')
  order by
    case when f.status='accepted' then 0 when f.status='pending' then 1 else 2 end,
    case when mp.role='admin' then 0 when mp.plan='vip' then 1 else 2 end,
    lower(mp.display_name)
  limit greatest(1,least(coalesce(p_limit,60),100));
$$;
revoke all on function public.list_member_directory_v3131(text,integer) from public;
grant execute on function public.list_member_directory_v3131(text,integer) to authenticated;

-- Messenger contacts reuse the existing stable V3.13 function after projection repair.
-- We expose a new name so the frontend can positively detect that Migration 013 exists.
create or replace function public.list_messenger_contacts_v3131(p_limit integer default 60)
returns table (
  peer_id uuid,
  display_name text,
  avatar_url text,
  oauth_avatar_url text,
  avatar_storage_path text,
  avatar_storage_version timestamptz,
  avatar_revision bigint,
  role text,
  plan text,
  is_vip boolean,
  last_message text,
  last_message_at timestamptz,
  unread_count bigint
)
language sql
stable
security definer
set search_path=public
as $$
  with accepted as (
    select case when f.requester_id=auth.uid() then f.addressee_id else f.requester_id end as peer_id
    from public.friendships f
    where f.status='accepted' and (f.requester_id=auth.uid() or f.addressee_id=auth.uid())
  ), last_msg as (
    select distinct on (case when d.sender_id=auth.uid() then d.recipient_id else d.sender_id end)
      case when d.sender_id=auth.uid() then d.recipient_id else d.sender_id end as peer_id,
      case when d.revoked_at is not null then 'Tin nhắn đã được thu hồi' else d.body end as last_message,
      d.created_at as last_message_at
    from public.direct_messages d
    where d.deleted_at is null and (d.sender_id=auth.uid() or d.recipient_id=auth.uid())
    order by case when d.sender_id=auth.uid() then d.recipient_id else d.sender_id end, d.created_at desc
  ), unread as (
    select d.sender_id as peer_id, count(*)::bigint unread_count
    from public.direct_messages d
    where d.recipient_id=auth.uid() and d.read_at is null and d.deleted_at is null
    group by d.sender_id
  )
  select
    mp.user_id, mp.display_name, mp.avatar_url, mp.oauth_avatar_url,
    mp.avatar_object_path, mp.avatar_updated_at, mp.avatar_revision,
    mp.role, mp.plan,
    (mp.role='admin' or (mp.plan='vip' and mp.status='active' and (mp.vip_until is null or mp.vip_until>now()))),
    lm.last_message, lm.last_message_at, coalesce(u.unread_count,0)::bigint
  from accepted a
  join public.member_public_profiles mp on mp.user_id=a.peer_id
  left join last_msg lm on lm.peer_id=a.peer_id
  left join unread u on u.peer_id=a.peer_id
  where mp.status<>'suspended'
  order by coalesce(lm.last_message_at, mp.updated_at) desc nulls last, lower(mp.display_name)
  limit greatest(1,least(coalesce(p_limit,60),100));
$$;
revoke all on function public.list_messenger_contacts_v3131(integer) from public;
grant execute on function public.list_messenger_contacts_v3131(integer) to authenticated;

-- Ensure Realtime publication contains the projection table.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='member_public_profiles'
  ) then
    alter publication supabase_realtime add table public.member_public_profiles;
  end if;
end $$;

commit;
