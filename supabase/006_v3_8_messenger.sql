-- NTS Logo Studio Web V3.8
-- Messenger reliability + realtime helper RPCs.
-- Run AFTER migration 005.

begin;

-- Keep message lookups cheap as conversation history grows.
create index if not exists direct_messages_pair_created_idx
on public.direct_messages (sender_id, recipient_id, created_at desc)
where deleted_at is null;

-- Return one safe public member profile. No email is exposed.
create or replace function public.get_member_public_profile(p_user uuid)
returns table (
  user_id uuid,
  display_name text,
  avatar_url text,
  role text,
  plan text,
  is_vip boolean,
  friendship_status text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id,
    coalesce(nullif(p.display_name,''), 'Hội viên'),
    p.avatar_url,
    coalesce(m.role,'member'),
    coalesce(m.plan,'free'),
    (coalesce(m.role,'member') = 'admin' or
      (m.plan = 'vip' and m.status = 'active' and (m.vip_until is null or m.vip_until > now()))),
    f.status
  from public.profiles p
  left join public.memberships m on m.user_id = p.id
  left join public.friendships f
    on ((f.requester_id = auth.uid() and f.addressee_id = p.id)
     or (f.addressee_id = auth.uid() and f.requester_id = p.id))
  where auth.uid() is not null
    and p.id = p_user
    and p.id <> auth.uid()
    and coalesce(m.status,'active') <> 'suspended'
  limit 1;
$$;
revoke all on function public.get_member_public_profile(uuid) from public;
grant execute on function public.get_member_public_profile(uuid) to authenticated;

-- Reliable conversation reader. This avoids a complex PostgREST .or() filter
-- and provides a single place to enforce accepted friendship access.
create or replace function public.list_direct_messages(
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
  edited_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_peer is null or p_peer = auth.uid() then raise exception 'INVALID_PEER'; end if;

  if not exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = auth.uid() and f.addressee_id = p_peer)
        or (f.addressee_id = auth.uid() and f.requester_id = p_peer))
  ) then raise exception 'NOT_FRIENDS'; end if;

  return query
  select q.id, q.sender_id, q.recipient_id, q.body, q.created_at, q.read_at, q.edited_at
  from (
    select dm.id, dm.sender_id, dm.recipient_id, dm.body, dm.created_at, dm.read_at, dm.edited_at
    from public.direct_messages dm
    where dm.deleted_at is null
      and ((dm.sender_id = auth.uid() and dm.recipient_id = p_peer)
        or (dm.sender_id = p_peer and dm.recipient_id = auth.uid()))
      and (p_before is null or dm.created_at < p_before)
    order by dm.created_at desc
    limit greatest(1, least(coalesce(p_limit,80), 120))
  ) q
  order by q.created_at asc;
end;
$$;
revoke all on function public.list_direct_messages(uuid, integer, timestamptz) from public;
grant execute on function public.list_direct_messages(uuid, integer, timestamptz) to authenticated;

-- Facebook-like contact list: accepted friends + latest message + unread count.
create or replace function public.list_messenger_contacts(p_limit integer default 60)
returns table (
  peer_id uuid,
  display_name text,
  avatar_url text,
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
set search_path = public
as $$
  with accepted as (
    select
      case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end as peer_id
    from public.friendships f
    where auth.uid() is not null
      and f.status = 'accepted'
      and (f.requester_id = auth.uid() or f.addressee_id = auth.uid())
  )
  select
    a.peer_id,
    coalesce(nullif(p.display_name,''), 'Hội viên') as display_name,
    p.avatar_url,
    coalesce(ms.role,'member') as role,
    coalesce(ms.plan,'free') as plan,
    (coalesce(ms.role,'member') = 'admin' or
      (ms.plan = 'vip' and ms.status = 'active' and (ms.vip_until is null or ms.vip_until > now()))) as is_vip,
    lm.body as last_message,
    lm.created_at as last_at,
    coalesce(uc.unread_count,0)::bigint as unread_count
  from accepted a
  join public.profiles p on p.id = a.peer_id
  left join public.memberships ms on ms.user_id = a.peer_id
  left join lateral (
    select dm.body, dm.created_at
    from public.direct_messages dm
    where dm.deleted_at is null
      and ((dm.sender_id = auth.uid() and dm.recipient_id = a.peer_id)
        or (dm.sender_id = a.peer_id and dm.recipient_id = auth.uid()))
    order by dm.created_at desc
    limit 1
  ) lm on true
  left join lateral (
    select count(*) as unread_count
    from public.direct_messages dm
    where dm.deleted_at is null
      and dm.sender_id = a.peer_id
      and dm.recipient_id = auth.uid()
      and dm.read_at is null
  ) uc on true
  where coalesce(ms.status,'active') <> 'suspended'
  order by lm.created_at desc nulls last, lower(coalesce(p.display_name,''))
  limit greatest(1, least(coalesce(p_limit,60),100));
$$;
revoke all on function public.list_messenger_contacts(integer) from public;
grant execute on function public.list_messenger_contacts(integer) to authenticated;

-- Make sure INSERT/UPDATE events are available to Realtime subscribers.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='direct_messages'
  ) then
    alter publication supabase_realtime add table public.direct_messages;
  end if;
end $$;

commit;
