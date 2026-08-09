-- NTS Logo Studio Web V3.12
-- ROOT FIX: cross-account avatar synchronization.
-- Run AFTER migration 010.
-- New RPC names are used so PostgreSQL return-type changes never collide with older versions.

begin;

-- Reassert public avatar delivery and read access.
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

-- Public member profile with the REAL storage object path/version when present.
create or replace function public.get_member_public_profile_v312(p_user uuid)
returns table (
  user_id uuid,
  display_name text,
  avatar_url text,
  oauth_avatar_url text,
  avatar_storage_path text,
  avatar_storage_version timestamptz,
  avatar_version timestamptz,
  avatar_pos_x numeric,
  avatar_pos_y numeric,
  avatar_zoom numeric,
  avatar_crop_version integer,
  role text,
  plan text,
  is_vip boolean,
  friendship_status text
)
language sql
stable
security definer
set search_path = public, auth, storage
as $$
  select
    p.id,
    coalesce(nullif(p.display_name,''),'Hội viên'),
    nullif(p.avatar_url,''),
    coalesce(nullif(u.raw_user_meta_data->>'avatar_url',''), nullif(u.raw_user_meta_data->>'picture','')),
    av.name,
    av.updated_at,
    p.updated_at,
    coalesce(p.avatar_pos_x,50)::numeric,
    coalesce(p.avatar_pos_y,50)::numeric,
    coalesce(p.avatar_zoom,100)::numeric,
    coalesce(p.avatar_crop_version,0),
    coalesce(m.role,'member'),
    coalesce(m.plan,'free'),
    (coalesce(m.role,'member')='admin' or (m.plan='vip' and m.status='active' and (m.vip_until is null or m.vip_until>now()))),
    f.status
  from public.profiles p
  left join auth.users u on u.id=p.id
  left join public.memberships m on m.user_id=p.id
  left join public.friendships f
    on ((f.requester_id=auth.uid() and f.addressee_id=p.id)
     or (f.addressee_id=auth.uid() and f.requester_id=p.id))
  left join lateral (
    select o.name,o.updated_at
    from storage.objects o
    where o.bucket_id='profile-media'
      and o.name=p.id::text||'/avatar.jpg'
    order by o.updated_at desc nulls last
    limit 1
  ) av on true
  where auth.uid() is not null
    and p.id=p_user
    and p.id<>auth.uid()
    and coalesce(m.status,'active')<>'suspended'
  limit 1;
$$;
revoke all on function public.get_member_public_profile_v312(uuid) from public;
grant execute on function public.get_member_public_profile_v312(uuid) to authenticated;

create or replace function public.list_member_directory_v312(p_search text default '', p_limit integer default 60)
returns table (
  user_id uuid,
  display_name text,
  avatar_url text,
  oauth_avatar_url text,
  avatar_storage_path text,
  avatar_storage_version timestamptz,
  avatar_version timestamptz,
  avatar_pos_x numeric,
  avatar_pos_y numeric,
  avatar_zoom numeric,
  avatar_crop_version integer,
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
set search_path = public, auth, storage
as $$
  select
    p.id,
    coalesce(nullif(p.display_name,''),'Hội viên'),
    nullif(p.avatar_url,''),
    coalesce(nullif(u.raw_user_meta_data->>'avatar_url',''), nullif(u.raw_user_meta_data->>'picture','')),
    av.name,
    av.updated_at,
    p.updated_at,
    coalesce(p.avatar_pos_x,50)::numeric,
    coalesce(p.avatar_pos_y,50)::numeric,
    coalesce(p.avatar_zoom,100)::numeric,
    coalesce(p.avatar_crop_version,0),
    coalesce(m.role,'member'),
    coalesce(m.plan,'free'),
    (coalesce(m.role,'member')='admin' or (m.plan='vip' and m.status='active' and (m.vip_until is null or m.vip_until>now()))),
    f.id,
    f.status,
    case when f.requester_id=auth.uid() then 'outgoing' when f.addressee_id=auth.uid() then 'incoming' else null end
  from public.profiles p
  left join auth.users u on u.id=p.id
  left join public.memberships m on m.user_id=p.id
  left join public.friendships f
    on ((f.requester_id=auth.uid() and f.addressee_id=p.id)
     or (f.addressee_id=auth.uid() and f.requester_id=p.id))
  left join lateral (
    select o.name,o.updated_at
    from storage.objects o
    where o.bucket_id='profile-media'
      and o.name=p.id::text||'/avatar.jpg'
    order by o.updated_at desc nulls last
    limit 1
  ) av on true
  where auth.uid() is not null
    and p.id<>auth.uid()
    and coalesce(m.status,'active')<>'suspended'
    and (coalesce(btrim(p_search),'')='' or p.display_name ilike '%'||btrim(p_search)||'%')
  order by
    case when f.status='accepted' then 0 when f.status='pending' then 1 else 2 end,
    case when m.role='admin' then 0 when m.plan='vip' then 1 else 2 end,
    lower(coalesce(p.display_name,''))
  limit greatest(1,least(coalesce(p_limit,60),100));
$$;
revoke all on function public.list_member_directory_v312(text,integer) from public;
grant execute on function public.list_member_directory_v312(text,integer) to authenticated;

create or replace function public.list_messenger_contacts_v312(p_limit integer default 60)
returns table (
  peer_id uuid,
  display_name text,
  avatar_url text,
  oauth_avatar_url text,
  avatar_storage_path text,
  avatar_storage_version timestamptz,
  avatar_version timestamptz,
  avatar_pos_x numeric,
  avatar_pos_y numeric,
  avatar_zoom numeric,
  avatar_crop_version integer,
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
set search_path = public, auth, storage
as $$
  with accepted as (
    select case when f.requester_id=auth.uid() then f.addressee_id else f.requester_id end as peer_id
    from public.friendships f
    where auth.uid() is not null
      and f.status='accepted'
      and (f.requester_id=auth.uid() or f.addressee_id=auth.uid())
  )
  select
    a.peer_id,
    coalesce(nullif(p.display_name,''),'Hội viên'),
    nullif(p.avatar_url,''),
    coalesce(nullif(u.raw_user_meta_data->>'avatar_url',''), nullif(u.raw_user_meta_data->>'picture','')),
    av.name,
    av.updated_at,
    p.updated_at,
    coalesce(p.avatar_pos_x,50)::numeric,
    coalesce(p.avatar_pos_y,50)::numeric,
    coalesce(p.avatar_zoom,100)::numeric,
    coalesce(p.avatar_crop_version,0),
    coalesce(ms.role,'member'),
    coalesce(ms.plan,'free'),
    (coalesce(ms.role,'member')='admin' or (ms.plan='vip' and ms.status='active' and (ms.vip_until is null or ms.vip_until>now()))),
    case when lm.revoked_at is not null then 'Tin nhắn đã được thu hồi' else lm.body end,
    lm.created_at,
    coalesce(uc.unread_count,0)::bigint
  from accepted a
  join public.profiles p on p.id=a.peer_id
  left join auth.users u on u.id=a.peer_id
  left join public.memberships ms on ms.user_id=a.peer_id
  left join lateral (
    select o.name,o.updated_at
    from storage.objects o
    where o.bucket_id='profile-media'
      and o.name=a.peer_id::text||'/avatar.jpg'
    order by o.updated_at desc nulls last
    limit 1
  ) av on true
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
    where dm.deleted_at is null and dm.sender_id=a.peer_id and dm.recipient_id=auth.uid() and dm.read_at is null
  ) uc on true
  where coalesce(ms.status,'active')<>'suspended'
  order by lm.created_at desc nulls last, lower(coalesce(p.display_name,''))
  limit greatest(1,least(coalesce(p_limit,60),100));
$$;
revoke all on function public.list_messenger_contacts_v312(integer) from public;
grant execute on function public.list_messenger_contacts_v312(integer) to authenticated;

-- Diagnostic helper. It never exposes email/private auth data; it only tells the
-- logged-in caller which public avatar sources exist for one other member.
create or replace function public.debug_member_avatar_v312(p_user uuid)
returns table (
  user_id uuid,
  profile_avatar_url text,
  oauth_avatar_url text,
  storage_path text,
  storage_updated_at timestamptz,
  crop_version integer
)
language sql
stable
security definer
set search_path=public,auth,storage
as $$
  select p.id,
         nullif(p.avatar_url,''),
         coalesce(nullif(u.raw_user_meta_data->>'avatar_url',''),nullif(u.raw_user_meta_data->>'picture','')),
         av.name,
         av.updated_at,
         coalesce(p.avatar_crop_version,0)
  from public.profiles p
  left join auth.users u on u.id=p.id
  left join lateral (
    select o.name,o.updated_at from storage.objects o
    where o.bucket_id='profile-media' and o.name=p.id::text||'/avatar.jpg'
    order by o.updated_at desc nulls last limit 1
  ) av on true
  where auth.uid() is not null and p.id=p_user
  limit 1;
$$;
revoke all on function public.debug_member_avatar_v312(uuid) from public;
grant execute on function public.debug_member_avatar_v312(uuid) to authenticated;

commit;
