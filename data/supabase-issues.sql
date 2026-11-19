-- ============================================================
--  Adathiba-jelzések (a pont adatai: megszűnt, rossz hely, rossz nyitvatartás)
--
--  A meglévő "Üzemállapot" (point_reports) a pillanatnyi állapotra szól 1 órára.
--  Ez a tábla a strukturális hibákat gyűjti, hogy admin átnézhesse.
--
--  Futtasd a Supabase SQL Editorban (a schema/extra/admin után).
-- ============================================================

create table if not exists public.point_issues (
  id         bigserial primary key,
  point_id   bigint not null,
  user_id    uuid not null references auth.users(id) on delete cascade,
  kind       text not null check (kind in ('closed', 'moved', 'hours', 'other')),
  note       text not null default '' check (char_length(note) <= 280),
  status     text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default now(),
  unique (point_id, user_id, kind)
);

create index if not exists point_issues_open_idx
  on public.point_issues (created_at desc) where status = 'open';
create index if not exists point_issues_point_idx
  on public.point_issues (point_id);

alter table public.point_issues enable row level security;

-- A nyitott jelzések darabszáma mindenkinek látszik (a kártyán jelvényként).
drop policy if exists issues_read on public.point_issues;
create policy issues_read on public.point_issues
  for select to anon, authenticated
  using (status = 'open');

-- Jelzést csak bejelentkezve, a saját nevében lehet tenni.
drop policy if exists issues_insert on public.point_issues;
create policy issues_insert on public.point_issues
  for insert to authenticated
  with check (user_id = auth.uid() and status = 'open');

-- Visszavonhatja a saját jelzését.
drop policy if exists issues_delete_own on public.point_issues;
create policy issues_delete_own on public.point_issues
  for delete to authenticated
  using (user_id = auth.uid());

-- Admin lezárhatja (status = 'resolved').
drop policy if exists issues_resolve on public.point_issues;
create policy issues_resolve on public.point_issues
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Admin a lezártakat is lássa az összesítőben.
drop policy if exists issues_admin_read on public.point_issues;
create policy issues_admin_read on public.point_issues
  for select to authenticated
  using (public.is_admin());
