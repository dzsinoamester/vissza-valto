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

## Fájlok

```
index.html            a felület váza
css/styles.css        MOHU arculat (mohu.hu hivatalos CSS-ből kinyert színekkel)
js/app.js             minden viselkedés: térkép, keresés, szűrők, SOS, részletek
data/repontok.json    a letöltött pontok
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
