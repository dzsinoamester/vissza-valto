-- ============================================================
--  Admin beállítása: dzsinokalla@gmail.com
--  Futtasd a Supabase SQL Editorban (az announcements SQL után).
-- ============================================================

insert into public.admins (user_id)
select id from auth.users where lower(email) = lower('dzsinokalla@gmail.com')
on conflict (user_id) do nothing;

-- Ellenőrzés: kik adminok most
select u.email, a.created_at
from public.admins a
join auth.users u on u.id = a.user_id;

-- Ha az előző select üres: a fiók még nem létezik az auth-ban.
-- Ilyenkor előbb jelentkezz be az appban ezzel az e-maillel, majd futtasd újra.
-- Az összes regisztrált e-mail listája (ha nem tudod, melyikkel léptél be):
-- select email, created_at, last_sign_in_at from auth.users order by created_at desc;
