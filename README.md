# REpontCheck

A MOHU **REpont** visszaváltópontjainak keresője – térképen, magyarul, a MOHU arculatával.
A [Budicheck](https://budicheck.app)-hoz hasonló felépítés: bal oldali kereső + lista,
nagy térkép jelölőkkel, és egy **SOS** mód, ami a legközelebbi *nyitott* ponthoz navigál.

## Futtatás

Nincs szükség build lépésre – statikus oldal.

```bash
cd repontcheck
node tools/serve.mjs          # -> http://localhost:8080
```

Bármilyen más statikus szerver is megteszi (`npx serve`, `python -m http.server`, vagy
egyszerűen megnyitva `index.html`-t fájl:// alól – de az adatbetöltéshez HTTP szerver kell).

## Funkciók

| | |
|---|---|
| **Térkép** | Mind a **4804** REpont-jelölt (3420 automata + 1384 kézi pont) klúszerezve. |
| **Keresés** | Település, bolt vagy cím szerint – ékezetfüggetlenül a letöltött adatokban, + a [Photon](https://photon.komoot.io) segítségével helyszínjavaslatok a térképre ugráshoz. |
| **Szűrők** | Összes / Automata / Kézi / **Most nyitva** – a nyitvatartás valós kiszámításával. |
| **Távolság** | „Itt vagyok" → a lista, a gyorskártya és a részletek is távolság szerint rendeződnek. |
| **Részletek** | Nyitvatartás naponta (a mai nap kiemelve), navigáció Google / Waze / Apple Térképpel, cím másolása. |
| **SOS mód** | Megkeresi a legközelebbi **nyitott** pontot, forgó iránytűvel és távolsággal; a „Következő" gombbal a további 4 legközelebbi között lapozhatsz. |
| **Mobil** | A panel alulra kerül, húzható lapkaként; a részletek alsó lapkaként nyílnak. |

A bal felső sarokban a fejléc statisztikája és az adatok frissítésének dátuma látszik.

## Adatok

Az adat a MOHU nyilvános térképes API-járól származik (`https://map.mohu.hu/api/Map/`),
és készen van letöltve a `data/` mappába. Frissíteni így kell:

```bash
node tools/fetch-data.mjs      # lekéri az összes pontot + a nyitvatartásukat
```

A szkript ~4800 kérést párhuzamosan (24 szálon) futtat, 2–3 perc. Eredmény:

* `data/repontok.json` – `[{id, type, lat, lng, name, address, city, zip, hours:{h,s,v}}, …]`
* `data/repontok-meta.json` – összesítés + `updatedAt`

Az oldal induláskor és félóránként automatikusan betölti ezeket (a böngésző gyorsítótára nélkül).

## Bejelentkezés (Supabase)

Az oldal statikus, a fiókokat a projekt Supabase példánya kezeli (`js/config.js`). A beállítás:

1. **Séma** – a Supabase → SQL Editorban futtasd sorban: `data/supabase-schema.sql`, majd
   `data/supabase-extra.sql` (ez hozza létre a `profiles`/`ratings` táblát, az RLS-t és a
   regisztrációs triggert).
2. **Szolgáltató** – Authentication → Providers → *Email* legyen bekapcsolva.
3. **URL-ek** – Authentication → URL Configuration: Site URL a saját domained, a Redirect
   URLs közé pedig `https://<domained>/**` és fejlesztéshez `http://localhost:8080/**`
   (a megerősítő és jelszó-visszaállító linkek ide térnek vissza).
4. A `js/config.js`-ben csak a nyilvános `SUPABASE_URL` és publishable (`sb_publishable_…`)
   kulcs szerepel — a védelmet az adatbázis RLS-szabályai adják. `sb_secret_…` kulcsot soha ne kerüljön a fájlba.

A **Profil** fülön érhető el a bejelentkezés, a regisztráció (megjelenített névvel), az
elfelejtett jelszó, a jelszó-módosítás, a kijelentkezés és a fióktörlés. Ha a regisztráció
`Database error saving new user` hibát ad, a `data/supabase-schema.sql` nem futott le.

## Első látogató: bemutató

Első látogatáskor (és amíg a fiók nincs bejelentkezve) teljes képernyős, háromlépéses
bemutató indul: hol találod a legközelebbi pontot, hogyan látod a közösségi üzemállapotot,
és hogyan indulsz el. Alul „Regisztrálok”, „Már van fiókom” és „Csak körülnézek” — a
térkép belépés nélkül is használható.

- Csak egyszer jelenik meg: a `vissza:intro-seen` kulcs a `localStorage`-ban.
- Nem jön be, ha be vagy jelentkezve, vagy ha `#lat,lng` linkkel érkezel.
- Kihagyható a „Kihagyás” gombbal, az `Esc`-pel vagy a háttérre koppintva; a nyilak
  lépkednek a kártyák között.
- Bármikor újranyitható: **Profil → Bemutató**.

## Közösségi funkciók

A `data/supabase-social.sql` futtatása után (a schema + extra után) működnek:

| | |
|---|---|
| **Üzemállapot** | A részletek lapkában „Tele van / Kiürült / Nem fogadja" jelzés, ami **2 óráig** érvényes. A jelzés a térképen színes gyűrűként, a listában és a kártyán jelvényként látszik. Jelenteni bejelentkezve lehet (egy felhasználónak egy ponton egy jelzése van). |
| **Értékelés-szinkron** | Bejelentkezés után a helyi értékelések felkerülnek a `ratings` táblába, és a fiók más eszközön mért értékelései lejönnek. A `point_ratings` nézet (átlag + darabszám) mindenkinek látszik: a kártyán és a részletekben is megjelenik, a „Legjobbra értékelt" rendezés pedig ezt is figyelembe veszi. |
| **Kedvencek** | ★ a kártyán és a részletekben, külön „Kedvencek" szűrővel. Bejelentkezés nélkül az eszközön tárolódik, belépés után a fiókhoz szinkronizál. |
| **Legutóbb itt váltottál** | A panel tetején kártya az utolsó úti céloddal és egy koppintásos útvonallal. Navigáció indításakor rögzítődik, fiókkal eszközök között is megmarad. |

## Fájlok

```
index.html            a felület váza
css/styles.css        MOHU arculat (mohu.hu hivatalos CSS-ből kinyert színekkel)
js/app.js             minden viselkedés: térkép, keresés, szűrők, SOS, részletek
data/repontok.json    a letöltött pontok
data/supabase-schema.sql  profiles + ratings tábla, RLS
data/supabase-extra.sql   profil RLS, regisztrációs trigger, fióktörlés
data/supabase-social.sql  jelentések, kedvencek, látogatások, értékelés-összesítő
tools/fetch-data.mjs  adatfrissítés
tools/serve.mjs       helyi kiszolgáló fejlesztéshez
```

## Arculat

A színek a MOHU hivatalos CSS-ből származnak:

| | |
|---|---|
| `#434244` | tinta / fejléc háttér |
| `#D8E02F` | lime – kiemelés, gombok, SOS |
| `#F16524` | narancs – **automata** jelölő |
| `#00BBDC` | kék – **kézi** gyűjtés jelölő |
| `#24A148` / `#196E31` | zöld – nyitva |
| `#DA1E28` | piros – zárva / SOS aktív |

Betűtípusok: **Ubuntu** (címek, számok) + **Karla** (szöveg), ahogy a mohu.hu-n.

## Megjegyzés

A visszaváltás mindig az adott üzlet nyitvatartásához kötött – az alkalmazás ezt
a nyitvatartást jeleníti meg, de érdemes a helyszínen is ellenőrizni.
