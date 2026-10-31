-- ============================================================
--  REpontCheck – kiegészítő beállítások (futtasd az SQL Editorban)
--  Az első SQL (profiles + ratings tábla) után kell lefuttatni.
-- ============================================================

-- 1) A profiles tábla védelme (enélkül bárki olvashatná az anon kulccsal!)
alter table public.profiles enable row level security;

drop policy if exists "saját profil olvasása" on public.profiles;
create policy "saját profil olvasása" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "saját profil módosítása" on public.profiles;
create policy "saját profil módosítása" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- 2) Profilsor automatikus létrehozása regisztrációkor
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3) Saját fiók törlése (az app „Fiók törlése” gombja ezt hívja)
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  delete from auth.users where id = auth.uid();   -- a profil és az értékelések is törlődnek (cascade)
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
