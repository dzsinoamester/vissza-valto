-- ============================================================
--  REpontCheck – beszélgetés indítása: jogosultsági hiba javítása
--
--  Ezt az EGY fájlt futtasd a Supabase SQL Editorban.
--  Kicsi és önálló: nem függ a nagy friends.sql view-jaitól, ezért
--  nem tud egy másik utasítás hibája miatt visszagörögni.
--  Újrafuttatható.
-- ============================================================

-- 1) A tagság-policy-k a legfrissebb szabállyal
alter table public.conversation_members enable row level security;

drop policy if exists "tagság olvasása" on public.conversation_members;
create policy "tagság olvasása" on public.conversation_members
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "tagság írása" on public.conversation_members;
create policy "tagság írása" on public.conversation_members
  for insert to authenticated
  with check (
    user_id = auth.uid()
    or exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.created_by = auth.uid()
    )
    or exists (
      select 1 from public.conversation_members m
      where m.conversation_id = conversation_id and m.user_id = auth.uid()
    )
  );

-- 2) A beszélgetés megnyitása egyetlen szerveroldali hívással.
--    SECURITY DEFINER: RLS-től függetlenül létrehozza a dm-et és
--    mindkét fél tagságát, így nem kell a kliensnek két lépésben írnia.
create or replace function public.dm_open(other uuid)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  uid uuid := auth.uid();
  cid text;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if other is null or other = uid then
    raise exception 'invalid recipient';
  end if;

  cid := 'dm-' || least(uid::text, other::text) || '-' || greatest(uid::text, other::text);

  insert into public.conversations (id, kind, created_by)
    values (cid, 'dm', uid)
    on conflict (id) do nothing;

  insert into public.conversation_members (conversation_id, user_id)
    values (cid, uid), (cid, other)
    on conflict (conversation_id, user_id) do nothing;

  return cid;
end;
$$;

revoke all on function public.dm_open(uuid) from public;
grant execute on function public.dm_open(uuid) to authenticated;

-- 3) Ellenőrzés (opcionális, csak kiíráshoz)
select policyname, cmd, with_check
  from pg_policies
 where schemaname = 'public' and tablename = 'conversation_members';
