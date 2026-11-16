-- ============================================================
--  JAVÍTÁS: „new row violates row-level security policy for table announcements”
--
--  Ok: az insert-policy egy `exists (select 1 from public.admins ...)`
--  al-lekérdezést használt, de az `admins` táblán is be van kapcsolva az RLS
--  (policy nélkül), ezért az al-lekérdezés mindig üres → a beszúrás mindig elutasítva.
--
--  Megoldás: a policy a security-definer `is_admin()` függvényt hívja,
--  ami megkerüli az RLS-t. Futtasd ezt a Supabase SQL Editorban.
-- ============================================================

-- 1) a saját admin-sorát mindenki láthassa (az is_admin() amúgy is definer)
drop policy if exists admins_select_own on public.admins;
create policy admins_select_own on public.admins
  for select to authenticated
  using (user_id = auth.uid());

-- 2) announcements: írás csak adminnak, a definer függvényen keresztül
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

-- 3) ellenőrzés: admin vagy-e, és látod-e a saját sorodat
select public.is_admin() as admin_vagyok;

select u.email
from public.admins a
join auth.users u on u.id = a.user_id;
