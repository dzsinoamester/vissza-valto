-- ============================================================
--  Moderáció: felhasználó tiltása és üzenet jelentése
--
--  Futtasd a Supabase SQL Editorban a schema + social + friends után.
-- ============================================================

-- ---- tiltások ----
create table if not exists public.user_blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

alter table public.user_blocks enable row level security;

drop policy if exists blocks_own_read on public.user_blocks;
create policy blocks_own_read on public.user_blocks
  for select to authenticated using (blocker_id = auth.uid());

drop policy if exists blocks_own_insert on public.user_blocks;
create policy blocks_own_insert on public.user_blocks
  for insert to authenticated with check (blocker_id = auth.uid());

drop policy if exists blocks_own_delete on public.user_blocks;
create policy blocks_own_delete on public.user_blocks
  for delete to authenticated using (blocker_id = auth.uid());

-- ---- üzenet-jelentések ----
create table if not exists public.message_reports (
  id          bigserial primary key,
  message_id  bigint not null references public.messages(id) on delete cascade,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reason      text not null default 'abuse' check (reason in ('abuse', 'spam', 'other')),
  note        text not null default '' check (char_length(note) <= 280),
  status      text not null default 'open' check (status in ('open', 'resolved')),
  created_at  timestamptz not null default now(),
  unique (message_id, reporter_id)
);

create index if not exists message_reports_open_idx
  on public.message_reports (created_at desc) where status = 'open';

alter table public.message_reports enable row level security;

drop policy if exists reports_own_insert on public.message_reports;
create policy reports_own_insert on public.message_reports
  for insert to authenticated with check (reporter_id = auth.uid());

drop policy if exists reports_read on public.message_reports;
create policy reports_read on public.message_reports
  for select to authenticated
  using (reporter_id = auth.uid() or public.is_admin());

drop policy if exists reports_resolve on public.message_reports;
create policy reports_resolve on public.message_reports
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---- tiltott felhasználó üzenetei ne is jöjjenek le ----
-- (restriktív szabály: a meglévő olvasási jogosultságok mellé ÉS-kapcsolódik)
drop policy if exists messages_hide_blocked on public.messages;
create policy messages_hide_blocked on public.messages
  as restrictive for select to authenticated
  using (
    not exists (
      select 1 from public.user_blocks b
      where b.blocker_id = auth.uid() and b.blocked_id = messages.sender_id
    )
  );
