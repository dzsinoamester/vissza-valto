-- ============================================================
--  REpontCheck – alap sémata
--  Futtasd a Supabase SQL Editorban ELŐSZÖR, majd utána a
--  data/supabase-extra.sql-t (profil RLS + regisztrációs trigger).
-- ============================================================

-- 1) Profilok (a regisztrációs trigger ebbe ír)
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now()
);

-- 2) Értékelések (a visszajelzések szerveroldali párja)
create table if not exists public.ratings (
  id         bigserial primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  point_id   bigint not null,
  score      smallint not null check (score between 1 and 10),
  tags       text[] not null default '{}',
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, point_id)
);

create index if not exists ratings_point_idx on public.ratings (point_id);

-- 3) Csak a saját értékeléseidet látod és írhatod
alter table public.ratings enable row level security;

drop policy if exists "saját értékelés olvasása" on public.ratings;
create policy "saját értékelés olvasása" on public.ratings
  for select using (auth.uid() = user_id);

drop policy if exists "saját értékelés írása" on public.ratings;
create policy "saját értékelés írása" on public.ratings
  for insert with check (auth.uid() = user_id);

drop policy if exists "saját értékelés módosítása" on public.ratings;
create policy "saját értékelés módosítása" on public.ratings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "saját értékelés törlése" on public.ratings;
create policy "saját értékelés törlése" on public.ratings
  for delete using (auth.uid() = user_id);
