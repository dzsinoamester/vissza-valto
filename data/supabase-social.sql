-- ============================================================
--  REpontCheck – közösségi funkciók
--  Futtasd a Supabase SQL Editorban a schema + extra után.
--  Újrafuttatható (idempotens).
-- ============================================================

-- 1) Üzemállapot-jelentések ("tele van", "kiürült", "nem fogadja")
create table if not exists public.point_reports (
  id         bigserial primary key,
  point_id   bigint not null,
  user_id    uuid not null references auth.users(id) on delete cascade,
  status     text not null check (status in ('tele', 'urult', 'hibas')),
  created_at timestamptz not null default now()
);

create index if not exists point_reports_recent_idx on public.point_reports (created_at desc);
create index if not exists point_reports_point_idx on public.point_reports (point_id, created_at desc);

alter table public.point_reports enable row level security;

-- mindenki (bejelentkezés nélkül is) látja a friss, 3 óránál nem régebbi jelzéseket
drop policy if exists "friss jelentések olvasása" on public.point_reports;
create policy "friss jelentések olvasása" on public.point_reports
  for select to anon, authenticated
  using (created_at > now() - interval '3 hours');

drop policy if exists "saját jelentés írása" on public.point_reports;
create policy "saját jelentés írása" on public.point_reports
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "saját jelentés törlése" on public.point_reports;
create policy "saját jelentés törlése" on public.point_reports
  for delete to authenticated using (auth.uid() = user_id);

-- 2) Kedvencek (fiókhoz kötve)
create table if not exists public.favorites (
  user_id    uuid not null references auth.users(id) on delete cascade,
  point_id   bigint not null,
  created_at timestamptz not null default now(),
  primary key (user_id, point_id)
);

alter table public.favorites enable row level security;

drop policy if exists "saját kedvencek olvasása" on public.favorites;
create policy "saját kedvencek olvasása" on public.favorites
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "saját kedvenc írása" on public.favorites;
create policy "saját kedvenc írása" on public.favorites
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "saját kedvenc törlése" on public.favorites;
create policy "saját kedvenc törlése" on public.favorites
  for delete to authenticated using (auth.uid() = user_id);

-- 3) Látogatások ("legutóbb itt váltottál")
create table if not exists public.visits (
  user_id    uuid not null references auth.users(id) on delete cascade,
  point_id   bigint not null,
  visited_at timestamptz not null default now(),
  primary key (user_id, point_id)
);

create index if not exists visits_recent_idx on public.visits (user_id, visited_at desc);

alter table public.visits enable row level security;

drop policy if exists "saját látogatások olvasása" on public.visits;
create policy "saját látogatások olvasása" on public.visits
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "saját látogatás írása" on public.visits;
create policy "saját látogatás írása" on public.visits
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "saját látogatás módosítása" on public.visits;
create policy "saját látogatás módosítása" on public.visits
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 4) Értékelések nyilvános összesítése (csak átlag + darabszám, személyes adat nélkül)
create or replace view public.point_ratings as
select
  point_id,
  round(avg(score)::numeric, 1) as avg_score,
  count(*)::int                 as votes
from public.ratings
group by point_id;

grant select on public.point_ratings to anon, authenticated;
