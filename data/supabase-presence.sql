-- ============================================================
--  REpontCheck – „most aktív” állapot a barátoknál
--
--  Ezt az EGY fájlt futtasd a Supabase SQL Editorban.
--  Kicsi, önálló, újrafuttatható.
--
--  A kliens percenként frissíti a saját profiles.last_seen értékét
--  (a „saját profil módosítása” policy ezt engedi), a barátok
--  aktivitását pedig a user_names view-ból olvassa.
-- ============================================================

-- 1) Az új oszlop (ha még nincs)
alter table public.profiles
  add column if not exists last_seen timestamptz;

-- 2) A névkereső view kiegészítése – a CREATE OR REPLACE csak a végére
--    fűzött új oszlopot engedi, ezért a last_seen kerül a végére.
create or replace view public.user_names as
select id, display_name, last_seen
from public.profiles;

grant select on public.user_names to authenticated;

-- 3) Ellenőrzés (opcionális)
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'profiles'
   and column_name = 'last_seen';
