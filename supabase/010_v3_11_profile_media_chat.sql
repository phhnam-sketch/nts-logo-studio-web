-- NTS Logo Studio Web V3.11
-- Facebook-like profile media derivatives + global avatar sync + stable chat RPCs.
-- Run AFTER migrations 005, 006, fixed 007, 008 and 009.
-- Safe to run repeatedly: all new RPCs use V3.11 names.

begin;

alter table public.profiles
  add column if not exists avatar_crop_version integer not null default 0,
  add column if not exists cover_crop_version integer not null default 0;

alter table public.direct_messages
  add column if not exists edited_at timestamptz,
  add column if not exists revoked_at timestamptz;

-- Reassert public profile-media configuration so every authenticated client can display
-- final cropped avatar/cover files without needing owner-only profile SELECT access.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('profile-media','profile-media',true,5242880,array['image/jpeg','image/png'])
on conflict(id) do update set
  public=true,
  file_size_limit=5242880,
  allowed_mime_types=array['image/jpeg','image/png'];

drop policy if exists profile_media_select_all on storage.objects;
create policy profile_media_select_all on storage.objects
for select to anon, authenticated
using (bucket_id='profile-media');

create or replace function public.get_member_public_profile_v311(p_user uuid)
returns table (
  user_id uuid,
  display_name text,
  avatar_url text,
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
set search_path = public, auth
as $$
  select
    p.id,
    coalesce(nullif(p.display_name,''), 'Hội viên'),
    coalesce(nullif(p.avatar_url,''), nullif(u.raw_user_meta_data->>'avatar_url',''), nullif(u.raw_user_meta_data->>'picture','')),
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
  where auth.uid() is not null
    and p.id=p_user
    and p.id<>auth.uid()
    and coalesce(m.status,'active')<>'suspended'
  limit 1;
$$;
revoke all on function public.get_member_public_profile_v311(uuid) from public;
grant execute on function public.get_member_public_profile_v311(uuid) to authenticated;

create or replace function public.list_member_directory_v311(p_search text default '', p_limit integer default 60)
returns table (
  user_id uuid,
  display_name text,
  avatar_url text,
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
set search_path = public, auth
as $$
  select
    p.id,
    coalesce(nullif(p.display_name,''),'Hội viên'),
    coalesce(nullif(p.avatar_url,''), nullif(u.raw_user_meta_data->>'avatar_url',''), nullif(u.raw_user_meta_data->>'picture','')),
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
  where auth.uid() is not null
    and p.id<>auth.uid()
    and coalesce(m.status,'active')<>'suspended'
    and (coalesce(btrim(p_search),'')='' or p.display_name ilike '%'||replace(replace(btrim(p_search),'%','\%'),'_','\_')||'%' escape '\')
  order by
    case when f.status='accepted' then 0 when f.status='pending' then 1 else 2 end,
    case when m.role='admin' then 0 when m.plan='vip' then 1 else 2 end,
    lower(coalesce(p.display_name,''))
  limit greatest(1,least(coalesce(p_limit,60),100));
$$;
revoke all on function public.list_member_directory_v311(text,integer) from public;
grant execute on function public.list_member_directory_v311(text,integer) to authenticated;

create or replace function public.list_messenger_contacts_v311(p_limit integer default 60)
returns table (
  peer_id uuid,
  display_name text,
  avatar_url text,
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
set search_path = public, auth
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
    coalesce(nullif(p.avatar_url,''), nullif(u.raw_user_meta_data->>'avatar_url',''), nullif(u.raw_user_meta_data->>'picture','')),
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
revoke all on function public.list_messenger_contacts_v311(integer) from public;
grant execute on function public.list_messenger_contacts_v311(integer) to authenticated;

create or replace function public.list_direct_messages_v311(
  p_peer uuid,
  p_limit integer default 80,
  p_before timestamptz default null
)
returns table (
  id bigint,
  sender_id uuid,
  recipient_id uuid,
  body text,
  created_at timestamptz,
  read_at timestamptz,
  edited_at timestamptz,
  revoked_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_peer is null or p_peer=auth.uid() then raise exception 'INVALID_PEER'; end if;
  if not exists (
    select 1 from public.friendships f
    where f.status='accepted'
      and ((f.requester_id=auth.uid() and f.addressee_id=p_peer)
        or (f.addressee_id=auth.uid() and f.requester_id=p_peer))
  ) then raise exception 'NOT_FRIENDS'; end if;

  return query
  select q.id,q.sender_id,q.recipient_id,q.body,q.created_at,q.read_at,q.edited_at,q.revoked_at
  from (
    select dm.id,dm.sender_id,dm.recipient_id,dm.body,dm.created_at,dm.read_at,dm.edited_at,dm.revoked_at
    from public.direct_messages dm
    where dm.deleted_at is null
      and ((dm.sender_id=auth.uid() and dm.recipient_id=p_peer)
        or (dm.sender_id=p_peer and dm.recipient_id=auth.uid()))
      and (p_before is null or dm.created_at<p_before)
    order by dm.created_at desc
    limit greatest(1,least(coalesce(p_limit,80),120))
  ) q
  order by q.created_at asc;
end;
$$;
revoke all on function public.list_direct_messages_v311(uuid,integer,timestamptz) from public;
grant execute on function public.list_direct_messages_v311(uuid,integer,timestamptz) to authenticated;

commit;
