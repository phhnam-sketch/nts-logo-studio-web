-- ============================================================================
-- NTS LOGO STUDIO WEB V3 - MEMBERSHIP / ADMIN / PROFILE / BILLING
-- Chạy TOÀN BỘ file này một lần trong Supabase > SQL Editor.
-- Sau khi chạy xong, xem ADMIN_SETUP.md để cấp quyền admin đầu tiên.
-- ============================================================================

begin;

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

commit;
