-- ============================================================================
-- NTS LOGO STUDIO WEB V3.5 - FAST PROFILE POSITION + PAYOS AUTO PAYMENT
-- Chạy SAU 001, 002, 003. Có thể chạy lại an toàn.
-- ============================================================================
begin;

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
alter table public.profiles drop constraint if exists profiles_avatar_zoom_range;
alter table public.profiles add constraint profiles_avatar_zoom_range check (avatar_zoom between 100 and 220);
alter table public.profiles drop constraint if exists profiles_cover_pos_x_range;
alter table public.profiles add constraint profiles_cover_pos_x_range check (cover_pos_x between 0 and 100);
alter table public.profiles drop constraint if exists profiles_cover_pos_y_range;
alter table public.profiles add constraint profiles_cover_pos_y_range check (cover_pos_y between 0 and 100);
alter table public.profiles drop constraint if exists profiles_cover_zoom_range;
alter table public.profiles add constraint profiles_cover_zoom_range check (cover_zoom between 100 and 220);

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

commit;
