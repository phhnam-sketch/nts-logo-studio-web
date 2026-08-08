-- ============================================================================
-- NTS LOGO STUDIO WEB V3.1 - PRODUCTION FIX
-- Chạy SAU 001_membership_schema.sql trong Supabase > SQL Editor.
-- Mục tiêu: sửa upload avatar/cover ổn định + cho Admin sửa profile hội viên.
-- Có thể chạy lại an toàn.
-- ============================================================================
begin;

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

commit;
