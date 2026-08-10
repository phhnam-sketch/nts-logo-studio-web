-- ============================================================================
-- NTS LOGO STUDIO WEB V3.16 - FULL SYSTEM REPAIR / SCHEMA DOCTOR
--
-- MỤC TIÊU
--   * Một migration duy nhất để sửa installation bị thiếu/lệch migration 001..016.
--   * Không xóa dữ liệu người dùng, tin nhắn, thanh toán hay hồ sơ hiện có.
--   * Bảo toàn RPC cũ; sau cùng tạo RPC health/repair mới V3.16.
--   * Sửa mismatch zoom 25..500 giữa frontend và DB.
--
-- Có thể chạy lại. Nên backup database trước khi chạy trên production.
-- ============================================================================

begin;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- A. PRE-FLIGHT: tạo/hoàn thiện các bảng nền tảng trước khi replay migrations.
-- CREATE TABLE IF NOT EXISTS không bổ sung column còn thiếu, vì vậy các ALTER
-- bên dưới là bắt buộc cho những database đã cài dở hoặc bị lệch phiên bản.
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade
);
alter table public.profiles
  add column if not exists display_name text not null default 'Người dùng',
  add column if not exists bio text not null default '',
  add column if not exists avatar_url text,
  add column if not exists cover_url text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists avatar_pos_x numeric not null default 50,
  add column if not exists avatar_pos_y numeric not null default 50,
  add column if not exists avatar_zoom numeric not null default 100,
  add column if not exists cover_pos_x numeric not null default 50,
  add column if not exists cover_pos_y numeric not null default 50,
  add column if not exists cover_zoom numeric not null default 100,
  add column if not exists avatar_crop_version integer not null default 0,
  add column if not exists cover_crop_version integer not null default 0,
  add column if not exists avatar_object_path text,
  add column if not exists cover_object_path text,
  add column if not exists avatar_revision bigint not null default 0,
  add column if not exists cover_revision bigint not null default 0,
  add column if not exists avatar_thumb_data text;

create table if not exists public.memberships (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.memberships
  add column if not exists role text not null default 'member',
  add column if not exists plan text not null default 'free',
  add column if not exists status text not null default 'active',
  add column if not exists vip_until timestamptz,
  add column if not exists free_limit integer,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.site_settings (
  id boolean primary key default true
);
alter table public.site_settings
  add column if not exists free_monthly_limit integer not null default 10,
  add column if not exists vip_monthly_price integer not null default 200000,
  add column if not exists bank_name text not null default 'THAY TÊN NGÂN HÀNG',
  add column if not exists account_name text not null default 'THAY TÊN CHỦ TÀI KHOẢN',
  add column if not exists account_number text not null default 'THAY SỐ TÀI KHOẢN',
  add column if not exists transfer_prefix text not null default 'NTSVIP',
  add column if not exists support_text text not null default 'Liên hệ quản trị viên nếu thanh toán chưa được duyệt sau 24 giờ.',
  add column if not exists payment_qr_url text,
  add column if not exists maintenance_enabled boolean not null default false,
  add column if not exists maintenance_title text not null default 'Hệ thống đang bảo trì',
  add column if not exists maintenance_message text not null default 'NTS Logo Studio đang được nâng cấp. Vui lòng quay lại sau.',
  add column if not exists maintenance_updated_by uuid,
  add column if not exists updated_at timestamptz not null default now();
insert into public.site_settings(id) values (true) on conflict(id) do nothing;

create table if not exists public.monthly_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  month_start date not null,
  primary key(user_id, month_start)
);
alter table public.monthly_usage
  add column if not exists exported_images integer not null default 0,
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.export_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade
);
alter table public.export_reservations
  add column if not exists requested_count integer not null default 1,
  add column if not exists successful_count integer not null default 0,
  add column if not exists metered boolean not null default true,
  add column if not exists status text not null default 'reserved',
  add column if not exists expires_at timestamptz not null default (now()+interval '30 minutes'),
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists completed_at timestamptz;

create table if not exists public.payment_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade
);
alter table public.payment_requests
  add column if not exists amount integer not null default 0,
  add column if not exists months integer not null default 1,
  add column if not exists reference text,
  add column if not exists transaction_code text,
  add column if not exists note text,
  add column if not exists proof_path text,
  add column if not exists status text not null default 'pending',
  add column if not exists admin_note text,
  add column if not exists reviewed_by uuid,
  add column if not exists reviewed_at timestamptz,
  add column if not exists payment_provider text,
  add column if not exists provider_order_code bigint,
  add column if not exists provider_payment_link_id text,
  add column if not exists checkout_url text,
  add column if not exists qr_payload text,
  add column if not exists provider_reference text,
  add column if not exists paid_amount integer not null default 0,
  add column if not exists paid_at timestamptz,
  add column if not exists auto_verified boolean not null default false,
  add column if not exists provider_state text not null default 'manual',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payment_requests(id) on delete cascade,
  provider text not null,
  provider_reference text not null,
  amount integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
-- Deduplicate legacy webhook rows before enforcing idempotency.
delete from public.payment_events a
using public.payment_events b
where a.id>b.id and a.provider=b.provider and a.provider_reference=b.provider_reference;
create unique index if not exists payment_events_provider_reference_uq
  on public.payment_events(provider, provider_reference);

-- Clear duplicate provider order codes left by partial/legacy installs. Keep the newest row.
with ranked as (
  select id,row_number() over(partition by provider_order_code order by created_at desc,id desc) rn
  from public.payment_requests where provider_order_code is not null
)
update public.payment_requests p set provider_order_code=null
from ranked r where p.id=r.id and r.rn>1;

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  addressee_id uuid not null references auth.users(id) on delete cascade
);
alter table public.friendships
  add column if not exists status text not null default 'pending',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists responded_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();
-- A pair should have only one friendship state. Keep the most recently updated row.
delete from public.friendships a
using public.friendships b
where least(a.requester_id,a.addressee_id)=least(b.requester_id,b.addressee_id)
  and greatest(a.requester_id,a.addressee_id)=greatest(b.requester_id,b.addressee_id)
  and (coalesce(a.updated_at,a.created_at),a.id)<(coalesce(b.updated_at,b.created_at),b.id);

create table if not exists public.direct_messages (
  id bigint generated by default as identity primary key,
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  body text not null default ''
);
alter table public.direct_messages
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists read_at timestamptz,
  add column if not exists edited_at timestamptz,
  add column if not exists revoked_at timestamptz,
  add column if not exists deleted_at timestamptz;

create table if not exists public.user_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade
);
alter table public.user_feedback
  add column if not exists feedback_type text not null default 'comment',
  add column if not exists rating smallint,
  add column if not exists content text not null default 'Phản hồi',
  add column if not exists status text not null default 'new',
  add column if not exists admin_note text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists deleted_at timestamptz;

create table if not exists public.membership_history (
  id bigint generated by default as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade
);
alter table public.membership_history
  add column if not exists actor_id uuid,
  add column if not exists action text not null default 'updated',
  add column if not exists old_role text,
  add column if not exists new_role text,
  add column if not exists old_plan text,
  add column if not exists new_plan text,
  add column if not exists old_status text,
  add column if not exists new_status text,
  add column if not exists old_vip_until timestamptz,
  add column if not exists new_vip_until timestamptz,
  add column if not exists admin_note text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists deleted_at timestamptz;

create table if not exists public.member_public_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.member_public_profiles
  add column if not exists display_name text not null default 'Hội viên',
  add column if not exists avatar_thumb_data text,
  add column if not exists avatar_url text,
  add column if not exists oauth_avatar_url text,
  add column if not exists avatar_object_path text,
  add column if not exists avatar_revision bigint not null default 0,
  add column if not exists avatar_updated_at timestamptz,
  add column if not exists role text not null default 'member',
  add column if not exists plan text not null default 'free',
  add column if not exists status text not null default 'active',
  add column if not exists vip_until timestamptz,
  add column if not exists updated_at timestamptz not null default now();

-- Remove malformed/oversized inline thumbs before V3.15 validates its constraints.
update public.profiles set avatar_thumb_data=null
where avatar_thumb_data is not null
  and (char_length(avatar_thumb_data)>180000 or avatar_thumb_data !~ '^data:image/(jpeg|jpg|png|webp);base64,');
update public.member_public_profiles set avatar_thumb_data=null
where avatar_thumb_data is not null
  and (char_length(avatar_thumb_data)>180000 or avatar_thumb_data !~ '^data:image/(jpeg|jpg|png|webp);base64,');

-- Backfill every Auth user so entitlement/profile RPCs never operate on a missing row.
insert into public.profiles(id,display_name,avatar_url)
select u.id,
       left(coalesce(nullif(trim(u.raw_user_meta_data->>'display_name'),''),nullif(trim(u.raw_user_meta_data->>'full_name'),''),nullif(trim(u.raw_user_meta_data->>'name'),''),split_part(coalesce(u.email,'Người dùng'),'@',1)),60),
       coalesce(u.raw_user_meta_data->>'avatar_url',u.raw_user_meta_data->>'picture')
from auth.users u
on conflict(id) do nothing;
insert into public.memberships(user_id)
select u.id from auth.users u on conflict(user_id) do nothing;


-- ================= REPLAY 001_membership_schema.sql =================
-- ============================================================================
-- NTS LOGO STUDIO WEB V3 - MEMBERSHIP / ADMIN / PROFILE / BILLING
-- Chạy TOÀN BỘ file này một lần trong Supabase > SQL Editor.
-- Sau khi chạy xong, xem ADMIN_SETUP.md để cấp quyền admin đầu tiên.
-- ============================================================================


create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Core tables
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Người dùng',
  bio text not null default '',
  avatar_url text,
  cover_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_name_len check (char_length(display_name) between 1 and 60),
  constraint profiles_bio_len check (char_length(bio) <= 500)
);

create table if not exists public.memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('member','admin')),
  plan text not null default 'free' check (plan in ('free','vip')),
  status text not null default 'active' check (status in ('active','suspended')),
  vip_until timestamptz,
  free_limit integer check (free_limit is null or free_limit between 0 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.site_settings (
  id boolean primary key default true check (id = true),
  free_monthly_limit integer not null default 10 check (free_monthly_limit between 0 and 100000),
  vip_monthly_price integer not null default 200000 check (vip_monthly_price >= 0),
  bank_name text not null default 'THAY TÊN NGÂN HÀNG',
  account_name text not null default 'THAY TÊN CHỦ TÀI KHOẢN',
  account_number text not null default 'THAY SỐ TÀI KHOẢN',
  transfer_prefix text not null default 'NTSVIP',
  support_text text not null default 'Liên hệ quản trị viên nếu thanh toán chưa được duyệt sau 24 giờ.',
  updated_at timestamptz not null default now()
);
insert into public.site_settings(id) values (true) on conflict (id) do nothing;

create table if not exists public.monthly_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  month_start date not null,
  exported_images integer not null default 0 check (exported_images >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, month_start)
);

create table if not exists public.export_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  requested_count integer not null check (requested_count > 0 and requested_count <= 1000),
  successful_count integer not null default 0 check (successful_count >= 0),
  metered boolean not null default true,
  status text not null default 'reserved' check (status in ('reserved','completed','cancelled')),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists export_reservations_active_idx on public.export_reservations(user_id, status, expires_at);

create table if not exists public.payment_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount integer not null check (amount >= 0),
  months integer not null default 1 check (months between 1 and 12),
  reference text,
  note text,
  proof_path text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  admin_note text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_reference_len check (reference is null or char_length(reference) <= 120),
  constraint payment_note_len check (note is null or char_length(note) <= 500),
  constraint payment_admin_note_len check (admin_note is null or char_length(admin_note) <= 500)
);
create index if not exists payment_requests_user_idx on public.payment_requests(user_id, created_at desc);
create index if not exists payment_requests_status_idx on public.payment_requests(status, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. updated_at helper
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists memberships_set_updated_at on public.memberships;
create trigger memberships_set_updated_at before update on public.memberships
for each row execute function public.set_updated_at();

drop trigger if exists site_settings_set_updated_at on public.site_settings;
create trigger site_settings_set_updated_at before update on public.site_settings
for each row execute function public.set_updated_at();

drop trigger if exists monthly_usage_set_updated_at on public.monthly_usage;
create trigger monthly_usage_set_updated_at before update on public.monthly_usage
for each row execute function public.set_updated_at();

drop trigger if exists payment_requests_set_updated_at on public.payment_requests;
create trigger payment_requests_set_updated_at before update on public.payment_requests
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Create profile + free membership for every new Auth user
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_name text;
  v_avatar text;
begin
  v_name := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'name'), ''),
    split_part(coalesce(new.email, 'Người dùng'), '@', 1)
  );
  v_avatar := coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture');

  insert into public.profiles(id, display_name, avatar_url)
  values (new.id, left(v_name, 60), v_avatar)
  on conflict (id) do nothing;

  insert into public.memberships(user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- Backfill existing accounts.
insert into public.profiles(id, display_name, avatar_url)
select u.id,
       left(coalesce(nullif(trim(u.raw_user_meta_data->>'display_name'), ''), nullif(trim(u.raw_user_meta_data->>'full_name'), ''), split_part(coalesce(u.email,'Người dùng'),'@',1)), 60),
       coalesce(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture')
from auth.users u
on conflict (id) do nothing;

insert into public.memberships(user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Security helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.user_id = auth.uid()
      and m.role = 'admin'
      and m.status = 'active'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.memberships enable row level security;
alter table public.site_settings enable row level security;
alter table public.monthly_usage enable row level security;
alter table public.export_reservations enable row level security;
alter table public.payment_requests enable row level security;

-- Profiles
DROP POLICY IF EXISTS profiles_select_own_or_admin ON public.profiles;
create policy profiles_select_own_or_admin on public.profiles
for select to authenticated
using (id = auth.uid() or public.is_admin());
DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
create policy profiles_update_own on public.profiles
for update to authenticated
using (id = auth.uid())
with check (id = auth.uid());

-- Membership system fields are read-only to normal browser clients.
DROP POLICY IF EXISTS memberships_select_own_or_admin ON public.memberships;
create policy memberships_select_own_or_admin on public.memberships
for select to authenticated
using (user_id = auth.uid() or public.is_admin());

-- Public application pricing/bank display; admin may update.
DROP POLICY IF EXISTS site_settings_select ON public.site_settings;
create policy site_settings_select on public.site_settings
for select to anon, authenticated using (true);
DROP POLICY IF EXISTS site_settings_admin_update ON public.site_settings;
create policy site_settings_admin_update on public.site_settings
for update to authenticated
using (public.is_admin()) with check (public.is_admin());

DROP POLICY IF EXISTS monthly_usage_select_own_or_admin ON public.monthly_usage;
create policy monthly_usage_select_own_or_admin on public.monthly_usage
for select to authenticated
using (user_id = auth.uid() or public.is_admin());

DROP POLICY IF EXISTS reservations_select_own_or_admin ON public.export_reservations;
create policy reservations_select_own_or_admin on public.export_reservations
for select to authenticated
using (user_id = auth.uid() or public.is_admin());

DROP POLICY IF EXISTS payments_select_own_or_admin ON public.payment_requests;
create policy payments_select_own_or_admin on public.payment_requests
for select to authenticated
using (user_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- 6. Entitlements + secure quota reservation RPCs
-- ---------------------------------------------------------------------------
create or replace function public.get_my_account_state()
returns table (
  user_id uuid,
  role text,
  plan text,
  status text,
  vip_until timestamptz,
  is_vip boolean,
  free_limit integer,
  used integer,
  reserved integer,
  remaining integer,
  vip_monthly_price integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_membership public.memberships%rowtype;
  v_settings public.site_settings%rowtype;
  v_limit integer;
  v_used integer := 0;
  v_reserved integer := 0;
  v_is_vip boolean := false;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_membership from public.memberships where memberships.user_id = v_uid;
  select * into v_settings from public.site_settings where id = true;
  v_limit := coalesce(v_membership.free_limit, v_settings.free_monthly_limit, 10);
  v_is_vip := v_membership.role = 'admin' or (v_membership.plan = 'vip' and v_membership.vip_until is not null and v_membership.vip_until > now());

  select coalesce(mu.exported_images,0) into v_used
  from public.monthly_usage mu
  where mu.user_id = v_uid and mu.month_start = date_trunc('month', now())::date;
  if not found then v_used := 0; end if;

  select coalesce(sum(er.requested_count),0)::integer into v_reserved
  from public.export_reservations er
  where er.user_id = v_uid and er.status='reserved' and er.expires_at > now() and er.metered;

  return query select
    v_uid,
    v_membership.role,
    case when v_is_vip then 'vip' else 'free' end,
    v_membership.status,
    v_membership.vip_until,
    v_is_vip,
    v_limit,
    v_used,
    v_reserved,
    case when v_is_vip then 2147483647 else greatest(v_limit - v_used - v_reserved, 0) end,
    coalesce(v_settings.vip_monthly_price, 200000);
end;
$$;
revoke all on function public.get_my_account_state() from public;
grant execute on function public.get_my_account_state() to authenticated;

create or replace function public.begin_export(p_count integer)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_membership public.memberships%rowtype;
  v_settings public.site_settings%rowtype;
  v_limit integer;
  v_used integer := 0;
  v_reserved integer := 0;
  v_metered boolean := true;
  v_id uuid;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_count is null or p_count < 1 or p_count > 1000 then raise exception 'INVALID_EXPORT_COUNT'; end if;

  select * into v_membership from public.memberships where user_id = v_uid for update;
  if v_membership.status <> 'active' then raise exception 'ACCOUNT_SUSPENDED'; end if;

  update public.export_reservations
     set status='cancelled', completed_at=now()
   where user_id=v_uid and status='reserved' and expires_at <= now();

  v_metered := not (v_membership.role='admin' or (v_membership.plan='vip' and v_membership.vip_until is not null and v_membership.vip_until > now()));

  if v_metered then
    select * into v_settings from public.site_settings where id = true;
    v_limit := coalesce(v_membership.free_limit, v_settings.free_monthly_limit, 10);
    select coalesce(exported_images,0) into v_used from public.monthly_usage
      where user_id=v_uid and month_start=date_trunc('month',now())::date;
    if not found then v_used := 0; end if;
    select coalesce(sum(requested_count),0)::integer into v_reserved
      from public.export_reservations where user_id=v_uid and status='reserved' and expires_at>now() and metered;
    if v_used + v_reserved + p_count > v_limit then
      raise exception 'FREE_QUOTA_EXCEEDED:%:%', greatest(v_limit-v_used-v_reserved,0), v_limit;
    end if;
  end if;

  insert into public.export_reservations(user_id, requested_count, metered)
  values (v_uid, p_count, v_metered)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.begin_export(integer) from public;
grant execute on function public.begin_export(integer) to authenticated;

create or replace function public.finish_export(p_reservation uuid, p_success_count integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.export_reservations%rowtype;
  v_success integer;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_row from public.export_reservations
  where id=p_reservation and user_id=v_uid for update;
  if not found then raise exception 'RESERVATION_NOT_FOUND'; end if;
  if v_row.status <> 'reserved' then return; end if;
  v_success := greatest(least(coalesce(p_success_count,0), v_row.requested_count),0);

  if v_row.metered and v_success > 0 then
    insert into public.monthly_usage(user_id, month_start, exported_images)
    values(v_uid, date_trunc('month',now())::date, v_success)
    on conflict(user_id, month_start) do update
      set exported_images = public.monthly_usage.exported_images + excluded.exported_images,
          updated_at = now();
  end if;

  update public.export_reservations
  set successful_count=v_success, status='completed', completed_at=now()
  where id=v_row.id;
end;
$$;
revoke all on function public.finish_export(uuid,integer) from public;
grant execute on function public.finish_export(uuid,integer) to authenticated;

create or replace function public.cancel_export_reservation(p_reservation uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.export_reservations set status='cancelled', completed_at=now()
  where id=p_reservation and user_id=auth.uid() and status='reserved';
$$;
revoke all on function public.cancel_export_reservation(uuid) from public;
grant execute on function public.cancel_export_reservation(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. VIP payment request RPC
-- ---------------------------------------------------------------------------
create or replace function public.submit_vip_payment(
  p_reference text default null,
  p_note text default null,
  p_proof_path text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_price integer;
  v_id uuid;
  v_pending integer;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_proof_path is not null and trim(p_proof_path)<>'' and split_part(trim(p_proof_path),'/',1) <> v_uid::text then
    raise exception 'INVALID_PROOF_PATH';
  end if;
  select count(*) into v_pending from public.payment_requests where user_id=v_uid and status='pending';
  if v_pending >= 2 then raise exception 'TOO_MANY_PENDING_PAYMENTS'; end if;
  select vip_monthly_price into v_price from public.site_settings where id=true;
  insert into public.payment_requests(user_id, amount, months, reference, note, proof_path)
  values(v_uid, coalesce(v_price,200000), 1, nullif(trim(p_reference),''), nullif(trim(p_note),''), nullif(trim(p_proof_path),''))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.submit_vip_payment(text,text,text) from public;
grant execute on function public.submit_vip_payment(text,text,text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Admin RPCs - browser never gets service_role
-- ---------------------------------------------------------------------------
create or replace function public.admin_stats()
returns table(total_users bigint, vip_users bigint, free_users bigint, suspended_users bigint, pending_payments bigint, approved_revenue_month bigint)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  return query
  select
    (select count(*) from auth.users),
    (select count(*) from public.memberships m where m.role<>'admin' and m.plan='vip' and m.vip_until>now() and m.status='active'),
    (select count(*) from public.memberships m where m.role<>'admin' and not (m.plan='vip' and m.vip_until>now()) and m.status='active'),
    (select count(*) from public.memberships m where m.status='suspended'),
    (select count(*) from public.payment_requests p where p.status='pending'),
    (select coalesce(sum(p.amount),0)::bigint from public.payment_requests p where p.status='approved' and p.reviewed_at >= date_trunc('month',now()));
end;
$$;
revoke all on function public.admin_stats() from public;
grant execute on function public.admin_stats() to authenticated;

create or replace function public.admin_list_members(p_search text default null)
returns table(
  user_id uuid, email text, display_name text, role text, plan text, status text,
  vip_until timestamptz, free_limit integer, month_used integer, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  return query
  select u.id, u.email::text, p.display_name, m.role,
         case when m.role='admin' or (m.plan='vip' and m.vip_until>now()) then 'vip' else 'free' end,
         m.status, m.vip_until, m.free_limit,
         coalesce(mu.exported_images,0), u.created_at
  from auth.users u
  join public.profiles p on p.id=u.id
  join public.memberships m on m.user_id=u.id
  left join public.monthly_usage mu on mu.user_id=u.id and mu.month_start=date_trunc('month',now())::date
  where p_search is null or trim(p_search)='' or lower(coalesce(u.email,'')) like '%'||lower(trim(p_search))||'%' or lower(p.display_name) like '%'||lower(trim(p_search))||'%'
  order by u.created_at desc
  limit 500;
end;
$$;
revoke all on function public.admin_list_members(text) from public;
grant execute on function public.admin_list_members(text) to authenticated;

create or replace function public.admin_list_payments(p_status text default 'pending')
returns table(
  payment_id uuid, user_id uuid, email text, display_name text, amount integer,
  status text, reference text, note text, proof_path text, admin_note text,
  created_at timestamptz, reviewed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  return query
  select pr.id, pr.user_id, u.email::text, p.display_name, pr.amount, pr.status,
         pr.reference, pr.note, pr.proof_path, pr.admin_note, pr.created_at, pr.reviewed_at
  from public.payment_requests pr
  join auth.users u on u.id=pr.user_id
  join public.profiles p on p.id=pr.user_id
  where p_status is null or p_status='all' or pr.status=p_status
  order by case when pr.status='pending' then 0 else 1 end, pr.created_at desc
  limit 500;
end;
$$;
revoke all on function public.admin_list_payments(text) from public;
grant execute on function public.admin_list_payments(text) to authenticated;

create or replace function public.admin_review_payment(p_request_id uuid, p_action text, p_admin_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pr public.payment_requests%rowtype;
  v_months integer;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_action not in ('approve','reject') then raise exception 'INVALID_ACTION'; end if;
  select * into v_pr from public.payment_requests where id=p_request_id for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND'; end if;
  if v_pr.status <> 'pending' then raise exception 'PAYMENT_ALREADY_REVIEWED'; end if;
  v_months := greatest(least(v_pr.months,12),1);

  if p_action='approve' then
    update public.memberships
    set plan='vip', status='active',
        vip_until = case
          when vip_until is not null and vip_until > now() then vip_until + make_interval(months => v_months)
          else now() + make_interval(months => v_months)
        end
    where user_id=v_pr.user_id;
    update public.payment_requests
      set status='approved', admin_note=nullif(trim(p_admin_note),''), reviewed_by=auth.uid(), reviewed_at=now()
      where id=p_request_id;
  else
    update public.payment_requests
      set status='rejected', admin_note=nullif(trim(p_admin_note),''), reviewed_by=auth.uid(), reviewed_at=now()
      where id=p_request_id;
  end if;
end;
$$;
revoke all on function public.admin_review_payment(uuid,text,text) from public;
grant execute on function public.admin_review_payment(uuid,text,text) to authenticated;

create or replace function public.admin_reset_usage(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  delete from public.monthly_usage where user_id=p_user_id and month_start=date_trunc('month',now())::date;
  update public.export_reservations set status='cancelled', completed_at=now()
   where user_id=p_user_id and status='reserved';
end;
$$;
revoke all on function public.admin_reset_usage(uuid) from public;
grant execute on function public.admin_reset_usage(uuid) to authenticated;

create or replace function public.admin_update_member(
  p_user_id uuid,
  p_status text default null,
  p_plan text default null,
  p_vip_until timestamptz default null,
  p_free_limit integer default null,
  p_clear_free_limit boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_user_id=auth.uid() and p_status='suspended' then raise exception 'CANNOT_SUSPEND_SELF'; end if;
  if p_status is not null and p_status not in ('active','suspended') then raise exception 'INVALID_STATUS'; end if;
  if p_plan is not null and p_plan not in ('free','vip') then raise exception 'INVALID_PLAN'; end if;
  if p_free_limit is not null and (p_free_limit<0 or p_free_limit>100000) then raise exception 'INVALID_FREE_LIMIT'; end if;

  update public.memberships set
    status = coalesce(p_status,status),
    plan = coalesce(p_plan,plan),
    vip_until = case
      when p_plan='free' then null
      when p_plan='vip' and p_vip_until is null then coalesce(vip_until, now()+interval '1 month')
      when p_vip_until is not null then p_vip_until
      else vip_until
    end,
    free_limit = case when p_clear_free_limit then null else coalesce(p_free_limit,free_limit) end
  where user_id=p_user_id;
end;
$$;
revoke all on function public.admin_update_member(uuid,text,text,timestamptz,integer,boolean) from public;
grant execute on function public.admin_update_member(uuid,text,text,timestamptz,integer,boolean) to authenticated;

-- Explicit API privileges (RLS still decides which rows are accessible).
grant select, update on public.profiles to authenticated;
grant select on public.memberships to authenticated;
grant select on public.site_settings to anon, authenticated;
grant update on public.site_settings to authenticated;
grant select on public.monthly_usage to authenticated;
grant select on public.export_reservations to authenticated;
grant select on public.payment_requests to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Storage buckets
-- ---------------------------------------------------------------------------
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('profile-media','profile-media',true,5242880,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=true, file_size_limit=5242880, allowed_mime_types=array['image/jpeg','image/png','image/webp'];

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('payment-proofs','payment-proofs',false,8388608,array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict(id) do update set public=false, file_size_limit=8388608, allowed_mime_types=array['image/jpeg','image/png','image/webp','application/pdf'];

-- Storage policies: first folder must be user UUID.
DROP POLICY IF EXISTS profile_media_insert_own ON storage.objects;
create policy profile_media_insert_own on storage.objects for insert to authenticated
with check (bucket_id='profile-media' and (storage.foldername(name))[1]=auth.uid()::text);
DROP POLICY IF EXISTS profile_media_update_own ON storage.objects;
create policy profile_media_update_own on storage.objects for update to authenticated
using (bucket_id='profile-media' and (storage.foldername(name))[1]=auth.uid()::text)
with check (bucket_id='profile-media' and (storage.foldername(name))[1]=auth.uid()::text);
DROP POLICY IF EXISTS profile_media_delete_own ON storage.objects;
create policy profile_media_delete_own on storage.objects for delete to authenticated
using (bucket_id='profile-media' and (storage.foldername(name))[1]=auth.uid()::text);
DROP POLICY IF EXISTS profile_media_select_all ON storage.objects;
create policy profile_media_select_all on storage.objects for select to anon, authenticated
using (bucket_id='profile-media');

DROP POLICY IF EXISTS payment_proofs_insert_own ON storage.objects;
create policy payment_proofs_insert_own on storage.objects for insert to authenticated
with check (bucket_id='payment-proofs' and (storage.foldername(name))[1]=auth.uid()::text);
DROP POLICY IF EXISTS payment_proofs_select_own_admin ON storage.objects;
create policy payment_proofs_select_own_admin on storage.objects for select to authenticated
using (bucket_id='payment-proofs' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_admin()));
DROP POLICY IF EXISTS payment_proofs_delete_own_admin ON storage.objects;
create policy payment_proofs_delete_own_admin on storage.objects for delete to authenticated
using (bucket_id='payment-proofs' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_admin()));


-- ================= REPLAY 002_v3_1_production_fix.sql =================
-- ============================================================================
-- NTS LOGO STUDIO WEB V3.1 - PRODUCTION FIX
-- Chạy SAU 001_membership_schema.sql trong Supabase > SQL Editor.
-- Mục tiêu: sửa upload avatar/cover ổn định + cho Admin sửa profile hội viên.
-- Có thể chạy lại an toàn.
-- ============================================================================

-- Admin được sửa display_name/bio của hội viên qua frontend đã xác thực.
alter table public.profiles enable row level security;
drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles
for update to authenticated
using (public.is_admin())
with check (public.is_admin());

grant select, update on public.profiles to authenticated;

-- Đảm bảo bucket hồ sơ tồn tại và đúng cấu hình.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('profile-media','profile-media',true,5242880,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set
  public=true,
  file_size_limit=5242880,
  allowed_mime_types=array['image/jpeg','image/png','image/webp'];

-- Stable paths `${uid}/avatar.webp` và `${uid}/cover.webp` dùng upsert,
-- vì vậy cần đủ insert + update + select + delete trên chính thư mục UID.
drop policy if exists profile_media_insert_own on storage.objects;
create policy profile_media_insert_own on storage.objects
for insert to authenticated
with check (
  bucket_id='profile-media'
  and (storage.foldername(name))[1]=auth.uid()::text
);

drop policy if exists profile_media_update_own on storage.objects;
create policy profile_media_update_own on storage.objects
for update to authenticated
using (
  bucket_id='profile-media'
  and (storage.foldername(name))[1]=auth.uid()::text
)
with check (
  bucket_id='profile-media'
  and (storage.foldername(name))[1]=auth.uid()::text
);

drop policy if exists profile_media_delete_own on storage.objects;
create policy profile_media_delete_own on storage.objects
for delete to authenticated
using (
  bucket_id='profile-media'
  and (storage.foldername(name))[1]=auth.uid()::text
);

drop policy if exists profile_media_select_all on storage.objects;
create policy profile_media_select_all on storage.objects
for select to anon, authenticated
using (bucket_id='profile-media');


-- ================= REPLAY 003_v3_2_profile_payment.sql =================
-- ============================================================================
-- NTS LOGO STUDIO WEB V3.2 - PROFILE DISPLAY + SMART PAYMENT
-- Chạy SAU 001_membership_schema.sql và 002_v3_1_production_fix.sql.
-- Có thể chạy lại an toàn.
-- ============================================================================

-- Profile media vẫn public để avatar/cover hiển thị trực tiếp trên web.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('profile-media','profile-media',true,5242880,array['image/jpeg','image/png'])
on conflict(id) do update set
  public=true,
  file_size_limit=5242880,
  allowed_mime_types=array['image/jpeg','image/png'];

-- Giữ đủ quyền cho stable path uid/avatar.jpg và uid/cover.jpg.
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

drop policy if exists profile_media_select_all on storage.objects;
create policy profile_media_select_all on storage.objects
for select to anon, authenticated
using (bucket_id='profile-media');

-- Admin-managed payment QR. The packaged PNG remains the fallback, while this
-- public bucket lets an admin replace QR directly from the dashboard without a GitHub deploy.
alter table public.site_settings
  add column if not exists payment_qr_url text;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('site-assets','site-assets',true,5242880,array['image/png'])
on conflict(id) do update set
  public=true, file_size_limit=5242880, allowed_mime_types=array['image/png'];

drop policy if exists site_assets_select_all on storage.objects;
create policy site_assets_select_all on storage.objects
for select to anon, authenticated
using (bucket_id='site-assets');

drop policy if exists site_assets_admin_insert on storage.objects;
create policy site_assets_admin_insert on storage.objects
for insert to authenticated
with check (bucket_id='site-assets' and public.is_admin());

drop policy if exists site_assets_admin_update on storage.objects;
create policy site_assets_admin_update on storage.objects
for update to authenticated
using (bucket_id='site-assets' and public.is_admin())
with check (bucket_id='site-assets' and public.is_admin());

drop policy if exists site_assets_admin_delete on storage.objects;
create policy site_assets_admin_delete on storage.objects
for delete to authenticated
using (bucket_id='site-assets' and public.is_admin());

-- Smart payment: lưu mã giao dịch ngân hàng riêng với mã đơn/nội dung chuyển khoản.
alter table public.payment_requests
  add column if not exists transaction_code text;

alter table public.payment_requests
  drop constraint if exists payment_transaction_code_len;
alter table public.payment_requests
  add constraint payment_transaction_code_len
  check (transaction_code is null or char_length(transaction_code) <= 120);

create index if not exists payment_requests_reference_lookup_idx
  on public.payment_requests(user_id, reference, status);
create index if not exists payment_requests_transaction_lookup_idx
  on public.payment_requests(user_id, lower(transaction_code), status)
  where transaction_code is not null;

-- RPC V3.2: hỗ trợ 1-12 tháng, số tiền được tính server-side.
create or replace function public.submit_vip_payment_v32(
  p_months integer,
  p_order_code text,
  p_transaction_code text default null,
  p_note text default null,
  p_proof_path text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_price integer;
  v_amount integer;
  v_id uuid;
  v_pending integer;
  v_months integer;
  v_order text;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  v_months := greatest(least(coalesce(p_months,1),12),1);
  v_order := upper(trim(coalesce(p_order_code,'')));
  if v_order = '' or char_length(v_order) > 120 then raise exception 'INVALID_ORDER_CODE'; end if;
  if p_proof_path is not null and trim(p_proof_path)<>'' and split_part(trim(p_proof_path),'/',1) <> v_uid::text then
    raise exception 'INVALID_PROOF_PATH';
  end if;
  select count(*) into v_pending from public.payment_requests where user_id=v_uid and status='pending';
  if v_pending >= 2 then raise exception 'TOO_MANY_PENDING_PAYMENTS'; end if;

  -- Avoid accidental double submissions when a user taps the button more than once.
  if exists (
    select 1 from public.payment_requests
    where user_id=v_uid and upper(coalesce(reference,''))=v_order and status in ('pending','approved')
  ) then raise exception 'ORDER_ALREADY_EXISTS'; end if;

  if nullif(trim(p_transaction_code),'') is not null and exists (
    select 1 from public.payment_requests
    where user_id=v_uid
      and lower(coalesce(transaction_code,''))=lower(trim(p_transaction_code))
      and status in ('pending','approved')
  ) then raise exception 'TRANSACTION_CODE_ALREADY_USED'; end if;

  select vip_monthly_price into v_price from public.site_settings where id=true;
  v_amount := coalesce(v_price,200000) * v_months;

  insert into public.payment_requests(
    user_id, amount, months, reference, transaction_code, note, proof_path
  ) values (
    v_uid,
    v_amount,
    v_months,
    v_order,
    nullif(trim(p_transaction_code),''),
    nullif(trim(p_note),''),
    nullif(trim(p_proof_path),'')
  ) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.submit_vip_payment_v32(integer,text,text,text,text) from public;
grant execute on function public.submit_vip_payment_v32(integer,text,text,text,text) to authenticated;

-- Admin payment list có thêm số tháng + mã giao dịch.
create or replace function public.admin_list_payments_v32(p_status text default 'pending')
returns table(
  payment_id uuid, user_id uuid, email text, display_name text, amount integer,
  months integer, status text, reference text, transaction_code text, note text,
  proof_path text, admin_note text, created_at timestamptz, reviewed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  return query
  select pr.id, pr.user_id, u.email::text, p.display_name, pr.amount,
         pr.months, pr.status, pr.reference, pr.transaction_code, pr.note,
         pr.proof_path, pr.admin_note, pr.created_at, pr.reviewed_at
  from public.payment_requests pr
  join auth.users u on u.id=pr.user_id
  join public.profiles p on p.id=pr.user_id
  where p_status is null or p_status='all' or pr.status=p_status
  order by case when pr.status='pending' then 0 else 1 end, pr.created_at desc
  limit 500;
end;
$$;
revoke all on function public.admin_list_payments_v32(text) from public;
grant execute on function public.admin_list_payments_v32(text) to authenticated;


-- ================= REPLAY 004_v3_5_profile_crop_autopay.sql =================
-- ============================================================================
-- NTS LOGO STUDIO WEB V3.5 - FAST PROFILE POSITION + PAYOS AUTO PAYMENT
-- Chạy SAU 001, 002, 003. Có thể chạy lại an toàn.
-- ============================================================================

-- 1) Hồ sơ: lưu vị trí/zoom ảnh mà không cần crop lại file mỗi lần.
alter table public.profiles add column if not exists avatar_pos_x numeric not null default 50;
alter table public.profiles add column if not exists avatar_pos_y numeric not null default 50;
alter table public.profiles add column if not exists avatar_zoom numeric not null default 100;
alter table public.profiles add column if not exists cover_pos_x numeric not null default 50;
alter table public.profiles add column if not exists cover_pos_y numeric not null default 50;
alter table public.profiles add column if not exists cover_zoom numeric not null default 100;

alter table public.profiles drop constraint if exists profiles_avatar_pos_x_range;
alter table public.profiles add constraint profiles_avatar_pos_x_range check (avatar_pos_x between 0 and 100);
alter table public.profiles drop constraint if exists profiles_avatar_pos_y_range;
alter table public.profiles add constraint profiles_avatar_pos_y_range check (avatar_pos_y between 0 and 100);
-- V3.16: legacy avatar zoom constraint skipped; final bound is 25..500.
alter table public.profiles drop constraint if exists profiles_cover_pos_x_range;
alter table public.profiles add constraint profiles_cover_pos_x_range check (cover_pos_x between 0 and 100);
alter table public.profiles drop constraint if exists profiles_cover_pos_y_range;
alter table public.profiles add constraint profiles_cover_pos_y_range check (cover_pos_y between 0 and 100);
-- V3.16: legacy cover zoom constraint skipped; final bound is 25..500.

-- 2) Payment provider metadata.
alter table public.payment_requests add column if not exists payment_provider text;
alter table public.payment_requests add column if not exists provider_order_code bigint;
alter table public.payment_requests add column if not exists provider_payment_link_id text;
alter table public.payment_requests add column if not exists checkout_url text;
alter table public.payment_requests add column if not exists qr_payload text;
alter table public.payment_requests add column if not exists provider_reference text;
alter table public.payment_requests add column if not exists paid_amount integer not null default 0;
alter table public.payment_requests add column if not exists paid_at timestamptz;
alter table public.payment_requests add column if not exists auto_verified boolean not null default false;
alter table public.payment_requests add column if not exists provider_state text not null default 'manual';

create unique index if not exists payment_requests_provider_order_code_uq
  on public.payment_requests(provider_order_code)
  where provider_order_code is not null;

-- Mỗi giao dịch webhook chỉ được tính một lần.
create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payment_requests(id) on delete cascade,
  provider text not null,
  provider_reference text not null,
  amount integer not null check (amount >= 0),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(provider, provider_reference)
);

alter table public.payment_events enable row level security;
drop policy if exists payment_events_admin_select on public.payment_events;
create policy payment_events_admin_select on public.payment_events
for select to authenticated using (public.is_admin());
grant select on public.payment_events to authenticated;

-- User xem các trường provider của chính đơn qua policy payment_requests hiện có.
-- Không cấp INSERT/UPDATE payment_events cho browser.

-- Admin list V3.5 có trạng thái tự động/tiền thực nhận.
create or replace function public.admin_list_payments_v35(p_status text default 'pending')
returns table(
  payment_id uuid, user_id uuid, email text, display_name text, amount integer,
  months integer, status text, reference text, transaction_code text, note text,
  proof_path text, admin_note text, created_at timestamptz, reviewed_at timestamptz,
  payment_provider text, provider_state text, provider_order_code bigint, paid_amount integer, auto_verified boolean
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  return query
  select pr.id, pr.user_id, u.email::text, p.display_name, pr.amount, pr.months, pr.status,
         pr.reference, pr.transaction_code, pr.note, pr.proof_path, pr.admin_note, pr.created_at, pr.reviewed_at,
         pr.payment_provider, pr.provider_state, pr.provider_order_code, pr.paid_amount, pr.auto_verified
  from public.payment_requests pr
  join auth.users u on u.id=pr.user_id
  join public.profiles p on p.id=pr.user_id
  where p_status is null or p_status='all' or pr.status=p_status
  order by case when pr.status='pending' then 0 else 1 end, pr.created_at desc
  limit 500;
end;
$$;
revoke all on function public.admin_list_payments_v35(text) from public;
grant execute on function public.admin_list_payments_v35(text) to authenticated;


-- ================= REPLAY 005_v3_7_community_maintenance.sql =================
-- NTS Logo Studio Web V3.7
-- Community / Direct Messages / Feedback / Maintenance / Membership history
-- Run AFTER 001 -> 002 -> 003 -> 004.


-- ---------------------------------------------------------------------------
-- 1) Maintenance controls
-- ---------------------------------------------------------------------------
alter table public.site_settings
  add column if not exists maintenance_enabled boolean not null default false,
  add column if not exists maintenance_title text not null default 'Hệ thống đang bảo trì',
  add column if not exists maintenance_message text not null default 'NTS Logo Studio đang được nâng cấp. Vui lòng quay lại sau.',
  add column if not exists maintenance_updated_by uuid references auth.users(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 2) Friend graph
-- ---------------------------------------------------------------------------
create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  addressee_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','declined','blocked')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint friendships_not_self check (requester_id <> addressee_id)
);

create unique index if not exists friendships_unique_pair_idx
on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
create index if not exists friendships_requester_idx on public.friendships(requester_id, status, updated_at desc);
create index if not exists friendships_addressee_idx on public.friendships(addressee_id, status, updated_at desc);

-- ---------------------------------------------------------------------------
-- 3) Direct messages
-- ---------------------------------------------------------------------------
create table if not exists public.direct_messages (
  id bigint generated by default as identity primary key,
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  edited_at timestamptz,
  deleted_at timestamptz,
  constraint direct_messages_not_self check (sender_id <> recipient_id),
  constraint direct_messages_body_len check (char_length(btrim(body)) between 1 and 2000)
);
create index if not exists direct_messages_sender_recipient_idx on public.direct_messages(sender_id, recipient_id, created_at desc);
create index if not exists direct_messages_recipient_unread_idx on public.direct_messages(recipient_id, read_at, created_at desc);

-- ---------------------------------------------------------------------------
-- 4) User feedback / comments
-- ---------------------------------------------------------------------------
create table if not exists public.user_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  feedback_type text not null default 'comment' check (feedback_type in ('comment','suggestion','bug','other')),
  rating smallint check (rating is null or rating between 1 and 5),
  content text not null,
  status text not null default 'new' check (status in ('new','reviewing','planned','resolved','rejected','archived')),
  admin_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint user_feedback_content_len check (char_length(btrim(content)) between 2 and 3000),
  constraint user_feedback_admin_note_len check (admin_note is null or char_length(admin_note) <= 2000)
);
create index if not exists user_feedback_user_idx on public.user_feedback(user_id, created_at desc);
create index if not exists user_feedback_status_idx on public.user_feedback(status, created_at desc) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 5) Membership history (soft-archiveable audit view)
-- ---------------------------------------------------------------------------
create table if not exists public.membership_history (
  id bigint generated by default as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null default 'updated',
  old_role text,
  new_role text,
  old_plan text,
  new_plan text,
  old_status text,
  new_status text,
  old_vip_until timestamptz,
  new_vip_until timestamptz,
  admin_note text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists membership_history_user_idx on public.membership_history(user_id, created_at desc);
create index if not exists membership_history_created_idx on public.membership_history(created_at desc);

-- ---------------------------------------------------------------------------
-- 6) updated_at helpers
-- ---------------------------------------------------------------------------
drop trigger if exists friendships_set_updated_at on public.friendships;
create trigger friendships_set_updated_at before update on public.friendships
for each row execute function public.set_updated_at();

drop trigger if exists user_feedback_set_updated_at on public.user_feedback;
create trigger user_feedback_set_updated_at before update on public.user_feedback
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 7) Membership audit trigger
-- ---------------------------------------------------------------------------
create or replace function public.log_membership_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.membership_history(
      user_id, actor_id, action,
      new_role, new_plan, new_status, new_vip_until
    ) values (
      new.user_id, auth.uid(), 'created',
      new.role, new.plan, new.status, new.vip_until
    );
    return new;
  end if;

  if old.role is distinct from new.role
     or old.plan is distinct from new.plan
     or old.status is distinct from new.status
     or old.vip_until is distinct from new.vip_until
     or old.free_limit is distinct from new.free_limit then
    insert into public.membership_history(
      user_id, actor_id, action,
      old_role, new_role, old_plan, new_plan, old_status, new_status,
      old_vip_until, new_vip_until
    ) values (
      new.user_id, auth.uid(), 'updated',
      old.role, new.role, old.plan, new.plan, old.status, new.status,
      old.vip_until, new.vip_until
    );
  end if;
  return new;
end;
$$;

drop trigger if exists memberships_history_trigger on public.memberships;
create trigger memberships_history_trigger
after insert or update on public.memberships
for each row execute function public.log_membership_change();

-- ---------------------------------------------------------------------------
-- 8) RLS
-- ---------------------------------------------------------------------------
alter table public.friendships enable row level security;
alter table public.direct_messages enable row level security;
alter table public.user_feedback enable row level security;
alter table public.membership_history enable row level security;

-- friendships: only participants, admin may inspect status metadata.
drop policy if exists friendships_select_participants on public.friendships;
create policy friendships_select_participants on public.friendships
for select to authenticated
using (requester_id = auth.uid() or addressee_id = auth.uid() or public.is_admin());

-- Do not allow arbitrary direct browser mutation: use RPCs below.
revoke insert, update, delete on public.friendships from authenticated;
grant select on public.friendships to authenticated;

-- direct messages: only sender/recipient can read. Admin does NOT get private message content.
drop policy if exists direct_messages_select_participants on public.direct_messages;
create policy direct_messages_select_participants on public.direct_messages
for select to authenticated
using (sender_id = auth.uid() or recipient_id = auth.uid());
revoke insert, update, delete on public.direct_messages from authenticated;
grant select on public.direct_messages to authenticated;

-- feedback: user can create/read own, admin can read/manage all.
drop policy if exists feedback_select_own_or_admin on public.user_feedback;
create policy feedback_select_own_or_admin on public.user_feedback
for select to authenticated
using ((user_id = auth.uid() and deleted_at is null) or public.is_admin());

drop policy if exists feedback_insert_own on public.user_feedback;
create policy feedback_insert_own on public.user_feedback
for insert to authenticated
with check (user_id = auth.uid() and deleted_at is null and status = 'new');

drop policy if exists feedback_admin_update on public.user_feedback;
create policy feedback_admin_update on public.user_feedback
for update to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists feedback_admin_delete on public.user_feedback;
create policy feedback_admin_delete on public.user_feedback
for delete to authenticated
using (public.is_admin());

grant select, insert on public.user_feedback to authenticated;
grant update, delete on public.user_feedback to authenticated;

-- membership history: users may read own; admins read/manage notes/archive.
drop policy if exists membership_history_select_own_or_admin on public.membership_history;
create policy membership_history_select_own_or_admin on public.membership_history
for select to authenticated
using ((user_id = auth.uid() and deleted_at is null) or public.is_admin());

drop policy if exists membership_history_admin_update on public.membership_history;
create policy membership_history_admin_update on public.membership_history
for update to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists membership_history_admin_delete on public.membership_history;
create policy membership_history_admin_delete on public.membership_history
for delete to authenticated using (public.is_admin());

grant select, update, delete on public.membership_history to authenticated;

-- ---------------------------------------------------------------------------
-- 9) Safe member directory RPC
--    Does not expose email. Shows role / VIP badge as requested.
-- ---------------------------------------------------------------------------
create or replace function public.list_member_directory(p_search text default '', p_limit integer default 40)
returns table (
  user_id uuid,
  display_name text,
  avatar_url text,
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
set search_path = public
as $$
  select
    p.id as user_id,
    coalesce(nullif(p.display_name,''), 'Hội viên') as display_name,
    p.avatar_url,
    coalesce(m.role,'member') as role,
    coalesce(m.plan,'free') as plan,
    (coalesce(m.role,'member') = 'admin' or (m.plan = 'vip' and m.status = 'active' and (m.vip_until is null or m.vip_until > now()))) as is_vip,
    f.id as friendship_id,
    f.status as friendship_status,
    case
      when f.requester_id = auth.uid() then 'outgoing'
      when f.addressee_id = auth.uid() then 'incoming'
      else null
    end as friendship_direction
  from public.profiles p
  left join public.memberships m on m.user_id = p.id
  left join public.friendships f
    on ((f.requester_id = auth.uid() and f.addressee_id = p.id)
        or (f.addressee_id = auth.uid() and f.requester_id = p.id))
  where auth.uid() is not null
    and p.id <> auth.uid()
    and coalesce(m.status,'active') <> 'suspended'
    and (
      coalesce(btrim(p_search),'') = ''
      or p.display_name ilike '%' || replace(replace(btrim(p_search),'%','\%'),'_','\_') || '%' escape '\'
    )
  order by
    case when f.status = 'accepted' then 0 when f.status = 'pending' then 1 else 2 end,
    case when m.role = 'admin' then 0 when m.plan = 'vip' then 1 else 2 end,
    lower(coalesce(p.display_name,''))
  limit greatest(1, least(coalesce(p_limit,40), 100));
$$;
revoke all on function public.list_member_directory(text, integer) from public;
grant execute on function public.list_member_directory(text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 10) Friendship RPCs
-- ---------------------------------------------------------------------------
create or replace function public.send_friend_request(p_target uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_existing public.friendships%rowtype;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_target is null or p_target = auth.uid() then raise exception 'INVALID_TARGET'; end if;

  select * into v_existing
  from public.friendships
  where (requester_id = auth.uid() and addressee_id = p_target)
     or (requester_id = p_target and addressee_id = auth.uid())
  limit 1;

  if found then
    if v_existing.status = 'blocked' then raise exception 'FRIENDSHIP_BLOCKED'; end if;
    if v_existing.status in ('pending','accepted') then return v_existing.id; end if;
    update public.friendships
      set requester_id = auth.uid(), addressee_id = p_target, status = 'pending', responded_at = null
      where id = v_existing.id
      returning id into v_id;
    return v_id;
  end if;

  insert into public.friendships(requester_id, addressee_id, status)
  values (auth.uid(), p_target, 'pending') returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.send_friend_request(uuid) from public;
grant execute on function public.send_friend_request(uuid) to authenticated;

create or replace function public.respond_friend_request(p_friendship uuid, p_action text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_action not in ('accept','decline') then raise exception 'INVALID_ACTION'; end if;
  update public.friendships
  set status = case when p_action = 'accept' then 'accepted' else 'declined' end,
      responded_at = now()
  where id = p_friendship
    and addressee_id = auth.uid()
    and status = 'pending';
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
end;
$$;
revoke all on function public.respond_friend_request(uuid, text) from public;
grant execute on function public.respond_friend_request(uuid, text) to authenticated;

create or replace function public.remove_friendship(p_friendship uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  delete from public.friendships
  where id = p_friendship
    and (requester_id = auth.uid() or addressee_id = auth.uid());
end;
$$;
revoke all on function public.remove_friendship(uuid) from public;
grant execute on function public.remove_friendship(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 11) Messaging RPCs
-- ---------------------------------------------------------------------------
create or replace function public.send_direct_message(p_recipient uuid, p_body text)
returns public.direct_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_body text := btrim(coalesce(p_body,''));
  v_row public.direct_messages;
  v_count integer;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_recipient is null or p_recipient = auth.uid() then raise exception 'INVALID_RECIPIENT'; end if;
  if char_length(v_body) < 1 or char_length(v_body) > 2000 then raise exception 'INVALID_MESSAGE_LENGTH'; end if;

  if not exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = auth.uid() and f.addressee_id = p_recipient)
        or (f.addressee_id = auth.uid() and f.requester_id = p_recipient))
  ) then raise exception 'NOT_FRIENDS'; end if;

  select count(*) into v_count
  from public.direct_messages
  where sender_id = auth.uid() and created_at > now() - interval '10 seconds';
  if v_count >= 8 then raise exception 'MESSAGE_RATE_LIMIT'; end if;

  insert into public.direct_messages(sender_id, recipient_id, body)
  values (auth.uid(), p_recipient, v_body)
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.send_direct_message(uuid, text) from public;
grant execute on function public.send_direct_message(uuid, text) to authenticated;

create or replace function public.mark_messages_read(p_peer uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  update public.direct_messages
  set read_at = now()
  where recipient_id = auth.uid()
    and sender_id = p_peer
    and read_at is null
    and deleted_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.mark_messages_read(uuid) from public;
grant execute on function public.mark_messages_read(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 12) Admin community stats
-- ---------------------------------------------------------------------------
create or replace function public.admin_community_stats()
returns table (
  friendships_total bigint,
  messages_total bigint,
  feedback_new bigint,
  feedback_total bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*) from public.friendships where status='accepted'),
    (select count(*) from public.direct_messages where deleted_at is null),
    (select count(*) from public.user_feedback where status='new' and deleted_at is null),
    (select count(*) from public.user_feedback where deleted_at is null)
  where public.is_admin();
$$;
revoke all on function public.admin_community_stats() from public;
grant execute on function public.admin_community_stats() to authenticated;

-- ---------------------------------------------------------------------------
-- 13) Realtime publication - low-overhead tables only
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='direct_messages') then
    alter publication supabase_realtime add table public.direct_messages;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='friendships') then
    alter publication supabase_realtime add table public.friendships;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='site_settings') then
    alter publication supabase_realtime add table public.site_settings;
  end if;
end $$;


-- ================= REPLAY 006_v3_8_messenger.sql =================
-- NTS Logo Studio Web V3.8
-- Messenger reliability + realtime helper RPCs.
-- Run AFTER migration 005.


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


-- ================= REPLAY 007_v3_9_message_edit_revoke.sql =================
-- NTS Logo Studio Web V3.9
-- Message edit/revoke + Messenger polish support.
-- Run AFTER migration 006.


alter table public.direct_messages
  add column if not exists revoked_at timestamptz;

-- Edit only your own non-revoked message. Keep database mutation behind RPC.
create or replace function public.edit_direct_message(p_message bigint, p_body text)
returns public.direct_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_body text := btrim(coalesce(p_body,''));
  v_row public.direct_messages;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_message is null then raise exception 'INVALID_MESSAGE'; end if;
  if char_length(v_body) < 1 or char_length(v_body) > 2000 then raise exception 'INVALID_MESSAGE_LENGTH'; end if;

  update public.direct_messages
  set body = v_body,
      edited_at = now()
  where id = p_message
    and sender_id = auth.uid()
    and deleted_at is null
    and revoked_at is null
  returning * into v_row;

  if v_row.id is null then raise exception 'MESSAGE_NOT_EDITABLE'; end if;
  return v_row;
end;
$$;
revoke all on function public.edit_direct_message(bigint, text) from public;
grant execute on function public.edit_direct_message(bigint, text) to authenticated;

-- Messenger-style recall. Keep a tombstone row so both participants see that
-- the message existed, without exposing the previous body after recall.
create or replace function public.revoke_direct_message(p_message bigint)
returns public.direct_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.direct_messages;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_message is null then raise exception 'INVALID_MESSAGE'; end if;

  update public.direct_messages
  set body = 'Tin nhắn đã được thu hồi',
      revoked_at = now(),
      edited_at = null
  where id = p_message
    and sender_id = auth.uid()
    and deleted_at is null
    and revoked_at is null
  returning * into v_row;

  if v_row.id is null then raise exception 'MESSAGE_NOT_REVOCABLE'; end if;
  return v_row;
end;
$$;
revoke all on function public.revoke_direct_message(bigint) from public;
grant execute on function public.revoke_direct_message(bigint) to authenticated;

-- Extend reliable conversation reader with revoked state.
-- PostgreSQL cannot CREATE OR REPLACE a function when the OUT/RETURNS TABLE
-- row type changes. Migration 006 returned 7 columns; V3.9 adds revoked_at,
-- so explicitly drop the old signature first and recreate it.
drop function if exists public.list_direct_messages(uuid, integer, timestamptz);

create function public.list_direct_messages(
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
  if p_peer is null or p_peer = auth.uid() then raise exception 'INVALID_PEER'; end if;

  if not exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = auth.uid() and f.addressee_id = p_peer)
        or (f.addressee_id = auth.uid() and f.requester_id = p_peer))
  ) then raise exception 'NOT_FRIENDS'; end if;

  return query
  select q.id, q.sender_id, q.recipient_id, q.body, q.created_at, q.read_at, q.edited_at, q.revoked_at
  from (
    select dm.id, dm.sender_id, dm.recipient_id, dm.body, dm.created_at, dm.read_at, dm.edited_at, dm.revoked_at
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

-- Contact list should show a useful tombstone as the latest message.
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
    case when lm.revoked_at is not null then 'Tin nhắn đã được thu hồi' else lm.body end as last_message,
    lm.created_at as last_at,
    coalesce(uc.unread_count,0)::bigint as unread_count
  from accepted a
  join public.profiles p on p.id = a.peer_id
  left join public.memberships ms on ms.user_id = a.peer_id
  left join lateral (
    select dm.body, dm.created_at, dm.revoked_at
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


-- ================= REPLAY 008_v3_10_avatar_sync.sql =================
-- NTS Logo Studio Web V3.10
-- Community avatar synchronization / cache-safe public member RPCs.
-- Run AFTER migrations 005, 006 and fixed 007.
-- Does not expose email or other auth.users fields.


create or replace function public.get_member_public_profile_v310(p_user uuid)
returns table (
  user_id uuid,
  display_name text,
  avatar_url text,
  avatar_version timestamptz,
  avatar_pos_x numeric,
  avatar_pos_y numeric,
  avatar_zoom numeric,
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
    coalesce(
      nullif(p.avatar_url,''),
      nullif(u.raw_user_meta_data->>'avatar_url',''),
      nullif(u.raw_user_meta_data->>'picture','')
    ) as avatar_url,
    p.updated_at as avatar_version,
    coalesce(p.avatar_pos_x,50)::numeric as avatar_pos_x,
    coalesce(p.avatar_pos_y,50)::numeric as avatar_pos_y,
    coalesce(p.avatar_zoom,100)::numeric as avatar_zoom,
    coalesce(m.role,'member'),
    coalesce(m.plan,'free'),
    (coalesce(m.role,'member') = 'admin' or
      (m.plan = 'vip' and m.status = 'active' and (m.vip_until is null or m.vip_until > now()))),
    f.status
  from public.profiles p
  left join auth.users u on u.id = p.id
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
revoke all on function public.get_member_public_profile_v310(uuid) from public;
grant execute on function public.get_member_public_profile_v310(uuid) to authenticated;

create or replace function public.list_member_directory_v310(p_search text default '', p_limit integer default 40)
returns table (
  user_id uuid,
  display_name text,
  avatar_url text,
  avatar_version timestamptz,
  avatar_pos_x numeric,
  avatar_pos_y numeric,
  avatar_zoom numeric,
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
    p.id as user_id,
    coalesce(nullif(p.display_name,''), 'Hội viên') as display_name,
    coalesce(
      nullif(p.avatar_url,''),
      nullif(u.raw_user_meta_data->>'avatar_url',''),
      nullif(u.raw_user_meta_data->>'picture','')
    ) as avatar_url,
    p.updated_at as avatar_version,
    coalesce(p.avatar_pos_x,50)::numeric as avatar_pos_x,
    coalesce(p.avatar_pos_y,50)::numeric as avatar_pos_y,
    coalesce(p.avatar_zoom,100)::numeric as avatar_zoom,
    coalesce(m.role,'member') as role,
    coalesce(m.plan,'free') as plan,
    (coalesce(m.role,'member') = 'admin' or
      (m.plan = 'vip' and m.status = 'active' and (m.vip_until is null or m.vip_until > now()))) as is_vip,
    f.id as friendship_id,
    f.status as friendship_status,
    case
      when f.requester_id = auth.uid() then 'outgoing'
      when f.addressee_id = auth.uid() then 'incoming'
      else null
    end as friendship_direction
  from public.profiles p
  left join auth.users u on u.id = p.id
  left join public.memberships m on m.user_id = p.id
  left join public.friendships f
    on ((f.requester_id = auth.uid() and f.addressee_id = p.id)
        or (f.addressee_id = auth.uid() and f.requester_id = p.id))
  where auth.uid() is not null
    and p.id <> auth.uid()
    and coalesce(m.status,'active') <> 'suspended'
    and (
      coalesce(btrim(p_search),'') = ''
      or p.display_name ilike '%' || replace(replace(btrim(p_search),'%','\%'),'_','\_') || '%' escape '\'
    )
  order by
    case when f.status = 'accepted' then 0 when f.status = 'pending' then 1 else 2 end,
    case when m.role = 'admin' then 0 when m.plan = 'vip' then 1 else 2 end,
    lower(coalesce(p.display_name,''))
  limit greatest(1, least(coalesce(p_limit,40), 100));
$$;
revoke all on function public.list_member_directory_v310(text, integer) from public;
grant execute on function public.list_member_directory_v310(text, integer) to authenticated;

create or replace function public.list_messenger_contacts_v310(p_limit integer default 60)
returns table (
  peer_id uuid,
  display_name text,
  avatar_url text,
  avatar_version timestamptz,
  avatar_pos_x numeric,
  avatar_pos_y numeric,
  avatar_zoom numeric,
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
    select case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end as peer_id
    from public.friendships f
    where auth.uid() is not null
      and f.status = 'accepted'
      and (f.requester_id = auth.uid() or f.addressee_id = auth.uid())
  )
  select
    a.peer_id,
    coalesce(nullif(p.display_name,''), 'Hội viên') as display_name,
    coalesce(
      nullif(p.avatar_url,''),
      nullif(u.raw_user_meta_data->>'avatar_url',''),
      nullif(u.raw_user_meta_data->>'picture','')
    ) as avatar_url,
    p.updated_at as avatar_version,
    coalesce(p.avatar_pos_x,50)::numeric as avatar_pos_x,
    coalesce(p.avatar_pos_y,50)::numeric as avatar_pos_y,
    coalesce(p.avatar_zoom,100)::numeric as avatar_zoom,
    coalesce(ms.role,'member') as role,
    coalesce(ms.plan,'free') as plan,
    (coalesce(ms.role,'member') = 'admin' or
      (ms.plan = 'vip' and ms.status = 'active' and (ms.vip_until is null or ms.vip_until > now()))) as is_vip,
    case when lm.revoked_at is not null then 'Tin nhắn đã được thu hồi' else lm.body end as last_message,
    lm.created_at as last_at,
    coalesce(uc.unread_count,0)::bigint as unread_count
  from accepted a
  join public.profiles p on p.id = a.peer_id
  left join auth.users u on u.id = a.peer_id
  left join public.memberships ms on ms.user_id = a.peer_id
  left join lateral (
    select dm.body, dm.created_at, dm.revoked_at
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
revoke all on function public.list_messenger_contacts_v310(integer) from public;
grant execute on function public.list_messenger_contacts_v310(integer) to authenticated;


-- ================= REPLAY 009_v3_10_1_profile_chat_fix.sql =================
-- NTS Logo Studio Web V3.10.1
-- Stable conversation reader + no destructive replacement of older RPCs.
-- Run AFTER migrations 005, 006, fixed 007 and 008.


alter table public.direct_messages add column if not exists revoked_at timestamptz;
alter table public.direct_messages add column if not exists edited_at timestamptz;

create or replace function public.list_direct_messages_v3101(
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
  if p_peer is null or p_peer = auth.uid() then raise exception 'INVALID_PEER'; end if;

  if not exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = auth.uid() and f.addressee_id = p_peer)
        or (f.addressee_id = auth.uid() and f.requester_id = p_peer))
  ) then raise exception 'NOT_FRIENDS'; end if;

  return query
  select q.id, q.sender_id, q.recipient_id, q.body, q.created_at, q.read_at, q.edited_at, q.revoked_at
  from (
    select dm.id, dm.sender_id, dm.recipient_id, dm.body, dm.created_at, dm.read_at, dm.edited_at, dm.revoked_at
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

revoke all on function public.list_direct_messages_v3101(uuid, integer, timestamptz) from public;
grant execute on function public.list_direct_messages_v3101(uuid, integer, timestamptz) to authenticated;


-- ================= REPLAY 010_v3_11_profile_media_chat.sql =================
-- NTS Logo Studio Web V3.11
-- Facebook-like profile media derivatives + global avatar sync + stable chat RPCs.
-- Run AFTER migrations 005, 006, fixed 007, 008 and 009.
-- Safe to run repeatedly: all new RPCs use V3.11 names.


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


-- ================= REPLAY 011_v3_12_avatar_sync_root_fix.sql =================
-- NTS Logo Studio Web V3.12
-- ROOT FIX: cross-account avatar synchronization.
-- Run AFTER migration 010.
-- New RPC names are used so PostgreSQL return-type changes never collide with older versions.


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


-- ================= REPLAY 012_v3_13_realtime_avatar_fastsync.sql =================
-- NTS Logo Studio Web V3.13
-- REALTIME AVATAR FAST SYNC
-- Run AFTER migration 011.
-- Goals:
--   1) Never rely on overwriting one cached avatar URL for cross-account display.
--   2) Publish safe member avatar metadata in a dedicated realtime table.
--   3) Keep every older RPC/table/function intact for rollback compatibility.
--   4) Allow the Facebook-like crop editor's 100..500% zoom range in the DB.


-- ---------------------------------------------------------------------------
-- 1. Profile media revision metadata. Existing columns/functions are preserved.
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists avatar_object_path text;
alter table public.profiles add column if not exists cover_object_path text;
alter table public.profiles add column if not exists avatar_revision bigint not null default 0;
alter table public.profiles add column if not exists cover_revision bigint not null default 0;

-- Older V3.5 constraints only allowed 100..220 although the newer crop UI allows
-- up to 500. Replace only those constraints; no profile data is removed.
-- V3.16: V3.13 avatar zoom constraint skipped; final bound is 25..500.
-- V3.16: V3.13 cover zoom constraint skipped; final bound is 25..500.

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

-- IMPORTANT: profiles uses NEW.id while memberships uses NEW.user_id.
-- Do not share one RECORD trigger function between these different row shapes.
create or replace function public.trg_sync_profile_public_v313()
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

create or replace function public.trg_sync_membership_public_v313()
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

-- Preserve all old application behavior; only replace the broken V3.13 projection triggers.
drop trigger if exists profiles_public_projection_v313 on public.profiles;
create trigger profiles_public_projection_v313
after insert or update on public.profiles
for each row execute function public.trg_sync_profile_public_v313();

drop trigger if exists memberships_public_projection_v313 on public.memberships;
create trigger memberships_public_projection_v313
after insert or update on public.memberships
for each row execute function public.trg_sync_membership_public_v313();

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


-- ================= REPLAY 013_v3_13_1_trigger_avatar_repair.sql =================
-- NTS Logo Studio Web V3.13.1
-- TRIGGER + CROSS-ACCOUNT AVATAR REPAIR
-- Run AFTER migration 012 if V3.13 was already deployed.
-- This migration is additive/repair-only: no user data, messages, payments or old RPCs are deleted.


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


-- ================= REPLAY 014_v3_14_unified_avatar_hub.sql =================
-- NTS Logo Studio V3.14
-- Unified cross-account avatar resolver for Community / Messenger / Chat.
-- This migration is additive: it does not drop legacy RPCs, messages, friendships or profile data.


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


-- ================= REPLAY 015_v3_15_inline_avatar_sync.sql =================
-- NTS Logo Studio Web V3.15
-- INLINE MINI-AVATAR SYNC
-- Goal: make small avatars in Community / Messages / Messenger independent of Storage/CDN timing.
-- Additive migration. No messages, friendships, payments or legacy avatar fields are removed.


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


-- ================= REPLAY 016_v3_15_1_admin_avatar_perf.sql =================
-- NTS Logo Studio Web V3.15.1
-- ADMIN DASHBOARD STABILITY + FAST INLINE AVATAR RPCs
-- Additive migration. No legacy functions/tables are dropped.


-- ---------------------------------------------------------------------------
-- 1) Public member profile RPC with inline avatar thumbnail included.
--    New name avoids changing the return type of older functions.
-- ---------------------------------------------------------------------------
create or replace function public.get_member_public_profile_v316(p_user uuid)
returns table (
  user_id uuid,
  display_name text,
  avatar_thumb_data text,
  avatar_url text,
  oauth_avatar_url text,
  avatar_storage_path text,
  avatar_storage_version timestamptz,
  avatar_revision bigint,
  avatar_crop_version integer,
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
    mp.user_id,
    mp.display_name,
    mp.avatar_thumb_data,
    mp.avatar_url,
    mp.oauth_avatar_url,
    mp.avatar_object_path,
    mp.avatar_updated_at,
    mp.avatar_revision,
    coalesce(p.avatar_crop_version, 0)::integer,
    mp.role,
    mp.plan,
    (mp.role='admin' or (mp.plan='vip' and mp.status='active' and (mp.vip_until is null or mp.vip_until>now()))),
    f.status
  from public.member_public_profiles mp
  left join public.profiles p on p.id=mp.user_id
  left join public.friendships f
    on ((f.requester_id=auth.uid() and f.addressee_id=mp.user_id)
     or (f.addressee_id=auth.uid() and f.requester_id=mp.user_id))
  where auth.uid() is not null
    and mp.user_id=p_user
    and mp.user_id<>auth.uid()
    and mp.status<>'suspended'
  limit 1;
$$;
revoke all on function public.get_member_public_profile_v316(uuid) from public;
grant execute on function public.get_member_public_profile_v316(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Directory RPC returns the small inline thumbnail in the SAME request.
--    This removes the visible "default avatar -> real avatar" delay.
-- ---------------------------------------------------------------------------
create or replace function public.list_member_directory_v316(p_search text default '', p_limit integer default 60)
returns table (
  user_id uuid,
  display_name text,
  avatar_thumb_data text,
  avatar_url text,
  oauth_avatar_url text,
  avatar_storage_path text,
  avatar_storage_version timestamptz,
  avatar_revision bigint,
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
set search_path=public
as $$
  select
    mp.user_id,
    mp.display_name,
    mp.avatar_thumb_data,
    mp.avatar_url,
    mp.oauth_avatar_url,
    mp.avatar_object_path,
    mp.avatar_updated_at,
    mp.avatar_revision,
    coalesce(p.avatar_crop_version, 0)::integer,
    mp.role,
    mp.plan,
    (mp.role='admin' or (mp.plan='vip' and mp.status='active' and (mp.vip_until is null or mp.vip_until>now()))),
    f.id,
    f.status,
    case when f.requester_id=auth.uid() then 'outgoing'
         when f.addressee_id=auth.uid() then 'incoming'
         else null end
  from public.member_public_profiles mp
  left join public.profiles p on p.id=mp.user_id
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
revoke all on function public.list_member_directory_v316(text,integer) from public;
grant execute on function public.list_member_directory_v316(text,integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Messenger contacts RPC also includes the same inline thumbnail.
-- ---------------------------------------------------------------------------
create or replace function public.list_messenger_contacts_v316(p_limit integer default 60)
returns table (
  peer_id uuid,
  display_name text,
  avatar_thumb_data text,
  avatar_url text,
  oauth_avatar_url text,
  avatar_storage_path text,
  avatar_storage_version timestamptz,
  avatar_revision bigint,
  avatar_crop_version integer,
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
    mp.user_id,
    mp.display_name,
    mp.avatar_thumb_data,
    mp.avatar_url,
    mp.oauth_avatar_url,
    mp.avatar_object_path,
    mp.avatar_updated_at,
    mp.avatar_revision,
    coalesce(p.avatar_crop_version, 0)::integer,
    mp.role,
    mp.plan,
    (mp.role='admin' or (mp.plan='vip' and mp.status='active' and (mp.vip_until is null or mp.vip_until>now()))),
    lm.last_message,
    lm.last_message_at,
    coalesce(u.unread_count,0)::bigint
  from accepted a
  join public.member_public_profiles mp on mp.user_id=a.peer_id
  left join public.profiles p on p.id=mp.user_id
  left join last_msg lm on lm.peer_id=a.peer_id
  left join unread u on u.peer_id=a.peer_id
  where mp.status<>'suspended'
  order by coalesce(lm.last_message_at, mp.updated_at) desc nulls last, lower(mp.display_name)
  limit greatest(1,least(coalesce(p_limit,60),100));
$$;
revoke all on function public.list_messenger_contacts_v316(integer) from public;
grant execute on function public.list_messenger_contacts_v316(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Single-call Admin Dashboard read model.
--    The previous four read RPCs remain available as fallback.
-- ---------------------------------------------------------------------------
create or replace function public.admin_dashboard_v316(
  p_search text default null,
  p_payment_status text default 'pending'
)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,auth
as $$
declare
  v_stats jsonb := '{}'::jsonb;
  v_members jsonb := '[]'::jsonb;
  v_payments jsonb := '[]'::jsonb;
  v_settings jsonb := '{}'::jsonb;
begin
  if not public.is_admin() then
    raise exception 'ADMIN_REQUIRED';
  end if;

  select coalesce(to_jsonb(s), '{}'::jsonb)
    into v_stats
  from public.admin_stats() s;

  select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb)
    into v_members
  from public.admin_list_members(p_search) m;

  select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb)
    into v_payments
  from public.admin_list_payments_v35(p_payment_status) p;

  select coalesce(to_jsonb(ss), '{}'::jsonb)
    into v_settings
  from public.site_settings ss
  where ss.id=true;

  return jsonb_build_object(
    'stats', coalesce(v_stats, '{}'::jsonb),
    'members', coalesce(v_members, '[]'::jsonb),
    'payments', coalesce(v_payments, '[]'::jsonb),
    'settings', coalesce(v_settings, '{}'::jsonb)
  );
end;
$$;
revoke all on function public.admin_dashboard_v316(text,text) from public;
grant execute on function public.admin_dashboard_v316(text,text) to authenticated;


-- ---------------------------------------------------------------------------
-- B. FINAL CONSISTENCY OVERRIDES
-- ---------------------------------------------------------------------------
-- Normalize only impossible legacy values, then align DB with the retained UI (25..500).
update public.profiles set avatar_pos_x=greatest(0,least(100,coalesce(avatar_pos_x,50)));
update public.profiles set avatar_pos_y=greatest(0,least(100,coalesce(avatar_pos_y,50)));
update public.profiles set cover_pos_x=greatest(0,least(100,coalesce(cover_pos_x,50)));
update public.profiles set cover_pos_y=greatest(0,least(100,coalesce(cover_pos_y,50)));
update public.profiles set avatar_zoom=greatest(25,least(500,coalesce(avatar_zoom,100)));
update public.profiles set cover_zoom=greatest(25,least(500,coalesce(cover_zoom,100)));

alter table public.profiles drop constraint if exists profiles_avatar_zoom_range;
alter table public.profiles add constraint profiles_avatar_zoom_range check (avatar_zoom between 25 and 500);
alter table public.profiles drop constraint if exists profiles_cover_zoom_range;
alter table public.profiles add constraint profiles_cover_zoom_range check (cover_zoom between 25 and 500);

-- Normalize membership enum-like values before enforcing current constraints on partial installs.
update public.memberships set role='member' where role is null or role not in ('member','admin');
update public.memberships set plan='free' where plan is null or plan not in ('free','vip');
update public.memberships set status='active' where status is null or status not in ('active','suspended');
alter table public.memberships drop constraint if exists memberships_role_check_v316;
alter table public.memberships add constraint memberships_role_check_v316 check(role in ('member','admin'));
alter table public.memberships drop constraint if exists memberships_plan_check_v316;
alter table public.memberships add constraint memberships_plan_check_v316 check(plan in ('free','vip'));
alter table public.memberships drop constraint if exists memberships_status_check_v316;
alter table public.memberships add constraint memberships_status_check_v316 check(status in ('active','suspended'));

-- Ensure the public projection is synchronized for all existing users.
do $$
declare r record;
begin
  if to_regprocedure('public.sync_member_public_profile_v313(uuid)') is not null then
    for r in select id from auth.users loop
      begin
        perform public.sync_member_public_profile_v313(r.id);
      exception when others then
        raise notice 'Projection sync skipped for %: %', r.id, sqlerrm;
      end;
    end loop;
  end if;
end $$;

-- Keep current projection Realtime-enabled when publication exists.
do $$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
     and to_regclass('public.member_public_profiles') is not null
     and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='member_public_profiles') then
    alter publication supabase_realtime add table public.member_public_profiles;
  end if;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- C. SELF-HEAL RPC: call after login. Safe for normal authenticated users.
-- ---------------------------------------------------------------------------
create or replace function public.ensure_my_account_v316()
returns boolean
language plpgsql
security definer
set search_path=public,auth
as $$
declare
  v_uid uuid:=auth.uid();
  v_user auth.users%rowtype;
  v_name text;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_user from auth.users where id=v_uid;
  if not found then raise exception 'AUTH_USER_NOT_FOUND'; end if;
  v_name:=coalesce(nullif(trim(v_user.raw_user_meta_data->>'display_name'),''),nullif(trim(v_user.raw_user_meta_data->>'full_name'),''),nullif(trim(v_user.raw_user_meta_data->>'name'),''),split_part(coalesce(v_user.email,'Người dùng'),'@',1));
  insert into public.profiles(id,display_name,avatar_url)
  values(v_uid,left(v_name,60),coalesce(v_user.raw_user_meta_data->>'avatar_url',v_user.raw_user_meta_data->>'picture'))
  on conflict(id) do nothing;
  insert into public.memberships(user_id) values(v_uid) on conflict(user_id) do nothing;
  insert into public.site_settings(id) values(true) on conflict(id) do nothing;
  if to_regprocedure('public.sync_member_public_profile_v313(uuid)') is not null then
    perform public.sync_member_public_profile_v313(v_uid);
  end if;
  return true;
end;
$$;
revoke all on function public.ensure_my_account_v316() from public;
grant execute on function public.ensure_my_account_v316() to authenticated;

-- ---------------------------------------------------------------------------
-- D. SYSTEM HEALTH RPC. No private data is returned.
-- ---------------------------------------------------------------------------
create or replace function public.system_health_v316()
returns jsonb
language plpgsql
stable
security definer
set search_path=public
as $$
declare
  v_uid uuid:=auth.uid();
  v_core boolean;
  v_community boolean;
  v_payment boolean;
  v_avatar boolean;
  v_admin boolean;
  v_profile boolean:=false;
  v_membership boolean:=false;
  v_public_profile boolean:=false;
begin
  v_core := to_regclass('public.profiles') is not null
    and to_regclass('public.memberships') is not null
    and to_regclass('public.site_settings') is not null
    and to_regprocedure('public.get_my_account_state()') is not null
    and to_regprocedure('public.begin_export(integer)') is not null;
  v_community := to_regclass('public.friendships') is not null
    and to_regclass('public.direct_messages') is not null
    and to_regprocedure('public.send_direct_message(uuid,text)') is not null
    and to_regprocedure('public.list_direct_messages_v311(uuid,integer,timestamp with time zone)') is not null;
  v_payment := to_regclass('public.payment_requests') is not null
    and to_regclass('public.payment_events') is not null
    and to_regprocedure('public.submit_vip_payment_v32(integer,text,text,text,text)') is not null
    and to_regprocedure('public.admin_list_payments_v35(text)') is not null;
  v_avatar := to_regclass('public.member_public_profiles') is not null
    and to_regprocedure('public.set_my_avatar_thumb_v315(text,bigint)') is not null
    and to_regprocedure('public.list_member_directory_v316(text,integer)') is not null;
  v_admin := to_regprocedure('public.admin_stats()') is not null
    and to_regprocedure('public.admin_list_members(text)') is not null
    and to_regprocedure('public.admin_dashboard_v316(text,text)') is not null;
  if v_uid is not null then
    select exists(select 1 from public.profiles where id=v_uid) into v_profile;
    select exists(select 1 from public.memberships where user_id=v_uid) into v_membership;
    if to_regclass('public.member_public_profiles') is not null then
      select exists(select 1 from public.member_public_profiles where user_id=v_uid) into v_public_profile;
    end if;
  end if;
  return jsonb_build_object(
    'version','3.16.0',
    'core_ready',v_core,
    'community_ready',v_community,
    'payment_ready',v_payment,
    'avatar_ready',v_avatar,
    'admin_ready',v_admin,
    'profile_row',v_profile,
    'membership_row',v_membership,
    'public_profile_row',v_public_profile,
    'authenticated',v_uid is not null
  );
end;
$$;
revoke all on function public.system_health_v316() from public;
grant execute on function public.system_health_v316() to authenticated;

-- Record the repair level without coupling application logic to it.
create table if not exists public.nts_schema_versions(
  version text primary key,
  applied_at timestamptz not null default now(),
  notes text
);
alter table public.nts_schema_versions enable row level security;
revoke all on public.nts_schema_versions from anon,authenticated;
insert into public.nts_schema_versions(version,notes)
values('3.16.0','Full system repair 001..016 + health doctor')
on conflict(version) do update set applied_at=now(),notes=excluded.notes;

-- Ask PostgREST to refresh its schema cache after function/column changes.
notify pgrst, 'reload schema';

commit;
