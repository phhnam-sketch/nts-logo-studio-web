-- NTS Logo Studio V3.14
-- Unified cross-account avatar resolver for Community / Messenger / Chat.
-- This migration is additive: it does not drop legacy RPCs, messages, friendships or profile data.

begin;

-- Reassert the public read contract used by small social avatars.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('profile-media','profile-media',true,5242880,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set
  public=true,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists profile_media_select_all on storage.objects;
create policy profile_media_select_all on storage.objects
for select to anon, authenticated
using (bucket_id='profile-media');

-- Resolve avatar data LIVE from profiles + auth metadata + actual Storage objects.
-- It intentionally does not depend only on member_public_profiles, so old/stale projection rows
-- cannot force another account to keep seeing a default avatar.
create or replace function public.get_member_avatar_map_v314(p_user_ids uuid[])
returns table (
  user_id uuid,
  display_name text,
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
    p.id as user_id,
    coalesce(nullif(p.display_name,''),'Hội viên')::text as display_name,
    nullif(p.avatar_url,'')::text as avatar_url,
    coalesce(nullif(u.raw_user_meta_data->>'avatar_url',''), nullif(u.raw_user_meta_data->>'picture',''))::text as oauth_avatar_url,
    obj.name::text as avatar_storage_path,
    coalesce(obj.updated_at,p.updated_at)::timestamptz as avatar_storage_version,
    greatest(coalesce(p.avatar_revision,0),0)::bigint as avatar_revision,
    greatest(coalesce(p.avatar_crop_version,0),0)::integer as avatar_crop_version
  from public.profiles p
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
      case
        when nullif(p.avatar_object_path,'') is not null and o.name=p.avatar_object_path then 0
        when o.name like p.id::text||'/avatar/%' then 1
        when o.name=p.id::text||'/avatar.jpg' then 2
        else 3
      end,
      o.updated_at desc nulls last,
      o.created_at desc nulls last
    limit 1
  ) obj on true
  where auth.uid() is not null
    and p_user_ids is not null
    and p.id=any(p_user_ids)
    and coalesce(array_length(p_user_ids,1),0) <= 100;
$$;
revoke all on function public.get_member_avatar_map_v314(uuid[]) from public;
grant execute on function public.get_member_avatar_map_v314(uuid[]) to authenticated;

-- Rebuild the public projection from current profile/storage state. Existing rows/data are preserved.
do $$
declare r record;
begin
  if to_regprocedure('public.sync_member_public_profile_v313(uuid)') is not null then
    for r in select id from public.profiles loop
      perform public.sync_member_public_profile_v313(r.id);
    end loop;
  end if;
end $$;

-- Diagnostic helper: one row showing what every social surface should resolve for a user.
create or replace function public.debug_member_avatar_v314(p_user uuid)
returns table (
  user_id uuid,
  profile_avatar_url text,
  profile_avatar_object_path text,
  live_storage_path text,
  live_storage_updated_at timestamptz,
  projection_avatar_url text,
  projection_avatar_object_path text,
  projection_avatar_revision bigint
)
language sql
stable
security definer
set search_path=public,storage
as $$
  select
    p.id,
    p.avatar_url,
    p.avatar_object_path,
    live.name,
    live.updated_at,
    mp.avatar_url,
    mp.avatar_object_path,
    mp.avatar_revision
  from public.profiles p
  left join public.member_public_profiles mp on mp.user_id=p.id
  left join lateral (
    select o.name,o.updated_at
    from storage.objects o
    where o.bucket_id='profile-media'
      and (o.name=p.avatar_object_path or o.name=p.id::text||'/avatar.jpg' or o.name like p.id::text||'/avatar/%')
    order by case when o.name=p.avatar_object_path then 0 when o.name like p.id::text||'/avatar/%' then 1 else 2 end,
             o.updated_at desc nulls last
    limit 1
  ) live on true
  where p.id=p_user;
$$;
-- Diagnostic is intentionally SQL-editor/admin only; it is not exposed to app users.
revoke all on function public.debug_member_avatar_v314(uuid) from public, anon, authenticated;

commit;
