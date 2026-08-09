-- NTS Logo Studio Web V3.13
-- REALTIME AVATAR FAST SYNC
-- Run AFTER migration 011.
-- Goals:
--   1) Never rely on overwriting one cached avatar URL for cross-account display.
--   2) Publish safe member avatar metadata in a dedicated realtime table.
--   3) Keep every older RPC/table/function intact for rollback compatibility.
--   4) Allow the Facebook-like crop editor's 100..500% zoom range in the DB.

begin;

-- ---------------------------------------------------------------------------
-- 1. Profile media revision metadata. Existing columns/functions are preserved.
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists avatar_object_path text;
alter table public.profiles add column if not exists cover_object_path text;
alter table public.profiles add column if not exists avatar_revision bigint not null default 0;
alter table public.profiles add column if not exists cover_revision bigint not null default 0;

-- Older V3.5 constraints only allowed 100..220 although the newer crop UI allows
-- up to 500. Replace only those constraints; no profile data is removed.
alter table public.profiles drop constraint if exists profiles_avatar_zoom_range;
alter table public.profiles add constraint profiles_avatar_zoom_range check (avatar_zoom between 100 and 500);
alter table public.profiles drop constraint if exists profiles_cover_zoom_range;
alter table public.profiles add constraint profiles_cover_zoom_range check (cover_zoom between 100 and 500);

-- Keep public delivery + own-folder write rules for all versioned media paths.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('profile-media','profile-media',true,5242880,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set
  public=true,
  file_size_limit=5242880,
  allowed_mime_types=array['image/jpeg','image/png','image/webp'];

drop policy if exists profile_media_select_all on storage.objects;
create policy profile_media_select_all on storage.objects
for select to anon, authenticated
using (bucket_id='profile-media');

drop policy if exists profile_media_insert_own on storage.objects;
create policy profile_media_insert_own on storage.objects
for insert to authenticated
with check (bucket_id='profile-media' and (storage.foldername(name))[1]=auth.uid()::text);

drop policy if exists profile_media_update_own on storage.objects;
create policy profile_media_update_own on storage.objects
for update to authenticated
using (bucket_id='profile-media' and (storage.foldername(name))[1]=auth.uid()::text)
with check (bucket_id='profile-media' and (storage.foldername(name))[1]=auth.uid()::text);

drop policy if exists profile_media_delete_own on storage.objects;
create policy profile_media_delete_own on storage.objects
for delete to authenticated
using (bucket_id='profile-media' and (storage.foldername(name))[1]=auth.uid()::text);

-- ---------------------------------------------------------------------------
-- 2. Safe public member projection.
--    This table intentionally excludes email, bio and other private profile data.
-- ---------------------------------------------------------------------------
create table if not exists public.member_public_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Hội viên',
  avatar_url text,
  oauth_avatar_url text,
  avatar_object_path text,
  avatar_revision bigint not null default 0,
  avatar_updated_at timestamptz,
  role text not null default 'member' check (role in ('member','admin')),
  plan text not null default 'free' check (plan in ('free','vip')),
  status text not null default 'active' check (status in ('active','suspended')),
  vip_until timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.member_public_profiles enable row level security;
alter table public.member_public_profiles replica identity full;
drop policy if exists member_public_profiles_read_authenticated on public.member_public_profiles;
create policy member_public_profiles_read_authenticated on public.member_public_profiles
for select to authenticated using (true);

-- Browser clients must never directly mutate the public projection.
revoke insert, update, delete on public.member_public_profiles from anon, authenticated;
grant select on public.member_public_profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Projection synchronizer.
-- ---------------------------------------------------------------------------
create or replace function public.sync_member_public_profile_v313(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public, auth, storage
as $$
declare
  v_profile public.profiles%rowtype;
  v_membership public.memberships%rowtype;
  v_oauth text;
  v_storage_path text;
  v_storage_updated timestamptz;
begin
  select * into v_profile from public.profiles where id=p_user;
  if not found then
    delete from public.member_public_profiles where user_id=p_user;
    return;
  end if;

  select * into v_membership from public.memberships where user_id=p_user;
  select coalesce(nullif(u.raw_user_meta_data->>'avatar_url',''), nullif(u.raw_user_meta_data->>'picture',''))
    into v_oauth
  from auth.users u where u.id=p_user;

  -- Prefer the explicit versioned object written by V3.13. For legacy members,
  -- discover the newest avatar object without requiring JavaScript to guess paths.
  if nullif(v_profile.avatar_object_path,'') is not null then
    select o.name,o.updated_at into v_storage_path,v_storage_updated
    from storage.objects o
    where o.bucket_id='profile-media' and o.name=v_profile.avatar_object_path
    order by o.updated_at desc nulls last limit 1;
  end if;

  if v_storage_path is null then
    select o.name,o.updated_at into v_storage_path,v_storage_updated
    from storage.objects o
    where o.bucket_id='profile-media'
      and (
        o.name=p_user::text||'/avatar.jpg'
        or o.name like p_user::text||'/avatar/%'
      )
    order by o.updated_at desc nulls last
    limit 1;
  end if;

  insert into public.member_public_profiles(
    user_id,display_name,avatar_url,oauth_avatar_url,avatar_object_path,
    avatar_revision,avatar_updated_at,role,plan,status,vip_until,updated_at
  ) values (
    p_user,
    coalesce(nullif(v_profile.display_name,''),'Hội viên'),
    nullif(v_profile.avatar_url,''),
    v_oauth,
    v_storage_path,
    greatest(coalesce(v_profile.avatar_revision,0),0),
    coalesce(v_storage_updated,v_profile.updated_at),
    coalesce(v_membership.role,'member'),
    coalesce(v_membership.plan,'free'),
    coalesce(v_membership.status,'active'),
    v_membership.vip_until,
    now()
  )
  on conflict(user_id) do update set
    display_name=excluded.display_name,
    avatar_url=excluded.avatar_url,
    oauth_avatar_url=excluded.oauth_avatar_url,
    avatar_object_path=excluded.avatar_object_path,
    avatar_revision=excluded.avatar_revision,
    avatar_updated_at=excluded.avatar_updated_at,
    role=excluded.role,
    plan=excluded.plan,
    status=excluded.status,
    vip_until=excluded.vip_until,
    updated_at=now();
end;
$$;
revoke all on function public.sync_member_public_profile_v313(uuid) from public;

create or replace function public.trg_sync_member_public_profile_v313()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_member_public_profile_v313(
    case when tg_table_name='profiles' then new.id
         else new.user_id end
  );
  return new;
end;
$$;

-- Preserve all old triggers; these new triggers only maintain the projection.
drop trigger if exists profiles_public_projection_v313 on public.profiles;
create trigger profiles_public_projection_v313
after insert or update on public.profiles
for each row execute function public.trg_sync_member_public_profile_v313();

drop trigger if exists memberships_public_projection_v313 on public.memberships;
create trigger memberships_public_projection_v313
after insert or update on public.memberships
for each row execute function public.trg_sync_member_public_profile_v313();

-- Initial backfill. Existing profile rows and storage objects remain untouched.
do $$
declare r record;
begin
  for r in select id from public.profiles loop
    perform public.sync_member_public_profile_v313(r.id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Realtime publication. Duplicate-object is intentionally ignored.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    alter publication supabase_realtime add table public.member_public_profiles;
  exception when duplicate_object then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 5. V3.13 directory RPCs. Old v312/v311/v310 RPCs remain installed as fallback.
-- ---------------------------------------------------------------------------
create or replace function public.get_member_public_profile_v313(p_user uuid)
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
    mp.user_id,mp.display_name,mp.avatar_url,mp.oauth_avatar_url,
    mp.avatar_object_path,mp.avatar_updated_at,mp.avatar_revision,
    mp.role,mp.plan,
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
revoke all on function public.get_member_public_profile_v313(uuid) from public;
grant execute on function public.get_member_public_profile_v313(uuid) to authenticated;

create or replace function public.list_member_directory_v313(p_search text default '', p_limit integer default 60)
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
    mp.user_id,mp.display_name,mp.avatar_url,mp.oauth_avatar_url,
    mp.avatar_object_path,mp.avatar_updated_at,mp.avatar_revision,
    mp.role,mp.plan,
    (mp.role='admin' or (mp.plan='vip' and mp.status='active' and (mp.vip_until is null or mp.vip_until>now()))),
    f.id,f.status,
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
revoke all on function public.list_member_directory_v313(text,integer) from public;
grant execute on function public.list_member_directory_v313(text,integer) to authenticated;

create or replace function public.list_messenger_contacts_v313(p_limit integer default 60)
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
  last_at timestamptz,
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
    where auth.uid() is not null
      and f.status='accepted'
      and (f.requester_id=auth.uid() or f.addressee_id=auth.uid())
  )
  select
    a.peer_id,mp.display_name,mp.avatar_url,mp.oauth_avatar_url,
    mp.avatar_object_path,mp.avatar_updated_at,mp.avatar_revision,
    mp.role,mp.plan,
    (mp.role='admin' or (mp.plan='vip' and mp.status='active' and (mp.vip_until is null or mp.vip_until>now()))),
    case when lm.revoked_at is not null then 'Tin nhắn đã được thu hồi' else lm.body end,
    lm.created_at,
    coalesce(uc.unread_count,0)::bigint
  from accepted a
  join public.member_public_profiles mp on mp.user_id=a.peer_id
  left join lateral (
    select dm.body,dm.created_at,dm.revoked_at
    from public.direct_messages dm
    where dm.deleted_at is null
      and ((dm.sender_id=auth.uid() and dm.recipient_id=a.peer_id)
        or (dm.sender_id=a.peer_id and dm.recipient_id=auth.uid()))
    order by dm.created_at desc limit 1
  ) lm on true
  left join lateral (
    select count(*) as unread_count
    from public.direct_messages dm
    where dm.deleted_at is null
      and dm.sender_id=a.peer_id
      and dm.recipient_id=auth.uid()
      and dm.read_at is null
  ) uc on true
  where mp.status<>'suspended'
  order by lm.created_at desc nulls last, lower(mp.display_name)
  limit greatest(1,least(coalesce(p_limit,60),100));
$$;
revoke all on function public.list_messenger_contacts_v313(integer) from public;
grant execute on function public.list_messenger_contacts_v313(integer) to authenticated;

-- Diagnostic helper for one member. Safe fields only.
create or replace function public.debug_member_avatar_v313(p_user uuid)
returns table (
  user_id uuid,
  avatar_url text,
  avatar_object_path text,
  avatar_revision bigint,
  avatar_updated_at timestamptz,
  projection_updated_at timestamptz
)
language sql
stable
security definer
set search_path=public
as $$
  select mp.user_id,mp.avatar_url,mp.avatar_object_path,mp.avatar_revision,mp.avatar_updated_at,mp.updated_at
  from public.member_public_profiles mp
  where auth.uid() is not null and mp.user_id=p_user
  limit 1;
$$;
revoke all on function public.debug_member_avatar_v313(uuid) from public;
grant execute on function public.debug_member_avatar_v313(uuid) to authenticated;

commit;
