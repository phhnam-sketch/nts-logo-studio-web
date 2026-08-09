-- NTS Logo Studio Web V3.15
-- INLINE MINI-AVATAR SYNC
-- Goal: make small avatars in Community / Messages / Messenger independent of Storage/CDN timing.
-- Additive migration. No messages, friendships, payments or legacy avatar fields are removed.

begin;

-- Reassert cross-account read access for legacy/full avatar fallback. The new inline
-- thumbnail path does not depend on this, but old avatars can self-heal immediately.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('profile-media','profile-media',true,5242880,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=true, file_size_limit=excluded.file_size_limit, allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists profile_media_select_all on storage.objects;
create policy profile_media_select_all on storage.objects
for select to anon, authenticated
using (bucket_id='profile-media');

alter table public.profiles
  add column if not exists avatar_thumb_data text;

alter table public.member_public_profiles
  add column if not exists avatar_thumb_data text;

-- Keep the inline thumbnail intentionally small. 180k chars is far above the normal
-- 160x160 JPEG output but blocks accidental multi-megabyte payloads.
alter table public.profiles drop constraint if exists profiles_avatar_thumb_data_size;
alter table public.profiles add constraint profiles_avatar_thumb_data_size
check (
  avatar_thumb_data is null
  or (
    char_length(avatar_thumb_data) <= 180000
    and avatar_thumb_data ~ '^data:image/(jpeg|jpg|png|webp);base64,'
  )
) not valid;
alter table public.profiles validate constraint profiles_avatar_thumb_data_size;

alter table public.member_public_profiles drop constraint if exists member_public_profiles_avatar_thumb_data_size;
alter table public.member_public_profiles add constraint member_public_profiles_avatar_thumb_data_size
check (
  avatar_thumb_data is null
  or (
    char_length(avatar_thumb_data) <= 180000
    and avatar_thumb_data ~ '^data:image/(jpeg|jpg|png|webp);base64,'
  )
) not valid;
alter table public.member_public_profiles validate constraint member_public_profiles_avatar_thumb_data_size;

-- Owner-only publisher. The browser cannot publish a thumbnail for another user.
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
  v_revision bigint;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if p_thumb is not null then
    if char_length(p_thumb) > 180000 then
      raise exception 'AVATAR_THUMB_TOO_LARGE';
    end if;
    if p_thumb !~ '^data:image/(jpeg|jpg|png|webp);base64,' then
      raise exception 'AVATAR_THUMB_INVALID';
    end if;
  end if;

  select greatest(coalesce(p_revision,0), coalesce(p.avatar_revision,0))
    into v_revision
  from public.profiles p
  where p.id = v_uid;

  if v_revision is null then
    v_revision := coalesce(p_revision,0);
  end if;

  update public.profiles
     set avatar_thumb_data = p_thumb
   where id = v_uid;

  -- Reuse the existing projection repair when present, but do not depend on it
  -- for the inline thumbnail itself.
  if to_regprocedure('public.sync_member_public_profile_v313(uuid)') is not null then
    perform public.sync_member_public_profile_v313(v_uid);
  end if;

  update public.member_public_profiles
     set avatar_thumb_data = p_thumb,
         avatar_revision = greatest(coalesce(avatar_revision,0), coalesce(v_revision,0)),
         avatar_updated_at = now(),
         updated_at = now()
   where user_id = v_uid;

  -- In case an old installation has no projection row yet, create it from the user's profile.
  if not found then
    insert into public.member_public_profiles (
      user_id, display_name, avatar_url, oauth_avatar_url, avatar_object_path,
      avatar_revision, avatar_updated_at, avatar_thumb_data,
      role, plan, status, vip_until, updated_at
    )
    select
      p.id,
      coalesce(nullif(p.display_name,''),'Hội viên'),
      p.avatar_url,
      null,
      p.avatar_object_path,
      greatest(coalesce(p.avatar_revision,0),coalesce(v_revision,0)),
      now(),
      p_thumb,
      coalesce(m.role,'member'),
      coalesce(m.plan,'free'),
      coalesce(m.status,'active'),
      m.vip_until,
      now()
    from public.profiles p
    left join public.memberships m on m.user_id=p.id
    where p.id=v_uid
    on conflict (user_id) do update set
      avatar_thumb_data=excluded.avatar_thumb_data,
      avatar_revision=greatest(coalesce(public.member_public_profiles.avatar_revision,0),coalesce(excluded.avatar_revision,0)),
      avatar_updated_at=now(),
      updated_at=now();
  end if;

  return query
  select mp.user_id, mp.avatar_thumb_data, mp.avatar_revision, mp.updated_at
  from public.member_public_profiles mp
  where mp.user_id=v_uid;
end;
$$;
revoke all on function public.set_my_avatar_thumb_v315(text,bigint) from public;
grant execute on function public.set_my_avatar_thumb_v315(text,bigint) to authenticated;

-- Batch map used only for small avatars. Inline data is returned first; old Storage
-- metadata remains available as fallback so no legacy functionality is removed.
create or replace function public.get_member_avatar_map_v315(p_user_ids uuid[])
returns table (
  user_id uuid,
  display_name text,
  avatar_thumb_data text,
  avatar_url text,
  oauth_avatar_url text,
  avatar_storage_path text,
  avatar_storage_version timestamptz,
  avatar_revision bigint,
  avatar_crop_version integer
)
language sql
stable
security definer
set search_path=public,auth,storage
as $$
  select
    p.id,
    coalesce(nullif(p.display_name,''),'Hội viên')::text,
    coalesce(mp.avatar_thumb_data,p.avatar_thumb_data)::text,
    nullif(p.avatar_url,'')::text,
    coalesce(nullif(mp.oauth_avatar_url,''), nullif(u.raw_user_meta_data->>'avatar_url',''), nullif(u.raw_user_meta_data->>'picture',''))::text,
    coalesce(nullif(mp.avatar_object_path,''), nullif(p.avatar_object_path,''), obj.name)::text,
    coalesce(mp.avatar_updated_at,obj.updated_at,p.updated_at)::timestamptz,
    greatest(coalesce(mp.avatar_revision,0),coalesce(p.avatar_revision,0),0)::bigint,
    greatest(coalesce(p.avatar_crop_version,0),0)::integer
  from public.profiles p
  left join public.member_public_profiles mp on mp.user_id=p.id
  left join auth.users u on u.id=p.id
  left join lateral (
    select o.name,o.updated_at
    from storage.objects o
    where o.bucket_id='profile-media'
      and (
        (nullif(p.avatar_object_path,'') is not null and o.name=p.avatar_object_path)
        or o.name=p.id::text||'/avatar.jpg'
        or o.name like p.id::text||'/avatar/%'
      )
    order by
      case when nullif(p.avatar_object_path,'') is not null and o.name=p.avatar_object_path then 0
           when o.name like p.id::text||'/avatar/%' then 1
           when o.name=p.id::text||'/avatar.jpg' then 2
           else 3 end,
      o.updated_at desc nulls last,
      o.created_at desc nulls last
    limit 1
  ) obj on true
  where auth.uid() is not null
    and p_user_ids is not null
    and p.id=any(p_user_ids)
    and coalesce(array_length(p_user_ids,1),0) <= 100;
$$;
revoke all on function public.get_member_avatar_map_v315(uuid[]) from public;
grant execute on function public.get_member_avatar_map_v315(uuid[]) to authenticated;

-- Realtime already publishes member_public_profiles in V3.13. Reassert safely.
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
