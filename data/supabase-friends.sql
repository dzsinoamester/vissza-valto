-- ============================================================
--  REpontCheck – barátok, csoportok, chat, bökés
--  + névvel ellátott, mindenki számára olvasható értékelések.
--
--  Futtasd a Supabase SQL Editorban a schema + extra + social
--  fájlok UTÁN. Újrafuttatható (idempotens).
-- ============================================================

-- 0) Névkereső és értékelés-lista (view)
--    A profiles tábla RLS-e csak a saját sort engedi olvasni, ezért
--    névkereséshez / mások értékeléséhez view kell.
--    A view alapból a tulajdonos (postgres) jogával fut, RLS nélkül.

create or replace view public.user_names as
select id, display_name from public.profiles;

grant select on public.user_names to authenticated;

-- mindenki láthatja az értékeléseket – a szerző megjelenített nevével
create or replace view public.point_reviews as
select
  r.point_id,
  r.user_id,
  r.score,
  r.tags,
  r.note,
  r.updated_at,
  coalesce(p.display_name, 'Ismeretlen') as display_name
from public.ratings r
left join public.profiles p on p.id = r.user_id;

grant select on public.point_reviews to anon, authenticated;

-- 1) Barátkérések
create table if not exists public.friend_requests (
  sender_id   uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (sender_id, receiver_id),
  check (sender_id <> receiver_id)
);

create index if not exists friend_requests_receiver_idx
  on public.friend_requests (receiver_id, created_at desc);

alter table public.friend_requests enable row level security;

drop policy if exists "barátkérések olvasása" on public.friend_requests;
create policy "barátkérések olvasása" on public.friend_requests
  for select to authenticated
  using (sender_id = auth.uid() or receiver_id = auth.uid());

drop policy if exists "barátkérés küldése" on public.friend_requests;
create policy "barátkérés küldése" on public.friend_requests
  for insert to authenticated with check (sender_id = auth.uid());

drop policy if exists "barátkérés törlése" on public.friend_requests;
create policy "barátkérés törlése" on public.friend_requests
  for delete to authenticated
  using (sender_id = auth.uid() or receiver_id = auth.uid());

-- 2) Barátságok (iránymentes: user_id < friend_id)
create table if not exists public.friendships (
  user_id    uuid not null references auth.users(id) on delete cascade,
  friend_id  uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  check (user_id < friend_id)
);

create index if not exists friendships_friend_idx on public.friendships (friend_id);

alter table public.friendships enable row level security;

drop policy if exists "barátságok olvasása" on public.friendships;
create policy "barátságok olvasása" on public.friendships
  for select to authenticated
  using (user_id = auth.uid() or friend_id = auth.uid());

drop policy if exists "barátság rögzítése" on public.friendships;
create policy "barátság rögzítése" on public.friendships
  for insert to authenticated
  with check (user_id = auth.uid() or friend_id = auth.uid());

drop policy if exists "barátság törlése" on public.friendships;
create policy "barátság törlése" on public.friendships
  for delete to authenticated
  using (user_id = auth.uid() or friend_id = auth.uid());

-- 3) Beszélgetések: egy dm két fő, egy group csoport.
--    Az azonosító kiszámítható, így nem keletkezik dupla dm.
create table if not exists public.conversations (
  id         text primary key,
  kind       text not null check (kind in ('dm', 'group')),
  name       text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id text not null references public.conversations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  joined_at       timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index if not exists conversation_members_user_idx
  on public.conversation_members (user_id);

alter table public.conversations enable row level security;

drop policy if exists "beszélgetés olvasása" on public.conversations;
create policy "beszélgetés olvasása" on public.conversations
  for select to authenticated
  using (exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = conversations.id and cm.user_id = auth.uid()
  ));

drop policy if exists "beszélgetés létrehozása" on public.conversations;
create policy "beszélgetés létrehozása" on public.conversations
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists "beszélgetés módosítása" on public.conversations;
create policy "beszélgetés módosítása" on public.conversations
  for update to authenticated using (created_by = auth.uid())
  with check (created_by = auth.uid());

alter table public.conversation_members enable row level security;

-- csak a saját tagságaim olvashatók (a résztvevők nevét a
-- conversation_participants view adja meg, ami szűr auth.uid() szerint)
drop policy if exists "tagság olvasása" on public.conversation_members;
create policy "tagság olvasása" on public.conversation_members
  for select to authenticated using (user_id = auth.uid());

-- saját magam felveszhetem; a létrehozó és a már meglévő tagok tehetik be a többieket
-- (a tagság-olvasási politika miatt a "már tag vagyok" ág a saját sorom
--  megléte nélkül nem látná a beszélgetést — ezért a sorrend a JS-ben is fontos)
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

drop policy if exists "tagság módosítása" on public.conversation_members;
create policy "tagság módosítása" on public.conversation_members
  for update to authenticated using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "tagság törlése" on public.conversation_members;
create policy "tagság törlése" on public.conversation_members
  for delete to authenticated using (user_id = auth.uid());

-- a beszélgetés résztvevőinek nevei (csak a saját beszélgetéseimre)
create or replace view public.conversation_participants as
select
  cm.conversation_id,
  cm.user_id,
  coalesce(p.display_name, 'Ismeretlen') as display_name
from public.conversation_members cm
join public.profiles p on p.id = cm.user_id
where exists (
  select 1 from public.conversation_members me
  where me.conversation_id = cm.conversation_id and me.user_id = auth.uid()
);

grant select on public.conversation_participants to authenticated;

-- 4) Üzenetek
create table if not exists public.messages (
  id              bigserial primary key,
  conversation_id text not null references public.conversations(id) on delete cascade,
  sender_id       uuid not null references auth.users(id) on delete cascade,
  body            text not null check (char_length(body) between 1 and 1000),
  created_at      timestamptz not null default now()
);

create index if not exists messages_conversation_idx
  on public.messages (conversation_id, created_at);

alter table public.messages enable row level security;

drop policy if exists "üzenet olvasása" on public.messages;
create policy "üzenet olvasása" on public.messages
  for select to authenticated
  using (exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = messages.conversation_id and cm.user_id = auth.uid()
  ));

drop policy if exists "üzenet írása" on public.messages;
create policy "üzenet írása" on public.messages
  for insert to authenticated
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = messages.conversation_id and cm.user_id = auth.uid()
    )
  );

drop policy if exists "üzenet törlése" on public.messages;
create policy "üzenet törlése" on public.messages
  for delete to authenticated using (sender_id = auth.uid());

-- 5) Bökés („megböktem”, mint a Facebookon)
create table if not exists public.pokes (
  id         bigserial primary key,
  from_id    uuid not null references auth.users(id) on delete cascade,
  to_id      uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  seen       boolean not null default false,
  check (from_id <> to_id)
);

create index if not exists pokes_to_idx on public.pokes (to_id, seen, created_at desc);

alter table public.pokes enable row level security;

drop policy if exists "kapott bökések olvasása" on public.pokes;
create policy "kapott bökések olvasása" on public.pokes
  for select to authenticated using (to_id = auth.uid());

drop policy if exists "bökés küldése" on public.pokes;
create policy "bökés küldése" on public.pokes
  for insert to authenticated with check (from_id = auth.uid());

drop policy if exists "bökés olvasottra jelölése" on public.pokes;
create policy "bökés olvasottra jelölése" on public.pokes
  for update to authenticated using (to_id = auth.uid())
  with check (to_id = auth.uid());

drop policy if exists "bökés törlése" on public.pokes;
create policy "bökés törlése" on public.pokes
  for delete to authenticated using (to_id = auth.uid() or from_id = auth.uid());

-- 6) Fióktörlés: az új táblák adatai is eltűnnek
--    (a régi függvényt írja felül – ugyanaz a szignó)
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  if to_regclass('public.ratings') is not null then
    delete from public.ratings where user_id = uid;
  end if;
  if to_regclass('public.pokes') is not null then
    delete from public.pokes where from_id = uid or to_id = uid;
  end if;
  if to_regclass('public.messages') is not null then
    delete from public.messages where sender_id = uid;
  end if;
  if to_regclass('public.conversation_members') is not null then
    delete from public.conversation_members where user_id = uid;
  end if;
  if to_regclass('public.conversations') is not null then
    delete from public.conversations c
    where c.created_by = uid
      and not exists (
        select 1 from public.conversation_members cm
        where cm.conversation_id = c.id
      );
  end if;
  if to_regclass('public.friend_requests') is not null then
    delete from public.friend_requests where sender_id = uid or receiver_id = uid;
  end if;
  if to_regclass('public.friendships') is not null then
    delete from public.friendships where user_id = uid or friend_id = uid;
  end if;

  delete from public.profiles where id = uid;
  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
-- 8) Értékelés-reakciók (szív / like / dislike) és válasz-kommentek
--    Egy értékelést a (point_id, review_user_id) pár azonosít.

create table if not exists public.review_reactions (
  point_id       bigint not null,
  review_user_id uuid not null references auth.users(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  kind           text not null check (kind in ('heart', 'like', 'dislike')),
  created_at     timestamptz not null default now(),
  primary key (point_id, review_user_id, user_id)
);

create index if not exists review_reactions_point_idx
  on public.review_reactions (point_id);

create table if not exists public.review_replies (
  id             bigserial primary key,
  point_id       bigint not null,
  review_user_id uuid not null references auth.users(id) on delete cascade,
  author_id      uuid not null references auth.users(id) on delete cascade,
  body           text not null check (char_length(btrim(body)) between 1 and 800),
  created_at     timestamptz not null default now()
);

create index if not exists review_replies_point_idx
  on public.review_replies (point_id, created_at);

alter table public.review_reactions enable row level security;
alter table public.review_replies  enable row level security;

drop policy if exists "reakciók olvasása" on public.review_reactions;
create policy "reakciók olvasása" on public.review_reactions
  for select to anon, authenticated using (true);

drop policy if exists "reakció írása" on public.review_reactions;
create policy "reakció írása" on public.review_reactions
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "reakció módosítása" on public.review_reactions;
create policy "reakció módosítása" on public.review_reactions
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "reakció törlése" on public.review_reactions;
create policy "reakció törlése" on public.review_reactions
  for delete to authenticated using (user_id = auth.uid());

drop policy if exists "válaszok olvasása" on public.review_replies;
create policy "válaszok olvasása" on public.review_replies
  for select to anon, authenticated using (true);

drop policy if exists "válasz írása" on public.review_replies;
create policy "válasz írása" on public.review_replies
  for insert to authenticated with check (author_id = auth.uid());

drop policy if exists "válasz törlése" on public.review_replies;
create policy "válasz törlése" on public.review_replies
  for delete to authenticated using (author_id = auth.uid());

grant select on public.review_reactions, public.review_replies to anon, authenticated;
grant insert, update, delete on public.review_reactions to authenticated;
grant insert, delete on public.review_replies to authenticated;
grant usage, select on sequence public.review_replies_id_seq to authenticated;

-- összesített reakciók (a view a tulajdonos jogával fut, RLS nélkül)
create or replace view public.review_reaction_counts as
select
  point_id,
  review_user_id,
  count(*) filter (where kind = 'heart')   as hearts,
  count(*) filter (where kind = 'like')    as likes,
  count(*) filter (where kind = 'dislike') as dislikes
from public.review_reactions
group by point_id, review_user_id;

grant select on public.review_reaction_counts to anon, authenticated;

-- válaszok a szerző megjelenített nevével
create or replace view public.review_reply_list as
select rr.id, rr.point_id, rr.review_user_id, rr.author_id, rr.body, rr.created_at,
       coalesce(p.display_name, 'Ismeretlen') as display_name
from public.review_replies rr
left join public.profiles p on p.id = rr.author_id;

grant select on public.review_reply_list to anon, authenticated;
