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
| **Lépésről lépésre** | Az útvonal-kártyán és az appon belüli navigációban is végigkattinthatók a lépések (‹ n/N › léptető, ☰ lépéslista) – a manőver helye zöld jelölővel a térképen, a „Vissza" gombbal azonnal vissza a teljes útvonalhoz / valós idejű követéshez. |
| **Mobil** | A panel alulra kerül, húzható lapkaként; a részletek alsó lapkaként nyílnak. |

A bal felső sarokban a fejléc statisztikája és az adatok frissítésének dátuma látszik.

## Adatok

Az adat a MOHU nyilvános térképes API-járól származik (`https://map.mohu.hu/api/Map/`),
és készen van letöltve a `data/` mappába. Frissíteni így kell:

```bash
node tools/fetch-data.mjs      # lekéri az összes pontot + a nyitvatartásukat
node tools/gen-megye.mjs       # irányítószám -> megye tábla (a profil jelvényeihez)
```

A szkript ~4800 kérést párhuzamosan (24 szálon) futtat, 2–3 perc. Eredmény:

* `data/repontok.json` – `[{id, type, lat, lng, name, address, city, zip, hours:{h,s,v}}, …]`
* `data/repontok-meta.json` – összesítés + `updatedAt`

A `gen-megye.mjs` a `counties.geojson` (geoHungary, NUTS3) alapján kiszámolja minden pont
irányítószámának megyéjét, és `data/zip-megye.json` fájlt ír (~43 KB). `fetch-data.mjs`
futtatása után érdemes újrafuttatni, ha új irányítószámok jelentek meg.

Az oldal induláskor és félóránként automatikusan betölti ezeket (a böngésző gyorsítótára nélkül).

## Bejelentkezés (Supabase)

Az oldal statikus, a fiókokat a projekt Supabase példánya kezeli (`js/config.js`). A beállítás:

1. **Séma** – a Supabase → SQL Editorban futtasd sorban: `data/supabase-schema.sql`, majd
   `data/supabase-extra.sql` (ez hozza létre a `profiles`/`ratings` táblát, az RLS-t és a
   regisztrációs triggert).
2. **Szolgáltató** – Authentication → Providers → *Email* legyen bekapcsolva.
3. **URL-ek** – Authentication → URL Configuration:
   * **Site URL** = a saját domained (`https://<domain>/`). A Supabase alapértelmezése
     `http://localhost:3000` – ha ezt hagyod, a regisztrációt megerősítő e-mail linkje
     `localhost`-ra mutat, ami másik eszközről (pl. telefonról) nem érhető el
     (`ERR_CONNECTION_REFUSED`).
   * **Redirect URLs** = `https://<domained>/**`, fejlesztéshez `http://localhost:8080/**`.
     Ha a kód által küldött `redirectTo` nincs ezen a listán, a Supabase **a Site URL-re
     irányít** vissza – ezért vezethet localhost-ra egy éles regisztráció után is.
   * Authentication → Email Templates → *Confirm signup*: a hivatkozás `{{ .ConfirmationURL }}`
     legyen (a `{{ .SiteURL }}` a fenti Site URL-t használná).

   A már kiküldött levelekben a régi link marad, az újak a mentés után a jó címutat kapják.
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

## Profil

A **Profil** fül nem csak a számokat mutatja:

* **Haladási sáv** a tetején: melyik jelvény van a legközelebb (pl. „Következő jelvény: 7/10 értékelt pont").
* **Statisztika + sorozat** – értékelt pontok, átlag, legjobb és a napos sorozat (hány napja van
  folyamatosan látogatásod vagy értékelésed).
* **Jelvények** – „Első visszaváltás", „10 értékelt pont", „5 megye" (irányítószámból számolva),
  „Éjszakai bagoly" (éjfél után mentett értékelés) és „Segítő" (5 üzemállapot-jelzés).
* **Visszaváltás-napló + kassza** – dátum, palackdarabszám és kaució rögzítése; a kassza
  50 Ft/db + kaució alapján számol (összesen és e hónapban), alatta **havi oszlopdiagram**
  az utolsó hat hónapról, a sorok ✗-szel törölhetők. Az eszközön (`localStorage`) tárolódik,
  bejelentkezés nélkül is működik.
* **Látogatások** – a legutóbbi 8 látogatás dátummal; koppintásra a térképen nyílik meg a pont.
* **Kedvenceid** – „Útvonal" gombbal egyből indul az útvonaltervezés.
* **Értékeléseid** – pontszám, címkék, dátum, és szerkesztés (✎) / törlés (🗑) innen is.
* **Megjelenített név** – a fejléc ceruzájával szerkeszthető (a `profiles.display_name` tárolja).
* **Avatar** – a fejléc 😊 gombjával emoji + szín választható (30 emoji, 8 szín). Vendégként
  az eszközön, bejelentkezve a fiók `user_metadata`-jában tárolódik, így minden eszközödön
  ugyanaz jelenik meg. Az „Alapértelmezett” visszaállítja a névbetűt.

A megye-jelvényhez szükséges `data/zip-megye.json` hiányzik vagy frissíteni kell:
`node tools/gen-megye.mjs`.

## Közösségi funkciók

A `data/supabase-social.sql` futtatása után (a schema + extra után) működnek:

| | |
|---|---|
| **Üzemállapot** | A részletek lapkában „Tele van / Kiürült / Nem fogadja" jelzés, ami **2 óráig** érvényes. A jelzés a térképen színes gyűrűként, a listában és a kártyán jelvényként látszik. Jelenteni bejelentkezve lehet (egy felhasználónak egy ponton egy jelzése van). |
| **Értékelés-szinkron** | Bejelentkezés után a helyi értékelések felkerülnek a `ratings` táblába, és a fiók más eszközön mért értékelései lejönnek. A `point_ratings` nézet (átlag + darabszám) mindenkinek látszik: a kártyán és a részletekben is megjelenik, a „Legjobbra értékelt" rendezés pedig ezt is figyelembe veszi. |
| **Kedvencek** | ★ a kártyán és a részletekben, külön „Kedvencek" szűrővel. Bejelentkezés nélkül az eszközön tárolódik, belépés után a fiókhoz szinkronizál. |
| **Legutóbb itt váltottál** | A panel tetején kártya az utolsó úti céloddal és egy koppintásos útvonallal. Navigáció indításakor rögzítődik, fiókkal eszközök között is megmarad. |

## Barátok, chat, csoportok, bökés

A `data/supabase-friends.sql` futtatása után (a schema + extra + social UTÁN) működnek:

| | |
|---|---|
| **Barátok** | A dokk **Barátok** gombján keresztül név alapú kereséssel barátkérést küldhetsz, fogadhatsz, illetve eltávolíthatod a barátaidat. |
| **Csevegés** | A barátokkal közvetlen, a csoportokkal többtagú beszélgetés; az üzenetek a szerveren tárolódnak, a listák ~5 másodpercenként frissülnek (nincs Realtime). |
| **Csoportok** | Új csoport létrehozása névvel és tagokkal a barátok közül. |
| **Bökés** 🍾 | Egy koppintás a barátnak — a másik értesítést kap, a dokk gombján piros jelzés jelenik meg. |
| **Névvel ellátott értékelések** | A pont részleteiben mindenki értékelése megjelenik a szerző nevével (a `point_reviews` nézet anonim is olvasható). |
| **Megosztás / QR** | A részletek lapkáján a 📤 gomb QR-kódot, másolható `#pont/<id>` linket, Web Share-t és „barátoknak küldést" ad. |
| **Mélyhivatkozás** | A `https://<oldal>/#pont/123` formájú link (QR-ból is) automatikusan megnyitja az adott REpont részleteit. |

> A QR-kódot a [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) CDN-verziója rajzolja.
> Két fiókkal tudod kipróbálni: az egyik küldi a barátkérést, a másik elfogadja — a chat end-to-end
> teszteléséhez két külön böngészőprofil (vagy munkamenet) kell.

## Fájlok

```
index.html            a felület váza
css/styles.css        MOHU arculat (mohu.hu hivatalos CSS-ből kinyert színekkel)
js/app.js             minden viselkedés: térkép, keresés, szűrők, SOS, részletek
data/repontok.json    a letöltött pontok
data/zip-megye.json   irányítószám -> megye (a profil megye-jelvényéhez)
data/supabase-schema.sql  profiles + ratings tábla, RLS
data/supabase-extra.sql   profil RLS, regisztrációs trigger, fióktörlés
data/supabase-social.sql  jelentések, kedvencek, látogatások, értékelés-összesítő
data/supabase-friends.sql barátok, csoportok, chat, bökés, névvel ellátott értékelések
tools/fetch-data.mjs  adatfrissítés
tools/gen-megye.mjs   irányítószám -> megye tábla generálása
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
