-- ============================================================
--  Vissza! / REpontCheck – admin értesítések
--  Futtasd a Supabase SQL Editorban (egyszer).
-- ============================================================

-- 1) adminok: ide kerülnek azok a user_id-k, akik értesítést küldhetnek
create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- 2) értesítések
create table if not exists public.announcements (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (length(trim(title)) between 1 and 80),
  body       text not null check (length(trim(body)) between 1 and 280),
  kind       text not null default 'info' check (kind in ('info', 'news', 'warn')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists announcements_created_idx
  on public.announcements (created_at desc);

-- 3) RLS
alter table public.admins        enable row level security;
alter table public.announcements enable row level security;

-- 3a) van-e admin jogom? EZT ELŐBB KELL LÉTREHOZNI, mint a policy-kat
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- megjegyzés: az alábbi policy-k a security-definer is_admin() függvényt használják.
-- (Ha közvetlenül az admins táblára szűrnénk, az RLS miatt mindig üres lenne → beszúrás elutasítva.)

drop policy if exists admins_select_own on public.admins;
create policy admins_select_own on public.admins
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists announcements_read on public.announcements;
create policy announcements_read on public.announcements
  for select using (true);

drop policy if exists announcements_insert_admin on public.announcements;
create policy announcements_insert_admin on public.announcements
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists announcements_update_admin on public.announcements;
create policy announcements_update_admin on public.announcements
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists announcements_delete_admin on public.announcements;
create policy announcements_delete_admin on public.announcements
  for delete to authenticated
  using (public.is_admin());

-- 4) realtime: új értesítés azonnal megjelenik a nyitott appokban
do $$
begin
  alter publication supabase_realtime add table public.announcements;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

-- ============================================================
--  6) ADMIN BEÁLLÍTÁSA
--  Írd be a saját bejelentkező e-mail címed, és futtasd ezt is:
-- ============================================================
-- insert into public.admins (user_id)
-- select id from auth.users where lower(email) = lower('IDE_IRD_AZ_EMAILED')
-- on conflict (user_id) do nothing;

-- ellenőrzés:
-- select u.email, a.created_at from public.admins a join auth.users u on u.id = a.user_id;
