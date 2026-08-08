-- ============================================================================
-- NTS LOGO STUDIO WEB V3.2 - PROFILE DISPLAY + SMART PAYMENT
-- Chạy SAU 001_membership_schema.sql và 002_v3_1_production_fix.sql.
-- Có thể chạy lại an toàn.
-- ============================================================================
begin;

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

commit;
