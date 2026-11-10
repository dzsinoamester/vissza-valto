/* ============================================================
   Vissza! — palackvisszaváltó pontok keresője
   Térkép : MapLibre GL JS + OpenFreeMap sötét vektoros stílus
   Útvonal: OSRM (kulcs nélküli, nyilvános demo)
   Adat   : data/repontok.json + data/repontok-meta.json
   Friss  : node tools/fetch-data.mjs
   ============================================================ */
import * as maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@6.16.0/dist/maplibre-gl.mjs';

(function () {
  'use strict';

  var NAV_GOOGLE = 'https://www.google.com/maps/dir/?api=1&destination=';
  var NAV_WAZE   = 'https://waze.com/ul?ll=';
  var NAV_APPLE  = 'https://maps.apple.com/?daddr=';

  var OSRM = 'https://router.project-osrm.org/route/v1/';
  // Az OSRM nyilvános demója csak autós profilt számol (a kerékpár/gyalog kérésre is
  // autós időt ad), ezért bringához és gyalogláshoz Valhallát használunk.
  var VALHALLA = 'https://valhalla1.openstreetmap.de/route';
  var MAP_STYLE = 'https://tiles.openfreemap.org/styles/dark';

  var EMPTY_FC = { type: 'FeatureCollection', features: [] };

  var el = {};
  var map = null, popup = null, meMarker = null;
  var selectedId = null;
  var handlersBound = false;
  var ready = { data: false, style: false };
  var pendingPlace = null;   // a stílus betöltéséig függőben lévő „tegyük le a jelölőt" lépés
  var nav = null;            // aktív turn-by-turn navigáció állapota
  var stepIdx = -1;          // kiválasztott útvonal-lépés előnézetben (-1 = nincs)
  var stepMarker = null;     // a manőver helyén lévő lépés-jelölő
  var is3D = false;          // döntött (billentett) 3D nézet aktív-e
  var animRaf = 0, animLast = 0, animT0 = 0;
  var REDUCED_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  var state = {
    points: [],
    byId: new Map(),
    filtered: [],
    geojson: EMPTY_FC,
    filter: 'all',
    sort: 'dist',
    query: '',
    me: null,
    sosList: [],
    sosIndex: 0,
    watchId: null,
    route: null,          // { point, mode, dist, dur, steps, geojson }
    fb: { score: 0, tags: [], note: '' }
  };

  /* ==================== apró segédek ==================== */

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function stripAcc(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var a = arguments, c = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(c, a); }, ms);
    };
  }

  function fmtDist(m) {
    if (m == null || isNaN(m)) return '';
    if (m < 1000) return Math.max(10, Math.round(m / 10) * 10) + ' m';
    return (m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',') + ' km';
  }

  function fmtDur(sec) {
    if (sec == null || isNaN(sec)) return '–';
    var m = Math.round(sec / 60);
    if (m < 60) return m + ' perc';
    if (m < 120) return '1 óra ' + (m - 60) + ' p';
    return Math.floor(m / 60) + ' óra ' + (m % 60) + ' p';
  }

  // érkezési idő: „14:35"
  function fmtEta(sec) {
    if (sec == null || isNaN(sec) || sec <= 0) return '–';
    var d = new Date(Date.now() + sec * 1000);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /* --- pontszám-jelvény (Budicheck-stílus): <7 piros, 7–8,9 narancs, 9+ lime --- */
  function scoreOf(id) {
    var d = id ? fbOf(id) : null;
    return d ? d.score : null;
  }
  function scoreClass(s) {
    if (s == null) return 'score-none';
    return s >= 9 ? 'score-hi' : (s >= 7 ? 'score-mid' : 'score-low');
  }
  function scoreBadge(s, cls) {
    return '<span class="score ' + scoreClass(s) + (cls ? ' ' + cls : '') + '">' +
      (s == null ? '★' : s) + '</span>';
  }

  /* --- geometria: pont távolsága egy vonalhoz, és vonal menti pozíció --- */

  // a legközelebbi szakasz megtalálása; visszatér: { idx, along, remain }
  function nearestOnPolyline(lat, lng, line) {
    var best = { idx: 0, d: Infinity, along: 0 };
    var acc = 0;
    for (var i = 1; i < line.length; i++) {
      var a = line[i - 1], b = line[i];
      var segLen = dist(a[1], a[0], b[1], b[0]) || 1e-6;
      // a pont vetülete a szakaszra (közelítő, síkkoordinátákkal)
      var ax = (a[0] - lng) * Math.cos(lat * Math.PI / 180), ay = a[1] - lat;
      var bx = (b[0] - lng) * Math.cos(lat * Math.PI / 180), by = b[1] - lat;
      var vx = bx - ax, vy = by - ay;
      var t = 0;
      var vv = vx * vx + vy * vy;
      if (vv > 0) t = Math.max(0, Math.min(1, -(ax * vx + ay * vy) / vv));
      var px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
      var d = dist(lat, lng, py, px);
      if (d < best.d) {
        best = { idx: i, d: d, along: acc + segLen * t };
      }
      acc += segLen;
    }
    return best;
  }

  // adott távolság (m) pontja a vonalon
  function pointAtDistance(navState, d) {
    var line = navState.line, cum = navState.cum;
    if (d <= 0) return line[0];
    for (var i = 1; i < cum.length; i++) {
      if (cum[i] >= d) {
        var segLen = cum[i] - cum[i - 1] || 1e-6;
        var t = (d - cum[i - 1]) / segLen;
        var a = line[i - 1], b = line[i];
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
    }
    return line[line.length - 1];
  }

  function dist(aLat, aLng, bLat, bLng) {
    var R = 6371000, rad = Math.PI / 180;
    var dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
    var la1 = aLat * rad, la2 = bLat * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function bearing(aLat, aLng, bLat, bLng) {
    var rad = Math.PI / 180, deg = 180 / Math.PI;
    var la1 = aLat * rad, la2 = bLat * rad, dLng = (bLng - aLng) * rad;
    var y = Math.sin(dLng) * Math.cos(la2);
    var x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
    return (Math.atan2(y, x) * deg + 360) % 360;
  }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.toast.hidden = true; }, 2800);
  }

  function isMobile() { return window.innerWidth <= 900; }

  function addrText(p) {
    var a = String(p.address || '');
    if (p.city && stripAcc(a).indexOf(stripAcc(p.city)) === -1) {
      a += (a ? ', ' : '') + p.city;
    }
    return a;
  }

  /* ==================== nyitvatartás ==================== */

  function parseRange(str) {
    if (!str) return null;
    var s = String(str).trim();
    if (/^z[áa]rva$/i.test(s)) return null;
    var m = s.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    var o = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    var c = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
    var txt = m[1] + ':' + m[2] + ' – ' + m[3] + ':' + m[4];
    if (o === 0 && c === 0) return { open: 0, close: 1440, text: '0:00 – 24:00' };
    if (c <= o) return { open: o, close: c + 1440, text: txt + ' (másnapig)' };
    return { open: o, close: c, text: txt };
  }

  var HOUR_CACHE = new Map();
  function hoursOf(p) {
    if (HOUR_CACHE.has(p.id)) return HOUR_CACHE.get(p.id);
    var res = null;
    if (p.hours) {
      res = { h: parseRange(p.hours.h), s: parseRange(p.hours.s), v: parseRange(p.hours.v) };
      if (!res.h && !res.s && !res.v) res = null;
    }
    HOUR_CACHE.set(p.id, res);
    return res;
  }

  function statusOf(p, now) {
    var hrs = hoursOf(p);
    if (!hrs) return 'unknown';
    now = now || new Date();
    var day = now.getDay();
    var mins = now.getHours() * 60 + now.getMinutes();
    var today = day === 0 ? hrs.v : (day === 6 ? hrs.s : hrs.h);
    if (today && mins >= today.open && mins < today.close) {
      return (today.close - mins <= 60) ? 'soon' : 'open';
    }
    return 'closed';
  }

  var OPEN_LABEL = { open: 'Nyitva', soon: 'Hamararát zár', closed: 'Zárva', unknown: 'Nincs adat' };

  var DAY_NAMES = { 0: 'vasárnap', 1: 'hétfő', 2: 'kedd', 3: 'szerda', 4: 'csütörtök', 5: 'péntek', 6: 'szombat' };

  function dayRange(hrs, day) {
    if (!hrs) return null;
    return day === 0 ? hrs.v : (day === 6 ? hrs.s : hrs.h);
  }

  function clockText(mins) {
    var h = Math.floor(mins / 60) % 24;
    var m = mins % 60;
    return h + ':' + (m < 10 ? '0' + m : m);
  }

  function leftText(mins) {
    mins = Math.max(0, Math.round(mins));
    if (mins < 60) return mins + ' perc';
    var h = Math.floor(mins / 60), m = mins % 60;
    return h + ' óra' + (m ? ' ' + m + ' perc' : '');
  }

  // Mikor nyit legközelebb? (ma még később, vagy a következő nyitott napon)
  function nextOpenText(hrs, day, mins) {
    if (!hrs) return '';
    var r = dayRange(hrs, day);
    if (r && r.close > r.open && mins < r.open) return 'ma ' + clockText(r.open) + '-kor nyit';
    for (var i = 1; i <= 7; i++) {
      var d = (day + i) % 7;
      var nr = dayRange(hrs, d);
      if (nr && nr.close > nr.open) {
        return (i === 1 ? 'holnap ' : DAY_NAMES[d] + ' ') + clockText(nr.open) + '-kor nyit';
      }
    }
    return '';
  }

  function pillClass(st) {
    return st === 'open' ? 'yes' : (st === 'soon' ? 'soon' : (st === 'closed' ? 'no' : 'unknown'));
  }
  function openPill(st) {
    return '<span class="open-pill ' + pillClass(st) + '">' + OPEN_LABEL[st] + '</span>';
  }
  function bigPill(st) {
    var suffix = (st === 'open' || st === 'closed') ? ' most' : '';
    return '<span class="pill ' + pillClass(st) + '">' + OPEN_LABEL[st] + suffix + '</span>';
  }

  /* ==================== visszajelzések (helyi) ==================== */

  var FB_KEY = 'vissza.feedback.v1';

  var FB_TAGS = [
    { id: 'gyors',    label: 'Gyors volt' },
    { id: 'sor',      label: 'Sorban álltam' },
    { id: 'elfogadta',label: 'Minden palackot elfogadott' },
    { id: 'utasit',   label: 'Nem fogadta el a palackot' },
    { id: 'kifogyott',label: 'Tele volt / kiürült' },
    { id: 'tiszta',   label: 'Tiszta, rendezett' },
    { id: 'koszos',   label: 'Piszkos, rendetlen' },
    { id: 'sérult',   label: 'Sérült / hibás' },
    { id: 'segit',    label: 'Segítőkész személyzet' }
  ];

  function loadFbStore() {
    try {
      var raw = localStorage.getItem(FB_KEY);
      var obj = raw ? JSON.parse(raw) : {};
      return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) { return {}; }
  }

  function saveFbStore(store) {
    try { localStorage.setItem(FB_KEY, JSON.stringify(store)); } catch (e) { }
  }

  function fbOf(id) { return loadFbStore()[id] || null; }

  function fbCount() { return Object.keys(loadFbStore()).length; }

  function fbSave(id, data) {
    var store = loadFbStore();
    store[id] = data;
    saveFbStore(store);
  }

  function fbRemove(id) {
    var store = loadFbStore();
    delete store[id];
    saveFbStore(store);
  }

  function initFeedbackUI() {
    el.fbScores.innerHTML = '';
    for (var i = 1; i <= 10; i++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'fb-score';
      b.dataset.score = i;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', i + ' pont');
      b.textContent = i;
      el.fbScores.appendChild(b);
    }
    el.fbTags.innerHTML = FB_TAGS.map(function (t) {
      return '<button class="fb-tag" type="button" data-tag="' + t.id + '">' + esc(t.label) + '</button>';
    }).join('');

    el.fbScores.addEventListener('click', function (e) {
      var b = e.target.closest('.fb-score');
      if (!b) return;
      state.fb.score = +b.dataset.score;
      paintFb();
    });
    el.fbScores.addEventListener('mouseover', function (e) {
      var b = e.target.closest('.fb-score');
      if (!b) return;
      Array.prototype.forEach.call(el.fbScores.children, function (c) {
        c.classList.toggle('is-hover', +c.dataset.score <= +b.dataset.score);
      });
    });
    el.fbScores.addEventListener('mouseleave', function () {
      Array.prototype.forEach.call(el.fbScores.children, function (c) { c.classList.remove('is-hover'); });
    });

    // gradient sávos csúszka (nagy skála)
    if (el.fbRange) {
      el.fbRange.addEventListener('input', function () {
        state.fb.score = +el.fbRange.value;
        paintFb();
      });
    }
    el.fbTags.addEventListener('click', function (e) {
      var b = e.target.closest('.fb-tag');
      if (!b) return;
      var id = b.dataset.tag;
      var i = state.fb.tags.indexOf(id);
      if (i === -1) state.fb.tags.push(id); else state.fb.tags.splice(i, 1);
      paintFb();
    });

    el.fbSend.addEventListener('click', function () {
      if (!selectedId) return;
      if (!state.fb.score) { toast('Adj pontszámot 1 és 10 között'); return; }
      fbSave(selectedId, {
        score: state.fb.score,
        tags: state.fb.tags.slice(),
        note: el.fbNote.value.trim().slice(0, 240),
        at: Date.now()
      });
      el.fbDone.hidden = false;
      el.fbDone.querySelector('span').textContent =
        'Köszönjük! ' + state.fb.score + '/10 — elmentve erre az eszközre.';
      el.fbDelete.hidden = false;
      applyFilters();
      refreshSheetRate();
      loadPointReviews(selectedId);
      toast('Visszajelzés elküldve ✓');
    });

    el.fbDelete.addEventListener('click', function () {
      if (!selectedId) return;
      fbRemove(selectedId);
      state.fb = { score: 0, tags: [], note: '' };
      el.fbNote.value = '';
      el.fbDone.hidden = true;
      el.fbDelete.hidden = true;
      paintFb();
      applyFilters();
      refreshSheetRate();
      toast('Visszajelzés törölve');
    });
  }

  var SCORE_VERDICT = {
    1: 'Katasztrofális', 2: 'Nagyon gyenge', 3: 'Gyenge', 4: 'Alig elfogadható',
    5: 'Átlagos', 6: 'Jó', 7: 'Megbízható', 8: 'Nagyon jó', 9: 'Kiváló', 10: 'Kifogástalan'
  };

  function paintFb() {
    Array.prototype.forEach.call(el.fbScores.children, function (c) {
      var on = +c.dataset.score === state.fb.score;
      c.classList.toggle('is-on', on);
      c.classList.toggle('is-top', on && state.fb.score === 10);
      c.setAttribute('aria-checked', on ? 'true' : 'false');
      // hover-kitöltés osztály
      c.classList.toggle('is-hover', !state.fb.score && +c.dataset.score <= (hoverScore || 0));
    });
    Array.prototype.forEach.call(el.fbTags.children, function (c) {
      c.classList.toggle('is-on', state.fb.tags.indexOf(c.dataset.tag) !== -1);
    });

    // nagy skála: szám + ítélet + gradient sáv
    var sc = state.fb.score || 0;
    if (el.fbBigNum) el.fbBigNum.textContent = sc || '–';
    if (el.fbVerdict) el.fbVerdict.textContent = sc ? (SCORE_VERDICT[sc] || '') : 'Adj pontszámot';
    if (el.fbRange) {
      if (sc) el.fbRange.value = sc;
      el.fbRange.setAttribute('aria-valuetext', sc ? sc + ' / 10 pont' : 'nincs kiválasztva');
    }
    if (el.fbScale) {
      el.fbScale.classList.toggle('is-empty', !sc);
      // a PC-s színes skála színét/kitöltését ezek a változók vezérlik
      el.fbScale.style.setProperty('--val', String(sc));
      el.fbScale.style.setProperty('--p', (sc * 10) + '%');
      el.fbScale.style.setProperty('--hue', (8 + sc * 7) + 'deg');
      if (sc && sc !== fbShownScore) {
        fbShownScore = sc;
        el.fbScale.classList.remove('is-bump');
        void el.fbScale.offsetWidth;
        el.fbScale.classList.add('is-bump');
      }
    }
  }

  var fbShownScore = 0;
  var hoverScore = 0;

  function loadFbIntoUI(id) {
    var d = fbOf(id);
    state.fb = d ? { score: d.score || 0, tags: (d.tags || []).slice(), note: d.note || '' }
                 : { score: 0, tags: [], note: '' };
    el.fbNote.value = state.fb.note;
    el.fbDone.hidden = true;
    el.fbDelete.hidden = !d;
    if (d) {
      el.fbDone.hidden = false;
      el.fbDone.querySelector('span').textContent =
        'Korábbi értékelésed: ' + d.score + '/10' + (d.at ? ' · ' + new Date(d.at).toLocaleDateString('hu-HU') : '');
    }
    paintFb();
  }

  function refreshSheetRate() {
    var d = selectedId ? fbOf(selectedId) : null;
    if (d) {
      el.sheetRate.hidden = false;
      el.sheetRate.textContent = '★ ' + d.score + '/10';
    } else {
      el.sheetRate.hidden = true;
    }
  }

  /* ==================== térkép ==================== */

  /* ==================== bejelentkezés (Supabase) ==================== */

  var sb = null;                                    // Supabase kliens
  var account = { user: null, profile: null };      // bejelentkezett fiók
  var authMode = 'login';                           // login | register | forgot | reset
  var authBusy = false;
  var overlayKind = null;

  var AUTH_COPY = {
    login:    { eyebrow: 'Fiók',         title: 'Jelentkezz be',      sub: 'Az értékeléseid így minden eszközödön meglesznek.',           submit: 'Bejelentkezés' },
    register: { eyebrow: 'Regisztráció', title: 'Új fiók',            sub: 'Egy e-mail-cím és egy jelszó — ennyi kell.',                  submit: 'Fiók létrehozása' },
    forgot:   { eyebrow: 'Jelszó',       title: 'Elfelejtett jelszó', sub: 'Add meg az e-mail-címed, és küldünk egy visszaállító linket.', submit: 'Visszaállító link küldése' },
    reset:    { eyebrow: 'Jelszó',       title: 'Új jelszó',          sub: 'Adj meg egy új jelszót a fiókodhoz.',                          submit: 'Jelszó mentése' }
  };

  function authRedirect() {
    return (location.protocol === 'http:' || location.protocol === 'https:')
      ? location.origin + location.pathname
      : undefined;
  }

  function authErr(e) {
    var m = String((e && (e.message || e.error_description || e.msg)) || 'Ismeretlen hiba történt.');
    var low = m.toLowerCase();
    if (low.indexOf('invalid login credentials') !== -1) return 'Hibás e-mail vagy jelszó.';
    if (low.indexOf('email not confirmed') !== -1) return 'Erősítsd meg az e-mail-címedet a kiküldött levélben, majd jelentkezz be.';
    if (low.indexOf('already registered') !== -1 || low.indexOf('already been registered') !== -1) return 'Ezzel az e-mail-címmel már létezik fiók — jelentkezz be.';
    if (low.indexOf('password should be') !== -1 || low.indexOf('password is too short') !== -1) return 'A jelszó legalább 6 karakter legyen.';
    if (low.indexOf('unable to validate email') !== -1 || low.indexOf('invalid email') !== -1) return 'Érvénytelen e-mail-cím.';
    if (low.indexOf('rate limit') !== -1 || low.indexOf('too many requests') !== -1) return 'Túl sok próbálkozás — várj egy percet, majd próbáld újra.';
    if (low.indexOf('could not find the function') !== -1 || low.indexOf('pgrst202') !== -1) return 'A fióktörlő függvény hiányzik az adatbázisból: futtasd a data/supabase-extra.sql-t a Supabase SQL Editorban, majd próbáld újra.';
    if (low.indexOf('permission denied') !== -1) return 'Nincs jogosultság a művelethez: futtasd újra a data/supabase-extra.sql-t (grant execute).';

    if (low.indexOf('row-level security') !== -1 || low.indexOf('row level security') !== -1 ||
        low.indexOf('25003') !== -1) {
      var tbl = ((m.match(/row-level security policy for table "?([\w.]+)"?/) || [])[1]) || '';
      return 'Jogosultsági hiba' + (tbl ? ' a(z) ' + tbl + ' táblánál' : ' a beszélgetésnél') +
        ': futtasd újra a data/supabase-friends.sql fájlt a Supabase SQL Editorban, majd próbáld küldeni az üzenetet.';
    }
    if (low.indexOf('friend') !== -1 || low.indexOf('conversation') !== -1 || low.indexOf('pokes') !== -1 ||
        low.indexOf('point_reviews') !== -1 || low.indexOf('user_names') !== -1) {
      return 'A közösségi funkciókhoz futtasd a data/supabase-friends.sql fájlt a Supabase SQL Editorban.';
    }
    if (low.indexOf('database error') !== -1 || low.indexOf('relation') !== -1) return 'Az adatbázis nincs előkészítve: futtasd a data/supabase-schema.sql, majd a data/supabase-extra.sql fájlt.';
    if (low.indexOf('failed to fetch') !== -1 || low.indexOf('networkerror') !== -1) return 'Nincs kapcsolat a szerverrel — ellenőrizd az internetet.';
    return m;
  }

  function displayName() {
    if (account.profile && account.profile.display_name) return account.profile.display_name;
    var meta = account.user && account.user.user_metadata;
    if (meta && meta.display_name) return meta.display_name;
    if (account.user && account.user.email) return account.user.email.split('@')[0];
    return 'Vendég';
  }

  function authMessage(text, kind) {
    if (!el.authMsg) return;
    if (!text) {
      el.authMsg.hidden = true;
      el.authMsg.className = 'auth-msg';
      el.authMsg.textContent = '';
      return;
    }
    el.authMsg.hidden = false;
    el.authMsg.className = 'auth-msg is-' + (kind || 'info');
    el.authMsg.textContent = text;
  }

  function authSetBusy(on, label) {
    authBusy = !!on;
    if (!el.authSubmit) return;
    el.authSubmit.disabled = !!on || !sb;
    el.authSubmit.textContent = on ? (label || 'Folyamatban…') : AUTH_COPY[authMode].submit;
  }

  function authSetMode(mode) {
    authMode = AUTH_COPY[mode] ? mode : 'login';
    if (!el.authView) return;
    authMessage('');

    var copy = AUTH_COPY[authMode];
    el.authEyebrow.textContent = copy.eyebrow;
    el.authTitle.textContent = copy.title;
    el.authSub.textContent = copy.sub;
    el.authSubmit.textContent = copy.submit;
    el.authSubmit.disabled = !sb;

    el.authTabs.hidden = (authMode === 'forgot' || authMode === 'reset');
    el.authTabLogin.classList.toggle('is-active', authMode === 'login');
    el.authTabRegister.classList.toggle('is-active', authMode === 'register');
    el.authTabLogin.setAttribute('aria-selected', authMode === 'login' ? 'true' : 'false');
    el.authTabRegister.setAttribute('aria-selected', authMode === 'register' ? 'true' : 'false');

    el.authNameField.hidden = authMode !== 'register';
    el.authEmailField.hidden = authMode === 'reset';
    el.authPasswordField.hidden = authMode === 'forgot';
    el.authPassword2Field.hidden = (authMode !== 'register' && authMode !== 'reset');

    el.authPassword.setAttribute('autocomplete', authMode === 'login' ? 'current-password' : 'new-password');
    el.authPassword.placeholder = authMode === 'reset' ? 'Új jelszó' : 'Legalább 6 karakter';
    el.authForgot.hidden = authMode !== 'login';
    el.authBack.hidden = (authMode !== 'forgot' && authMode !== 'reset');

    if (!sb) authMessage('A bejelentkezés most nem érhető el: hiányzik a Supabase SDK vagy a js/config.js beállítása.', 'error');
  }

  function authOpen(mode) {
    if (!el.authView) return;
    el.authView.hidden = false;
    document.body.classList.add('is-auth');
    authSetMode(mode || 'login');
    setTimeout(function () {
      var f = (authMode === 'login' || authMode === 'forgot') ? el.authEmail : el.authPassword;
      try { if (f) f.focus(); } catch (e) { }
    }, 80);
  }

  function authClose() {
    if (!el.authView) return;
    el.authView.hidden = true;
    document.body.classList.remove('is-auth');
    authMessage('');
    authSetBusy(false);
  }

  /* ==================== első látogató: bemutató ==================== */

  var INTRO_KEY = 'vissza:intro-seen';
  var introIndex = 0;

  function introSeen() { return readJSON(INTRO_KEY, false) === true; }

  function introSlide(i) {
    if (!el.introSlides) return;
    var slides = el.introSlides.children;
    if (!slides.length) return;
    introIndex = Math.max(0, Math.min(i, slides.length - 1));
    Array.prototype.forEach.call(slides, function (s, k) {
      s.classList.toggle('is-active', k === introIndex);
    });
    if (el.introDots) {
      Array.prototype.forEach.call(el.introDots.children, function (d, k) {
        d.classList.toggle('is-active', k === introIndex);
        d.setAttribute('aria-selected', k === introIndex ? 'true' : 'false');
      });
    }
    if (el.introNext) el.introNext.hidden = introIndex >= slides.length - 1;
  }

  function introShow() {
    if (!el.introView) return;
    introSlide(0);
    el.introView.hidden = false;
    document.body.classList.add('is-intro');
    setTimeout(function () {
      try { if (el.introRegister) el.introRegister.focus(); } catch (e) { }
    }, 90);
  }

  function introHide() {
    if (!el.introView || el.introView.hidden) return;
    el.introView.hidden = true;
    document.body.classList.remove('is-intro');
    writeJSON(INTRO_KEY, true);
  }

  function introStart(mode) {
    introHide();
    authOpen(mode);
  }

  // Csak első látogatáskor, bejelentkezés és konkrét link nélkül.
  function maybeIntro() {
    if (!el.introView || account.user || introSeen()) return;
    if (location.hash) return;
    introShow();
  }

  function authRun(promise, label) {
    authSetBusy(true, label);
    return Promise.resolve(promise).then(
      function (r) { authSetBusy(false); return r; },
      function (e) { authSetBusy(false); throw e; }
    );
  }

  function initAuth() {
    var cfg = window.VISSZA_CONFIG || {};
    if (!window.supabase || !window.supabase.createClient) {
      console.warn('[fiók] A Supabase SDK nem töltődött be (CDN).');
      return;
    }
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_KEY) {
      console.warn('[fiók] Hiányzik a SUPABASE_URL / SUPABASE_KEY a js/config.js-ből.');
      return;
    }
    try {
      sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
    } catch (e) {
      console.warn('[fiók] A Supabase kliens nem indult el:', e && e.message);
      sb = null;
      return;
    }

    sb.auth.onAuthStateChange(function (event, session) {
      if (event === 'PASSWORD_RECOVERY') {
        account.user = session && session.user ? session.user : null;
        authOpen('reset');
        return;
      }
      // a visszahívásban ne blokkoljunk: a Supabase auth-zárát elkerüljük
      setTimeout(function () { applySession(session); }, 0);
    });

    sb.auth.getSession().then(function (res) {
      applySession(res && res.data ? res.data.session : null);
    }).catch(function () { });

    authSetMode('login');
  }

  function applySession(session) {
    account.user = session && session.user ? session.user : null;
    if (!account.user) account.profile = null;
    paintAccount();
    if (account.user) introHide();
    if (account.user) {
      syncAvatarMeta();
      loadProfile();
      if (social.accountUser !== account.user.id) {
        social.accountUser = account.user.id;
        loadAccountSocial();
      }
      startSocialTick();
      refreshFriendData();
      pollPokes();
    } else {
      social.accountUser = null;
      stopSocialTick();
    }
  }

  function loadProfile() {
    if (!sb || !account.user) return Promise.resolve();
    return sb.from('profiles').select('display_name').eq('id', account.user.id).maybeSingle()
      .then(function (res) {
        if (!res.error && res.data) { account.profile = res.data; paintAccount(); }
      })
      .catch(function () { });
  }

  function paintAccount() {
    if (el.dockProfile) {
      el.dockProfile.classList.toggle('is-logged-in', !!account.user);
      el.dockProfile.title = account.user ? ('Profilom — ' + displayName()) : 'Profilom / bejelentkezés';
    }
    if (overlayKind === 'profile' && el.overlay && !el.overlay.hidden) openOverlay('profile');
  }

  /* --- avatar (emoji + szín) --- */

  var AV_KEY = 'vissza.avatar.v1';

  var AV_EMOJI = [
    '🦉', '🐱', '🐶', '🦊', '🐻', '🐼', '🐸', '🦁', '🐨', '🐰',
    '🍾', '🍺', '🥤', '🍉', '🍎', '🥕', '🌽', '🍞', '🧀', '🍿',
    '🌿', '🌸', '⭐', '🔥', '💡', '🚲', '🚗', '🛒', '♻️', '🐢'
  ];

  var AV_COLORS = [
    { name: 'Lime',      bg: 'linear-gradient(135deg, #F0F66B, var(--lime))', fg: '#0A0B03' },
    { name: 'Narancs',   bg: 'linear-gradient(135deg, #FFB088, #FF7A45)',     fg: '#2A0F04' },
    { name: 'Égkék',     bg: 'linear-gradient(135deg, #8FD3FF, #3FA2FF)',     fg: '#04182B' },
    { name: 'Rózsaszín', bg: 'linear-gradient(135deg, #FFB3D9, #FF6FB5)',     fg: '#2B0716' },
    { name: 'Lila',      bg: 'linear-gradient(135deg, #C9B0FF, #8A5CFF)',     fg: '#150A2B' },
    { name: 'Menta',     bg: 'linear-gradient(135deg, #9BF5D2, #2ED3A0)',     fg: '#04271C' },
    { name: 'Citrom',    bg: 'linear-gradient(135deg, #FFF08A, #FFD23F)',     fg: '#2B2204' },
    { name: 'Szürke',    bg: 'linear-gradient(135deg, #E7EAF0, #9AA3B2)',     fg: '#14161C' }
  ];

  // a fiók avatarja a user_metadata-ban él, vendégként a localStorage-ban
  function avatarOf() {
    var meta = account.user && account.user.user_metadata;
    if (meta && meta.avatar && typeof meta.avatar === 'object') return meta.avatar;
    return readJSON(AV_KEY, null);
  }

  function avatarSpan(av, extraCls) {
    var cls = 'account-avatar' + (extraCls ? ' ' + extraCls : '');
    if (av && av.e) {
      var c = AV_COLORS[av.c] || AV_COLORS[0];
      return '<span class="' + cls + ' av-emoji" aria-hidden="true"' +
        ' style="background:' + c.bg + ';color:' + c.fg + '">' + av.e + '</span>';
    }
    var name = account.user ? displayName() : '';
    return '<span class="' + cls + '" aria-hidden="true">' +
      esc(String(name).trim().charAt(0).toUpperCase() || '?') + '</span>';
  }

  function avatarHtml() { return avatarSpan(avatarOf()); }

  function setAvatar(av) {
    av = { e: (av && av.e) || '', c: (av && av.c) || 0 };
    writeJSON(AV_KEY, av);
    if (sb && account.user) {
      return sb.auth.updateUser({ data: { avatar: av } })
        .then(function (res) {
          if (res.error) throw res.error;
          if (res.data && res.data.user) account.user = res.data.user;
        })
        .catch(function (e) { toast('Nem sikerült menteni: ' + authErr(e)); });
    }
    return Promise.resolve();
  }

  // bejelentkezéskor a fiók avatarja lesz az érvényes; ha még nincs a fiókban,
  // de az eszközön már választottál, feltöltjük
  function syncAvatarMeta() {
    if (!sb || !account.user) return;
    var meta = account.user.user_metadata;
    if (meta && meta.avatar && typeof meta.avatar === 'object') {
      writeJSON(AV_KEY, { e: meta.avatar.e || '', c: meta.avatar.c || 0 });
      return;
    }
    var av = readJSON(AV_KEY, null);
    if (av && av.e) {
      sb.auth.updateUser({ data: { avatar: av } })
        .then(function (res) {
          if (!res.error && res.data && res.data.user) account.user = res.data.user;
        })
        .catch(function () { });
    }
  }

  function accountHeadHtml() {
    if (!account.user) {
      return '<div class="account-head">' +
        avatarHtml() +
        '<div class="account-main"><b>Vendégként nézelődsz</b>' +
        '<small>Jelentkezz be, hogy az értékeléseid megmaradjanak.</small></div>' +
        '<span class="p-head-acts">' +
          '<button class="p-edit" type="button" data-account="avatar"' +
            ' title="Avatar választása" aria-label="Avatar választása">😊</button>' +
        '</span>' +
        '</div>';
    }
    var name = displayName();
    return '<div class="account-head">' +
      avatarHtml() +
      '<div class="account-main"><b>' + esc(name) + '</b>' +
      '<small>' + esc(account.user.email || '') + '</small></div>' +
      '<span class="p-head-acts">' +
        '<button class="p-edit" type="button" data-account="avatar"' +
          ' title="Avatar választása" aria-label="Avatar választása">😊</button>' +
        '<button class="p-edit" type="button" data-account="name"' +
          ' title="Név szerkesztése" aria-label="Megjelenített név szerkesztése">✎</button>' +
      '</span>' +
      '</div>';
  }

  function accountActionsHtml() {
    if (!sb) {
      return '<div class="account-note">A fiók most nem elérhető — hiányzik a Supabase SDK vagy a js/config.js beállítása.</div>';
    }
    if (!account.user) {
      return '<div class="account-actions">' +
        '<button class="btn btn-primary" type="button" data-account="login">Bejelentkezés</button>' +
        '<button class="btn btn-ghost" type="button" data-account="register">Regisztráció</button>' +
        '<button class="btn btn-ghost" type="button" data-account="intro">Bemutató</button>' +
        '</div>';
    }
    return '<div class="account-actions">' +
        '<button class="btn" type="button" data-account="password">Jelszó módosítása</button>' +
        '<button class="btn btn-ghost" type="button" data-account="intro">Bemutató újra</button>' +
        '<button class="btn btn-ghost" type="button" data-account="logout">Kijelentkezés</button>' +
      '</div>' +
      '<div class="account-actions">' +
        '<button class="btn account-danger" type="button" data-account="delete">Fiók törlése</button>' +
      '</div>';
  }

  function authSubmit() {
    if (authBusy) return;
    if (!sb) { authMessage('A bejelentkezés most nem érhető el (Supabase beállítás hiányzik).', 'error'); return; }

    var email = el.authEmail.value.trim();
    var pass = el.authPassword.value;
    var pass2 = el.authPassword2.value;

    if (authMode === 'reset') {
      if (pass.length < 6) { authMessage('A jelszó legalább 6 karakter legyen.', 'error'); return; }
      if (pass !== pass2) { authMessage('A két jelszó nem egyezik.', 'error'); return; }
      authRun(sb.auth.updateUser({ password: pass }), 'Mentés…')
        .then(function (res) {
          if (res.error) throw res.error;
          el.authPassword.value = '';
          el.authPassword2.value = '';
          authMessage('A jelszó frissítve. Most már ezzel tudsz belépni.', 'ok');
          setTimeout(authClose, 1500);
        })
        .catch(function (e) { authMessage(authErr(e), 'error'); });
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      authMessage('Adj meg egy érvényes e-mail-címet.', 'error');
      return;
    }

    if (authMode === 'forgot') {
      authRun(sb.auth.resetPasswordForEmail(email, { redirectTo: authRedirect() }), 'Küldés…')
        .then(function (res) {
          if (res.error) throw res.error;
          authMessage('Elküldtük a visszaállító linket a(z) ' + email + ' címre. Nézd meg a postafiókod (a spam mappát is).', 'ok');
        })
        .catch(function (e) { authMessage(authErr(e), 'error'); });
      return;
    }

    if (authMode === 'register') {
      if (pass.length < 6) { authMessage('A jelszó legalább 6 karakter legyen.', 'error'); return; }
      if (pass !== pass2) { authMessage('A két jelszó nem egyezik.', 'error'); return; }
      var name = el.authName.value.trim().slice(0, 40);

      authRun(sb.auth.signUp({
        email: email,
        password: pass,
        options: { data: { display_name: name || null }, emailRedirectTo: authRedirect() }
      }), 'Fiók létrehozása…')
        .then(function (res) {
          if (res.error) throw res.error;
          var u = res.data && res.data.user;
          if (u && Array.isArray(u.identities) && u.identities.length === 0) {
            authSetMode('login');
            authMessage('Ezzel az e-mail-címmel már létezik fiók — jelentkezz be.', 'error');
            return;
          }
          el.authPassword.value = '';
          el.authPassword2.value = '';
          if (res.data && res.data.session) {
            authMessage('A fiók elkészült — üdvözlünk!', 'ok');
            setTimeout(authClose, 900);
          } else {
            authSetMode('login');
            authMessage('Elküldtük a megerősítő levelet a(z) ' + email + ' címre. Kattints a linkre, utána jelentkezz be.', 'ok');
          }
        })
        .catch(function (e) { authMessage(authErr(e), 'error'); });
      return;
    }

    if (!pass) { authMessage('Add meg a jelszavad.', 'error'); return; }
    authRun(sb.auth.signInWithPassword({ email: email, password: pass }), 'Belépés…')
      .then(function (res) {
        if (res.error) throw res.error;
        el.authPassword.value = '';
        authMessage('Sikeres bejelentkezés.', 'ok');
        setTimeout(authClose, 700);
      })
      .catch(function (e) { authMessage(authErr(e), 'error'); });
  }

  function authSignOut() {
    var done = function () {
      account = { user: null, profile: null };
      paintAccount();
      toast('Kijelentkeztél');
    };
    if (!sb) { done(); return; }
    sb.auth.signOut().then(done, done);
  }

  function accountStatus(text, kind) {
    if (!el.overlayBody) return;
    var box = el.overlayBody.querySelector('.account-status');
    if (!text) { if (box) box.remove(); return; }
    if (!box) {
      box = document.createElement('div');
      el.overlayBody.appendChild(box);
    }
    box.className = 'auth-msg is-' + (kind || 'info') + ' account-status';
    box.textContent = text;
  }

  function authDeleteAccount() {
    if (!sb || !account.user) return;
    if (!window.confirm('Biztosan törlöd a fiókodat? Az értékeléseid is törlődnek, és ezt nem lehet visszavonni.')) return;
    accountStatus('Törlés folyamatban…', 'info');

    sb.rpc('delete_my_account').then(function (res) {
      if (res.error) throw res.error;
      return sb.auth.signOut({ scope: 'local' }).catch(function () { });
    }).then(function () {
      account = { user: null, profile: null };
      paintAccount();
      if (overlayKind === 'profile') closeOverlay();
      toast('A fiókodat töröltük.');
    }).catch(function (e) {
      toast('A törlés nem sikerült: ' + authErr(e));
      accountStatus('A törlés nem sikerült: ' + authErr(e), 'error');
    });
  }

  /* ==================== közösségi állapot (jelentés, értékelés, kedvenc) ==================== */

  var FAV_KEY = 'vissza.favorites.v1';
  var VISIT_KEY = 'vissza.visits.v1';
  var REPORT_KEY = 'vissza.reports.v1';      // helyi jelzésnapló (a "Segítő" jelvényhez)
  var REPORT_TTL = 1 * 60 * 60 * 1000;      // a jelzés ennyi ideig érvényes

  var REPORTS = {
    tele:  { label: 'Tele van',    past: 'tele van',    cls: 'is-tele' },
    urult: { label: 'Kiürült',     past: 'kiürült',     cls: 'is-urult' },
    hibas: { label: 'Nem fogadja', past: 'nem fogadja', cls: 'is-hibas' }
  };

  var social = {
    reports: {},      // id -> { status, at, count }
    remote: {},       // id -> { avg, votes }  (közösségi átlag)
    favs: {},         // id -> true
    visits: [],       // [{ id, at }] legutóbbi elöl
    accountUser: null
  };

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function writeJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { }
  }

  function initSocial() {
    var favs = readJSON(FAV_KEY, []);
    if (Array.isArray(favs)) favs.forEach(function (id) { social.favs[id] = true; });
    var vis = readJSON(VISIT_KEY, []);
    if (Array.isArray(vis)) {
      social.visits = vis.filter(function (v) { return v && v.id != null; })
        .sort(function (a, b) { return (b.at || 0) - (a.at || 0); }).slice(0, 8);
    }
    renderRecent();
  }

  /* --- kedvencek --- */

  function isFav(id) { return !!social.favs[id]; }

  function toggleFav(id) {
    if (isFav(id)) delete social.favs[id]; else social.favs[id] = true;
    writeJSON(FAV_KEY, Object.keys(social.favs).map(Number));

    if (sb && account.user) {
      if (isFav(id)) {
        sb.from('favorites').insert({ user_id: account.user.id, point_id: id })
          .then(function (r) { if (r.error && r.error.code !== '23505') console.warn('[kedvenc]', r.error.message); });
      } else {
        sb.from('favorites').delete().eq('user_id', account.user.id).eq('point_id', id)
          .then(function (r) { if (r.error) console.warn('[kedvenc]', r.error.message); });
      }
    }

    applyFilters();
    if (selectedId === id) refreshSheetFav();
    toast(isFav(id) ? 'Kedvencekhez adva ★' : 'Eltávolítva a kedvencek közül');
  }

  function paintFavBtn(btn, on) {
    if (!btn) return;
    btn.classList.toggle('is-fav', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('aria-label', on ? 'Eltávolítás a kedvencekből' : 'Hozzáadás a kedvencekhez');
    btn.title = on ? 'Eltávolítás a kedvencekből' : 'Kedvencekhez';
  }

  function refreshSheetFav() {
    var on = selectedId != null && isFav(selectedId);
    paintFavBtn(el.sheetFav, on);
    paintFavBtn(el.sheetFavPc, on);
  }

  /* --- üzemállapot --- */

  function reportOf(id) { return social.reports[id] || null; }

  function agoText(ts) {
    var m = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (m < 1) return 'most';
    if (m < 60) return m + ' perce';
    return Math.round(m / 60) + ' órája';
  }

  function reportChipHtml(id) {
    var r = reportOf(id), meta = r && REPORTS[r.status];
    if (!meta) return '';
    return '<span class="report-chip ' + meta.cls + '">' + agoText(r.at) + ' ' + meta.past +
      (r.count > 1 ? ' · ' + r.count + ' jelzés' : '') + '</span>';
  }

  function communityOf(id) { return social.remote[id] || null; }

  function communityBadgeHtml(id) {
    var c = communityOf(id);
    if (!c || !c.votes) return '';
    return '<span class="score score-comm score-xs" title="Közösségi átlag">★ ' +
      String(c.avg).replace('.', ',') + '</span>';
  }

  function refreshSheetSocial() {
    if (!el.reportStatus) return;
    var r = selectedId != null ? reportOf(selectedId) : null;
    var meta = r && REPORTS[r.status];
    if (meta) {
      el.reportStatus.textContent = agoText(r.at) + ' ' + meta.past +
        (r.count > 1 ? ' · ' + r.count + ' jelzés' : '');
      el.reportStatus.className = 'reports-status ' + meta.cls;
    } else {
      el.reportStatus.textContent = 'Nincs friss jelzés';
      el.reportStatus.className = 'reports-status';
    }
    if (el.reportBtns) {
      Array.prototype.forEach.call(el.reportBtns.children, function (b) {
        b.classList.toggle('is-on', !!meta && b.dataset.report === r.status);
      });
    }
    if (el.reportFig) el.reportFig.dataset.state = meta ? r.status : 'none';
    if (el.reportFigHint) {
      el.reportFigHint.textContent = meta ? (meta.label + ' · ' + agoText(r.at)) : 'Koppints a jelzéshez';
    }
    var c = selectedId != null ? communityOf(selectedId) : null;
    if (el.sheetCommunity) {
      if (c && c.votes) {
        el.sheetCommunity.hidden = false;
        el.sheetCommunity.textContent = '★ ' + String(c.avg).replace('.', ',') + ' · ' + c.votes + ' értékelés';
      } else {
        el.sheetCommunity.hidden = true;
      }
    }
  }

  function sendReport(id, status) {
    if (!REPORTS[status]) return;
    if (!sb) { toast('A jelentéshez internetkapcsolat kell'); return; }
    if (!account.user) {
      authOpen('login');
      authMessage('A jelentéshez jelentkezz be — így nem lesz belőle spam.', 'info');
      return;
    }
    sb.from('point_reports').delete().eq('user_id', account.user.id).eq('point_id', id)
      .then(function (res) {
        if (res.error) throw res.error;
        return sb.from('point_reports').insert({ point_id: id, user_id: account.user.id, status: status });
      })
      .then(function (res) {
        if (res.error) throw res.error;
        // helyi jelzésnapló: a szerver csak a friss (3 óránál fiatalabb) sorokat engedi olvasni,
        // ezért a "Segítő" jelvényt ebből a naplóból számoljuk
        var log = readJSON(REPORT_KEY, []);
        if (!Array.isArray(log)) log = [];
        log.push(Date.now());
        writeJSON(REPORT_KEY, log.slice(-500));
        toast('Köszönjük! A jelzés 1 óráig látszik.');
        return refreshSocial();
      })
      .catch(function (e) { toast('A jelentés nem sikerült: ' + authErr(e)); });
  }

  /* --- közösségi adatok betöltése --- */

  function fetchAllRows(table, columns, cap) {
    var out = [], page = 0, size = 1000, max = cap || 5000;
    function next() {
      if (page * size >= max) return Promise.resolve(out);
      return sb.from(table).select(columns).range(page * size, page * size + size - 1)
        .then(function (res) {
          if (res.error) throw res.error;
          var rows = res.data || [];
          out = out.concat(rows);
          page++;
          return rows.length < size ? out : next();
        });
    }
    return next();
  }

  function refreshSocial() {
    if (!sb) { renderRecent(); return Promise.resolve(); }

    var since = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    var reportsP = sb.from('point_reports')
      .select('point_id,status,created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1000)
      .then(function (res) {
        if (res.error) return;
        social.reports = {};
        (res.data || []).forEach(function (r) {
          var at = Date.parse(r.created_at);
          if (!isFinite(at) || Date.now() - at > REPORT_TTL) return;
          var cur = social.reports[r.point_id];
          if (!cur) social.reports[r.point_id] = { status: r.status, at: at, count: 1 };
          else cur.count++;
        });
      })
      .catch(function () { });

    var ratingsP = fetchAllRows('point_ratings', 'point_id,avg_score,votes')
      .then(function (rows) {
        social.remote = {};
        rows.forEach(function (r) {
          var avg = parseFloat(r.avg_score);
          if (isFinite(avg)) social.remote[r.point_id] = { avg: avg, votes: r.votes || 0 };
        });
      })
      .catch(function () { });

    return Promise.all([reportsP, ratingsP]).then(function () {
      applyFilters();
      if (selectedId != null) refreshSheetSocial();
    });
  }

  /* --- értékelések szinkronja a fiókkal --- */

  function pushLocalRating(id, d) {
    if (!sb || !account.user) return Promise.resolve();
    var row = {
      score: d.score,
      tags: d.tags || [],
      note: d.note || '',
      updated_at: new Date(d.at || Date.now()).toISOString()
    };
    return sb.from('ratings').update(row)
      .eq('user_id', account.user.id).eq('point_id', +id).select('point_id')
      .then(function (res) {
        if (res.error) throw res.error;
        if (res.data && res.data.length) return null;
        return sb.from('ratings').insert({
          user_id: account.user.id, point_id: +id,
          score: row.score, tags: row.tags, note: row.note, updated_at: row.updated_at
        }).then(function (r2) { if (r2.error) throw r2.error; });
      });
  }

  function pullRatings() {
    if (!sb || !account.user) return Promise.resolve();
    return sb.from('ratings').select('point_id,score,tags,note,updated_at')
      .eq('user_id', account.user.id)
      .then(function (res) {
        if (res.error || !res.data) return;
        var store = loadFbStore(), changed = false;
        res.data.forEach(function (r) {
          var at = r.updated_at ? Date.parse(r.updated_at) : 0;
          var cur = store[r.point_id];
          if (!cur || (at && at > (cur.at || 0))) {
            store[r.point_id] = { score: r.score, tags: r.tags || [], note: r.note || '', at: at || Date.now() };
            changed = true;
          }
        });
        if (changed) {
          saveFbStore(store);
          applyFilters();
          if (selectedId != null) loadFbIntoUI(selectedId);
        }
      })
      .catch(function () { });
  }

  function loadAccountSocial() {
    if (!sb || !account.user) return;
    var uid = account.user.id;

    // kedvencek: szerver + helyi összefésülése
    sb.from('favorites').select('point_id').eq('user_id', uid)
      .then(function (res) {
        if (res.error || !res.data) return;
        var remoteFavs = {};
        res.data.forEach(function (r) { remoteFavs[r.point_id] = true; });
        var merged = {};
        Object.keys(remoteFavs).forEach(function (id) { merged[id] = true; });
        Object.keys(social.favs).forEach(function (id) { merged[id] = true; });
        social.favs = merged;
        writeJSON(FAV_KEY, Object.keys(merged).map(Number));
        Object.keys(merged).forEach(function (id) {
          if (remoteFavs[id]) return;
          sb.from('favorites').insert({ user_id: uid, point_id: +id })
            .then(function (r) { if (r.error && r.error.code !== '23505') console.warn('[kedvenc]', r.error.message); });
        });
        applyFilters();
      })
      .catch(function () { });

    // látogatások
    sb.from('visits').select('point_id,visited_at').eq('user_id', uid)
      .order('visited_at', { ascending: false }).limit(8)
      .then(function (res) {
        if (res.error || !res.data) return;
        var remoteAt = {};
        res.data.forEach(function (r) { remoteAt[r.point_id] = Date.parse(r.visited_at) || Date.now(); });
        var mergedAt = {};
        Object.keys(remoteAt).forEach(function (id) { mergedAt[id] = remoteAt[id]; });
        social.visits.forEach(function (v) {
          if (!mergedAt[v.id] || v.at > mergedAt[v.id]) mergedAt[v.id] = v.at;
        });
        social.visits = Object.keys(mergedAt).map(function (id) { return { id: Number(id), at: mergedAt[id] }; })
          .sort(function (a, b) { return b.at - a.at; }).slice(0, 8);
        writeJSON(VISIT_KEY, social.visits);
        renderRecent();
        social.visits.forEach(function (v) {
          if (remoteAt[v.id]) return;
          sb.from('visits').upsert(
            { user_id: uid, point_id: v.id, visited_at: new Date(v.at).toISOString() },
            { onConflict: 'user_id,point_id' }
          ).then(function (r) { if (r.error) console.warn('[látogatás]', r.error.message); });
        });
      })
      .catch(function () { });

    // értékelések: helyi feltöltés, majd szerveroldali egyesítés
    var store = loadFbStore();
    var chain = Promise.resolve();
    Object.keys(store).forEach(function (id) {
      chain = chain.then(function () { return pushLocalRating(id, store[id]); }).catch(function () { });
    });
    chain.then(pullRatings);
  }

  /* --- legutóbbi látogatás --- */

  function recordVisit(id) {
    if (id == null) return;
    var now = Date.now();
    social.visits = [{ id: id, at: now }]
      .concat(social.visits.filter(function (v) { return v.id !== id; })).slice(0, 8);
    writeJSON(VISIT_KEY, social.visits);
    renderRecent();
    if (sb && account.user) {
      sb.from('visits').upsert(
        { user_id: account.user.id, point_id: id, visited_at: new Date(now).toISOString() },
        { onConflict: 'user_id,point_id' }
      ).then(function (r) { if (r.error) console.warn('[látogatás]', r.error.message); });
    }
  }

  function renderRecent() {
    if (!el.recentCard) return;
    var v = null;
    for (var i = 0; i < social.visits.length && !v; i++) {
      if (state.byId.has(social.visits[i].id)) v = social.visits[i];
    }
    if (!v) { el.recentCard.hidden = true; return; }

    var p = state.byId.get(v.id);
    var d = p._d != null ? p._d : (state.me ? dist(state.me.lat, state.me.lng, p.lat, p.lng) : null);
    var bits = [agoText(v.at)];
    if (d != null) bits.push(fmtDist(d) + ' tőled');
    bits.push(p.type === 'automata' ? 'automata' : 'kézi pont');

    el.recentName.textContent = p.name;
    el.recentMeta.textContent = bits.join(' · ');
    el.recentCard.hidden = false;
    el.recentGo.onclick = function () { startRoute(p, null); };
  }

  /* ==================== profil: naplód, sorozat, jelvények ==================== */

  var ZIP_COUNTY = null;                    // irányítószám -> megye (data/zip-megye.json)
  var zipTried = false;
  var profExtra = { forUser: null, visits: null };   // fiók teljes látogatáslistája

  function loadZipCounty() {
    if (ZIP_COUNTY || zipTried) return Promise.resolve(ZIP_COUNTY);
    zipTried = true;
    return fetch('data/zip-megye.json', { cache: 'force-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && typeof j === 'object') ZIP_COUNTY = j; return ZIP_COUNTY; })
      .catch(function () { return null; });
  }

  // a MOHU adat nem tartalmaz megyét, azt az irányítószámból vezetjük le
  function countyOf(p) {
    return (ZIP_COUNTY && p && p.zip) ? (ZIP_COUNTY[String(p.zip)] || null) : null;
  }

  function reportLog() {
    var list = readJSON(REPORT_KEY, []);
    return Array.isArray(list) ? list : [];
  }

  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  // hány napja folyamatosan van aktivitás (a mai vagy a tegnapi nappal bezárólag)
  function streakDays(keys) {
    var set = {};
    keys.forEach(function (k) { set[k] = true; });
    var d = new Date();
    if (!set[dayKey(d.getTime())]) d.setDate(d.getDate() - 1);
    var n = 0;
    while (set[dayKey(d.getTime())]) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  function fmtWhen(ts) {
    var d = new Date(ts);
    return d.toLocaleDateString('hu-HU') + ' ' +
      d.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' });
  }

  function tagLabel(t) {
    return (FB_TAGS.filter(function (x) { return x.id === t; })[0] || {}).label || t;
  }

  // a megjelenített látogatások (fióknál a szerverről is bővülhet a lista)
  function profVisits() {
    return (profExtra.visits || social.visits).slice(0, 8);
  }

  // látogatás + értékelés dátumai napkulcsokra bontva (a sorozathoz)
  function activityKeys() {
    var keys = {}, add = function (ts) { if (ts) keys[dayKey(ts)] = true; };
    (profExtra.visits || social.visits).forEach(function (v) { add(v.at); });
    var store = loadFbStore();
    Object.keys(store).forEach(function (id) { add(store[id].at); });
    return Object.keys(keys);
  }

  function badgeStates() {
    var store = loadFbStore();
    var rateIds = Object.keys(store);
    var visits = profExtra.visits || social.visits;

    var ratedN = rateIds.length;
    var reportN = reportLog().length;

    // megyék: a látogatott + értékelt pontok irányítószámai alapján
    var pts = {};
    visits.forEach(function (v) { pts[v.id] = true; });
    rateIds.forEach(function (id) { pts[id] = true; });
    var counties = {};
    Object.keys(pts).forEach(function (id) {
      var c = countyOf(state.byId.get(+id));
      if (c) counties[c] = true;
    });
    var countyN = Object.keys(counties).length;

    // éjszakai bagoly: éjfél és reggel 5 óra között mentett értékelés
    var night = rateIds.some(function (id) {
      var at = store[id] && store[id].at;
      if (!at) return false;
      var h = new Date(at).getHours();
      return h >= 0 && h < 5;
    });

    return [
      { ico: '🍾', name: 'Első visszaváltás', unit: 'visszaváltás',
        desc: 'Az első látogatásod rögzítve', got: visits.length > 0, cur: visits.length ? 1 : 0, need: 1 },
      { ico: '⭐', name: '10 értékelt pont', unit: 'értékelt pont',
        desc: 'Tíz REpontot értékeltél', got: ratedN >= 10, cur: Math.min(ratedN, 10), need: 10 },
      { ico: '🗺️', name: '5 megye', unit: 'megye',
        desc: 'Öt különböző megyében váltottál', got: countyN >= 5, cur: Math.min(countyN, 5), need: 5 },
      { ico: '🦉', name: 'Éjszakai bagoly', unit: 'jelvény',
        desc: 'Éjfél után értékeltél', got: night, cur: night ? 1 : 0, need: 1 },
      { ico: '🤝', name: 'Segítő', unit: 'jelentés',
        desc: '5 üzemállapot-jelzés', got: reportN >= 5, cur: Math.min(reportN, 5), need: 5 }
    ];
  }

  function profSection(title, inner, hint) {
    if (!inner) return '';
    return '<section class="p-sec">' +
      '<div class="p-sec-head"><h3>' + esc(title) + '</h3>' +
      (hint ? '<span>' + esc(hint) + '</span>' : '') + '</div>' +
      '<div class="p-sec-body">' + inner + '</div>' +
    '</section>';
  }

  function badgeHtml(b) {
    return '<div class="p-badge' + (b.got ? ' is-got' : '') + '">' +
      '<span class="p-badge-ico" aria-hidden="true">' + b.ico + '</span>' +
      '<span class="p-badge-main"><b>' + esc(b.name) + '</b>' +
      '<small>' + (b.got ? 'Megszerezve ✓' : esc(b.desc) + ' · ' + b.cur + '/' + b.need) + '</small></span>' +
    '</div>';
  }

  // motivációs csík: melyik jelvény van a legközelebb
  function progressHtml(badges) {
    var pend = badges.filter(function (b) { return !b.got; });
    if (!pend.length) {
      return '<div class="p-prog is-done">' +
        '<div class="p-prog-txt"><b>Mind az öt jelvényed megvan</b>' +
        '<span>Ügyes vagy — jöhet egy újabb kör?</span></div>' +
        '<div class="p-prog-bar"><i style="width:100%"></i></div>' +
      '</div>';
    }
    var multi = pend.filter(function (b) { return b.need > 1; });
    var pick = multi.length
      ? multi.sort(function (a, b) { return (b.cur / b.need) - (a.cur / a.need); })[0]
      : pend[0];
    var pct = pick.need > 1 ? Math.max(5, Math.round(pick.cur / pick.need * 100)) : 0;
    var txt = pick.need > 1 ? (pick.cur + '/' + pick.need + ' ' + pick.unit) : pick.name;
    return '<div class="p-prog">' +
      '<div class="p-prog-txt"><b>Következő jelvény: ' + esc(txt) + '</b>' +
      '<span>' + esc(pick.desc) + '</span></div>' +
      '<div class="p-prog-bar"><i style="width:' + pct + '%"></i></div>' +
    '</div>';
  }

  function rateRowHtml(id, d) {
    var p = state.byId.get(+id);
    var bits = [];
    if (d.at) bits.push(fmtWhen(d.at));
    (d.tags || []).forEach(function (t) { bits.push(tagLabel(t)); });
    return '<div class="rate-row" data-id="' + id + '">' +
      scoreBadge(d.score) +
      '<span class="rank-main"><b>' + esc(p ? p.name : ('#' + id)) + '</b>' +
      '<small>' + esc(bits.join(' · ')) + '</small></span>' +
      '<span class="p-row-acts">' +
        '<button class="p-ico-btn" type="button" data-fbedit="' + id + '" title="Szerkesztés" aria-label="Értékelés szerkesztése">✎</button>' +
        '<button class="p-ico-btn" type="button" data-fbdel="' + id + '" title="Törlés" aria-label="Értékelés törlése">🗑</button>' +
      '</span>' +
    '</div>';
  }

  function profileHtml() {
    var store = loadFbStore();
    var ids = Object.keys(store);
    var visits = profVisits();
    var favIds = Object.keys(social.favs).map(Number)
      .filter(function (id) { return state.byId.has(id); });
    var badges = badgeStates();
    var out = [];

    // motivációs sáv a tetején
    out.push(progressHtml(badges));

    // számok + sorozat
    var sum = 0, best = null, tags = {};
    ids.forEach(function (id) {
      var d = store[id] || {};
      sum += d.score || 0;
      if (!best || (d.score || 0) > best.score) best = { id: id, score: d.score || 0 };
      (d.tags || []).forEach(function (t) { tags[t] = (tags[t] || 0) + 1; });
    });
    var avg = ids.length ? (sum / ids.length).toFixed(1).replace('.', ',') : '–';
    out.push('<div class="profile-stats">' +
      '<div class="profile-stat"><b>' + ids.length + '</b><span>értékelt pont</span></div>' +
      '<div class="profile-stat"><b>' + avg + '</b><span>átlag / 10</span></div>' +
      '<div class="profile-stat"><b>' + (best ? best.score : '–') + '</b><span>legjobb</span></div>' +
      '<div class="profile-stat is-streak"><b>' + streakDays(activityKeys()) + '</b><span>napos sorozat</span></div>' +
    '</div>');

    var bestP = best ? state.byId.get(+best.id) : null;
    if (bestP) {
      out.push('<div class="rank-row" data-id="' + bestP.id + '">' +
        scoreBadge(best.score) +
        '<span class="rank-main"><b>Kedvenc REpontod: ' + esc(bestP.name) + '</b>' +
        '<small>' + esc(addrText(bestP)) + '</small></span>' +
      '</div>');
    }

    var topTags = Object.keys(tags).sort(function (a, b) { return tags[b] - tags[a]; }).slice(0, 4);
    if (topTags.length) {
      out.push('<div class="fb-tags" style="margin-top:14px">' + topTags.map(function (t) {
        return '<span class="fb-tag is-on">' + esc(tagLabel(t)) + ' ×' + tags[t] + '</span>';
      }).join('') + '</div>');
    }

    // jelvények
    out.push(profSection('Jelvények', badges.map(badgeHtml).join('')));

    // visszaváltás-napló + kassza (50 Ft/db + kaució, havi grafikon)
    out.push(profSection('Visszaváltás-napló', cashSectionHtml()));

    // látogatások
    if (visits.length) {
      out.push(profSection('Látogatások', visits.map(function (v) {
        var p = state.byId.get(v.id);
        if (!p) return '';
        return '<div class="rank-row" data-id="' + p.id + '">' +
          '<span class="p-ico" aria-hidden="true">📍</span>' +
          '<span class="rank-main"><b>' + esc(p.name) + '</b>' +
          '<small>' + fmtWhen(v.at) + (p.city ? ' · ' + esc(p.city) : '') + '</small></span>' +
          '<span class="p-go" aria-hidden="true">›</span>' +
        '</div>';
      }).join(''), 'legutóbbi ' + visits.length));
    }

    // kedvencek
    if (favIds.length) {
      out.push(profSection('Kedvenceid', favIds.map(function (id) {
        var p = state.byId.get(id);
        return '<div class="rank-row" data-id="' + id + '">' +
          '<span class="p-ico" aria-hidden="true">★</span>' +
          '<span class="rank-main"><b>' + esc(p.name) + '</b>' +
          '<small>' + esc(p.city || addrText(p)) + '</small></span>' +
          '<button class="p-btn" type="button" data-route="' + id + '">Útvonal</button>' +
        '</div>';
      }).join(''), favIds.length + ' db'));
    }

    // értékelések
    if (ids.length) {
      var rows = ids.map(function (id) { return { id: id, d: store[id] || {} }; })
        .sort(function (a, b) { return (b.d.at || 0) - (a.d.at || 0); });
      out.push(profSection('Értékeléseid', rows.map(function (r) {
        return rateRowHtml(r.id, r.d);
      }).join(''), rows.length + ' db'));
    }

    return out.join('');
  }

  // a megye-tábla és a fiók teljes látogatáslistája aszinkron töltődik;
  // ha megérkezik, újrarajzoljuk a nyitott profilt (a jelzőszám eltéréséből)
  var profSig = null;

  function profileSig() {
    return (ZIP_COUNTY ? 'z' : '-') + '|' +
      (profExtra.visits ? profExtra.visits.length : '-') + '|' +
      Object.keys(loadFbStore()).length + '|' + Object.keys(social.favs).length;
  }

  function profileRefresh() {
    profSig = profileSig();
    var jobs = [];
    if (!ZIP_COUNTY && !zipTried) jobs.push(loadZipCounty());
    if (sb && account.user && profExtra.forUser !== account.user.id) jobs.push(loadProfExtras());
    if (!jobs.length) return;
    Promise.all(jobs).then(function () {
      if (overlayKind === 'profile' && profileSig() !== profSig) openOverlay('profile');
    });
  }

  function loadProfExtras() {
    if (!sb || !account.user) return Promise.resolve();
    var uid = account.user.id;
    profExtra.forUser = uid;
    return sb.from('visits').select('point_id,visited_at')
      .eq('user_id', uid)
      .order('visited_at', { ascending: false })
      .limit(1000)
      .then(function (res) {
        if (res.error || !res.data) return;
        profExtra.visits = res.data.map(function (r) {
          return { id: Number(r.point_id), at: Date.parse(r.visited_at) || 0 };
        }).filter(function (v) { return v.id; });
      })
      .catch(function () { });
  }

  /* --- profil műveletek (sorok kezelése, név szerkesztése) --- */

  function jumpTo(id) {
    closeOverlay();
    setDock('dockMap');
    select(id, {});
  }

  function editRating(id) {
    jumpTo(id);
    // a visszajelző doboz a részletek között van, oda görgetünk
    setTimeout(function () {
      if (el.feedback) {
        el.feedback.scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'start' });
      }
    }, 380);
  }

  function removeRating(id) {
    fbRemove(id);
    if (sb && account.user) {
      sb.from('ratings').delete().eq('user_id', account.user.id).eq('point_id', id)
        .then(function (r) { if (r.error) console.warn('[értékelés törlés]', r.error.message); });
    }
    applyFilters();
    if (selectedId === id) { loadFbIntoUI(id); refreshSheetRate(); }
    openOverlay('profile');
    toast('Értékelés törölve');
  }

  function routeFromProfile(id) {
    var p = state.byId.get(id);
    if (!p) return;
    closeOverlay();
    setDock('dockMap');
    startRoute(p, null);
  }

  function profileNameEdit() {
    var head = el.overlayBody.querySelector('.account-head');
    if (!head || !account.user) return;
    var name = displayName();
    head.innerHTML =
      '<span class="account-avatar">' + esc(String(name).trim().charAt(0).toUpperCase() || '?') + '</span>' +
      '<form class="p-name-form">' +
        '<input class="p-name-input" type="text" maxlength="32" value="' + esc(name) + '"' +
          ' aria-label="Megjelenített név" placeholder="Megjelenített név">' +
        '<span class="p-name-btns">' +
          '<button class="btn btn-primary p-btn" type="submit">Mentés</button>' +
          '<button class="btn btn-ghost p-btn" type="button" data-name-cancel>Mégse</button>' +
        '</span>' +
      '</form>';
    var input = head.querySelector('.p-name-input');
    head.querySelector('.p-name-form').addEventListener('submit', function (e) {
      e.preventDefault();
      saveDisplayName(input.value);
    });
    head.querySelector('[data-name-cancel]').addEventListener('click', function () { openOverlay('profile'); });
    input.focus();
    input.select();
  }

  function saveDisplayName(raw) {
    if (!sb || !account.user) return;
    var name = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 32);
    if (!name) { toast('Adj meg egy nevet (1–32 karakter)'); return; }
    var apply = function () {
      if (!account.profile) account.profile = {};
      account.profile.display_name = name;
      openOverlay('profile');
      toast('Név elmentve ✓');
    };
    sb.from('profiles').update({ display_name: name }).eq('id', account.user.id).select('id')
      .then(function (res) {
        if (res.error) throw res.error;
        if (res.data && res.data.length) return null;
        // még nincs profilsor (pl. régi fiók) → létrehozzuk
        return sb.from('profiles').insert({ id: account.user.id, display_name: name }).select('id')
          .then(function (r2) { if (r2.error) throw r2.error; });
      })
      .then(apply)
      .catch(function (e) { toast('Nem sikerült menteni: ' + authErr(e)); });
  }

  // avatar választó: emoji rács + szín, elöl élő előnézettel
  function profileAvatarEdit() {
    var head = el.overlayBody.querySelector('.account-head');
    if (!head) return;
    var cur = avatarOf() || { e: '', c: 0 };
    var sel = { e: cur.e || '', c: cur.c || 0 };

    var panel = document.createElement('div');
    panel.className = 'p-avedit';
    panel.innerHTML =
      '<div class="p-av-head">' +
        '<span class="p-av-prev">' + avatarSpan(sel) + '</span>' +
        '<span class="p-av-head-txt"><b>Avatar választása</b>' +
        '<small>Emojit és színt is adhatsz hozzá</small></span>' +
      '</div>' +
      '<div class="p-av-grid" role="group" aria-label="Emoji">' +
        AV_EMOJI.map(function (e) {
          return '<button type="button" class="p-av-emo' + (e === sel.e ? ' is-on' : '') + '"' +
            ' data-e="' + e + '" aria-label="' + e + '">' + e + '</button>';
        }).join('') +
      '</div>' +
      '<div class="p-av-colors" role="group" aria-label="Szín">' +
        AV_COLORS.map(function (c, i) {
          return '<button type="button" class="p-av-col' + (i === sel.c ? ' is-on' : '') + '"' +
            ' data-c="' + i + '" title="' + c.name + '" aria-label="' + c.name + ' szín">' +
            '<i style="background:' + c.bg + '"></i></button>';
        }).join('') +
      '</div>' +
      '<div class="p-av-btns">' +
        '<button class="btn btn-primary p-btn" type="button" data-av-save>Mentés</button>' +
        '<button class="btn btn-ghost p-btn" type="button" data-av-clear>Alapértelmezett</button>' +
        '<button class="btn btn-ghost p-btn" type="button" data-av-cancel>Mégse</button>' +
      '</div>';

    head.hidden = true;
    head.parentNode.insertBefore(panel, head);

    var prev = panel.querySelector('.p-av-prev');
    var repaint = function () {
      prev.innerHTML = avatarSpan(sel);
      Array.prototype.forEach.call(panel.querySelectorAll('.p-av-emo'), function (b) {
        b.classList.toggle('is-on', b.dataset.e === sel.e);
      });
      Array.prototype.forEach.call(panel.querySelectorAll('.p-av-col'), function (b) {
        b.classList.toggle('is-on', +b.dataset.c === sel.c);
      });
    };

    panel.addEventListener('click', function (e) {
      var emo = e.target.closest('.p-av-emo');
      if (emo) { sel.e = emo.dataset.e === sel.e ? '' : emo.dataset.e; repaint(); return; }
      var col = e.target.closest('.p-av-col');
      if (col) { sel.c = +col.dataset.c; repaint(); return; }
      if (e.target.closest('[data-av-save]')) {
        setAvatar(sel).then(function () {
          openOverlay('profile');
          toast(sel.e ? 'Avatar elmentve ✓' : 'Alapértelmezett avatar');
        });
        return;
      }
      if (e.target.closest('[data-av-clear]')) {
        setAvatar({ e: '', c: 0 }).then(function () {
          openOverlay('profile');
          toast('Vissza az alapértelmezettre');
        });
        return;
      }
      if (e.target.closest('[data-av-cancel]')) openOverlay('profile');
    });
  }

  function initMap() {
    map = new maplibregl.Map({
      container: 'map',
      style: MAP_STYLE,
      center: [19.4597, 47.1625],
      zoom: 6.9,
      minZoom: 6,
      maxZoom: 18,
      maxPitch: 60,
      attributionControl: false,
      // döntés + forgatás PC-n (3D nézet), telefonon az ujj ne billentse le véletlenül
      dragRotate: !isMobile(),
      pitchWithRotate: !isMobile(),
      touchPitch: false,
      touchZoomRotate: true
    });

    // a stílusban hivatkozott, de a sprite-ból hiányzó képeket csendben pótoljuk
    if (typeof map.setMissingStyleImageResolver === 'function') {
      try {
        map.setMissingStyleImageResolver(function (name) {
          if (!map.hasImage(name)) {
            map.addImage(name, { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]) }, { pixelRatio: 1 });
          }
        });
      } catch (e) { }
    }
    map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), 'bottom-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'top-right');
    addTiltControl();

    // ha a felhasználó kézzel dönti meg a térképet, a 3D gomb állapota kövesse
    map.on('pitchend', function () {
      var on = map.getPitch() > 20;
      if (on !== is3D) set3D(on, { silent: true });
    });
    // az attribúció csak egy kis „i” gomb, alapból becsukva
    function collapseAttrib() {
      var at = document.querySelector('.maplibregl-ctrl-attrib');
      if (at) { at.removeAttribute('open'); at.classList.remove('maplibregl-compact-show'); }
    }
    collapseAttrib();
    setTimeout(collapseAttrib, 400);
    map.once('load', function () { collapseAttrib(); setTimeout(collapseAttrib, 400); });

    map.on('style.load', onStyleLoad);
    map.on('error', function (e) {
      var msg = e && e.error ? String(e.error.message || e.error) : '';
      // a csempe-hiperhivatkozások és a hiányzó sprite-képek hibáit nem öntjük a konzolra
      if (/Failed to fetch|AbortError|could not be loaded/i.test(msg)) return;
      if (msg) console.warn('[térkép]', msg);
    });

    window.addEventListener('resize', debounce(function () { map.resize(); }, 160));
  }

  function onStyleLoad() {
    applyTheme();
    applySky();
    addBuildings3D();
    addDataLayers();
    if (selectedId != null) setSelected(selectedId);
    if (state.route) drawRouteLayer(state.route.geojson);
    bindLayerHandlers();
    ready.style = true;
    startAnimations();
    if (pendingPlace) { var fn = pendingPlace; pendingPlace = null; fn(); }
    maybeHideLoader();
  }

  function setP(id, prop, val) {
    if (!map.getLayer(id)) return;
    try { map.setPaintProperty(id, prop, val); } catch (e) { }
  }

  /* --- sötét stílus → fekete + lime paletta --- */
  function applyTheme() {
    var layers;
    try { layers = map.getStyle().layers || []; } catch (e) { return; }

    layers.forEach(function (l) {
      var id = l.id;

      if (l.type === 'background') { setP(id, 'background-color', '#050607'); return; }

      if (l.type === 'fill') {
        if (/water/.test(id)) return setP(id, 'fill-color', '#08131F');
        if (/wood|park|grass|forest|scrub|farmland/.test(id)) return setP(id, 'fill-color', '#080F0B');
        if (/building/.test(id)) return setP(id, 'fill-color', '#0E1013');
        if (/ice|glacier/.test(id)) return setP(id, 'fill-color', '#0C0E12');
        return setP(id, 'fill-color', '#07080A');
      }

      if (l.type === 'line') {
        if (/waterway/.test(id)) return setP(id, 'line-color', '#101F30');
        if (/motorway/.test(id)) return setP(id, 'line-color', '#3C4454');
        if (/_inner/.test(id)) return setP(id, 'line-color', '#2A303C');
        if (/_casing|_dashline/.test(id)) return setP(id, 'line-color', '#05070A');
        if (/railway/.test(id)) return setP(id, 'line-color', '#1E232D');
        if (/boundary/.test(id)) return setP(id, 'line-color', 'rgba(216,224,47,.22)');
        if (/aeroway|road_pier/.test(id)) return setP(id, 'line-color', '#171B22');
        return setP(id, 'line-color', '#161A21');
      }

      if (l.type === 'symbol') {
        var big = /place_city|place_town|country_name|place_country/.test(id);
        var tiny = /water_name|highway_name|road_oneway|railway_name|shop|housenum|mountain|peak/.test(id);
        setP(id, 'text-color', big ? '#EDEFF3' : (tiny ? '#5C6270' : '#8A9099'));
        setP(id, 'text-halo-color', 'rgba(3,4,5,.95)');
        setP(id, 'text-halo-width', 1.7);
      }
    });
  }

  /* --- égbolt + fényezés: mély, éjszakai térhatás döntéskor --- */
  function applySky() {
    if (typeof map.setSky === 'function') {
      try {
        map.setSky({
          'sky-color': '#040507',
          'horizon-color': '#0B1016',
          'sky-horizon-blend': .6,
          'fog-color': '#0A0D12',
          'horizon-fog-blend': .65,
          'fog-ground-blend': .85,
          // távolról enyhe atmoszféra-réteg, közelről tiszta fekete ég
          'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, .5, 7, 0]
        });
      } catch (e) { }
    }
    // hideítt fény az épületek oldalának (hűvös, holdfény-szerű)
    if (typeof map.setLight === 'function') {
      try { map.setLight({ anchor: 'viewport', color: '#C8D4FF', intensity: .45 }); } catch (e) { }
    }
  }

  /* --- 3D épületek: z13,5 fölött, a címkék alá fűzve, hogy azok olvashatók maradjanak --- */
  function addBuildings3D() {
    if (map.getLayer('building-3d')) return;
    var layers = [];
    try { layers = map.getStyle().layers || []; } catch (e) { return; }
    var before = null;
    for (var i = 0; i < layers.length; i++) {
      if (layers[i].type === 'symbol') { before = layers[i].id; break; }
    }
    try {
      map.addLayer({
        id: 'building-3d',
        type: 'fill-extrusion',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 13.5,
        paint: {
          'fill-extrusion-color': ['interpolate', ['linear'], ['zoom'], 13.5, '#101318', 16, '#191D24'],
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], ['get', 'height'], 8],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
          'fill-extrusion-opacity': .93
        }
      }, before);
    } catch (e) { }
  }

  /* --- 3D nézet ki-/bekapcsoló (a térkép sarkában és mobilon a kapszulában) --- */

  function addTiltControl() {
    var wrap = document.createElement('div');
    wrap.className = 'maplibregl-ctrl-group map-3d-ctrl';
    var btn = document.createElement('button');
    btn.className = 'map-3d-btn';
    btn.type = 'button';
    btn.title = '3D nézet';
    btn.setAttribute('aria-label', '3D nézet');
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 3 7.5l9 4.5 9-4.5L12 3z"/><path d="m3 12.5 9 4.5 9-4.5"/><path d="m3 17 9 4.5L21 17"/></svg>';
    btn.addEventListener('click', toggle3D);
    wrap.appendChild(btn);
    map.addControl({
      onAdd: function () { return wrap; },
      onRemove: function () { wrap.remove(); }
    }, 'bottom-right');
  }

  function toggle3D() { set3D(!is3D); }

  function set3D(on, opts) {
    is3D = !!on;
    document.body.classList.toggle('is-3d', is3D);
    if (el.tool3D) {
      el.tool3D.classList.toggle('is-on', is3D);
      el.tool3D.setAttribute('aria-pressed', is3D ? 'true' : 'false');
    }
    var b = document.querySelector('.map-3d-btn');
    if (b) {
      b.classList.toggle('is-on', is3D);
      b.setAttribute('aria-pressed', is3D ? 'true' : 'false');
    }
    if (opts && opts.silent) return;   // a felhasználó maga döntötte meg, nem mozgatjuk újra
    try {
      map.easeTo({ pitch: is3D ? 55 : 0, duration: 900, essential: true });
    } catch (e) { }
  }

  /* --- lassú animációk: klaszter-lüktetés + útvonal-fény (egy közös rAF) --- */

  function startAnimations() {
    if (REDUCED_MOTION || animRaf) return;
    animRaf = window.requestAnimationFrame(animLoop);
  }

  function animLoop(ts) {
    animRaf = window.requestAnimationFrame(animLoop);
    if (!map || document.hidden || !ready.style) return;
    if (ts - animLast < 42) return;              // ~24 fps elég egy lassú lüktetéshez
    animLast = ts;
    if (!animT0) animT0 = ts;
    if (map.isMoving()) return;                  // mozgás közben ne terheljük a stílust

    if (map.getZoom() < 13.4 && map.getLayer('repont-cluster-glow')) {
      var k = 0.5 - 0.5 * Math.cos(((ts - animT0) / 1700) * Math.PI * 2);
      setP('repont-cluster-glow', 'circle-radius', clusterGlowRadius(k * 7));
      setP('repont-cluster-glow', 'circle-opacity', .16 + k * .12);
    }
    if (state.route && state.route.geojson && map.getLayer('route-flow')) {
      setP('route-flow', 'line-gradient', flowGradient(((ts - animT0) / 2600) % 1));
    }
  }

  /* --- útvonal: futó fény (line-gradient + lineMetrics forrás) --- */

  // a `o` a fény fejének pozíciója az útvonalon (0..1); a fej fehér, mögötte lime utófény
  function flowGradient(o) {
    var N = 40, stops = ['interpolate', ['linear'], ['line-progress']];
    for (var i = 0; i <= N; i++) {
      var t = i / N;
      var d = ((t - o) % 1 + 1) % 1;   // 0 = a fény feje
      var r, g, b, a;
      if (d < 0.025) { r = 255; g = 255; b = 255; a = 1; }
      else if (d < 0.11) {
        var k = (d - 0.025) / 0.085;
        r = 255 - 39 * k; g = 255 - 31 * k; b = 255 - 208 * k; a = 1;
      } else if (d < 0.3) { r = 216; g = 224; b = 47; a = 1 - (d - 0.11) / 0.19; }
      else { r = 216; g = 224; b = 47; a = 0; }
      stops.push(t, 'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ',' + a.toFixed(3) + ')');
    }
    return stops;
  }

  /* --- pontok + klűszerek + útvonal --- */

  // a klaszter alatti lime ragyogás sugara; a `pulse` (0..7) adja a lüktetést
  function clusterGlowRadius(pulse) {
    return ['step', ['get', 'point_count'], 26 + pulse, 10, 33 + pulse, 50, 41 + pulse, 200, 49 + pulse];
  }

  function addDataLayers() {
    if (!map.getSource('repont')) {
      map.addSource('repont', {
        type: 'geojson',
        data: state.geojson,
        cluster: true,
        clusterRadius: 54,
        clusterMaxZoom: 13
      });

      map.addLayer({
        id: 'repont-halo', type: 'circle', source: 'repont',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 9, 11, 15, 16, 22],
          'circle-color': ['match', ['get', 'type'], 'automata', 'rgba(255,122,69,.5)', 'rgba(34,201,238,.5)'],
          'circle-blur': 0.82
        }
      });

      map.addLayer({
        id: 'repont-dot', type: 'circle', source: 'repont',
        filter: ['all', ['!', ['has', 'point_count']], ['!', ['has', 'score']]],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3.2, 11, 5, 16, 6.5],
          'circle-color': ['match', ['get', 'type'], 'automata', '#FF7A45', '#22C9EE'],
          'circle-stroke-color': '#050607',
          'circle-stroke-width': 1.6
        }
      });

      // friss üzemállapot-jelzés: színes gyűrű a pont körül
      map.addLayer({
        id: 'repont-report', type: 'circle', source: 'repont',
        filter: ['all', ['!', ['has', 'point_count']], ['has', 'report']],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 7, 11, 10.5, 16, 14],
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-width': 2.2,
          'circle-stroke-color': ['match', ['get', 'report'],
            'tele', '#FF4D4D', 'urult', '#2BD97C', 'hibas', '#F16524', '#999999']
        }
      });

      // értékelt pontok: pontszám-jelvény (piros <7, narancs 7–8,9, lime 9+)
      map.addLayer({
        id: 'repont-score', type: 'circle', source: 'repont',
        filter: ['all', ['!', ['has', 'point_count']], ['has', 'score']],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 7.5, 11, 11, 16, 14],
          'circle-color': [
            'interpolate', ['linear'], ['get', 'score'],
            6.9, '#DA1E28',
            7, '#F16524',
            9, '#D8E02F'
          ],
          'circle-stroke-color': '#050607',
          'circle-stroke-width': 2
        }
      });

      map.addLayer({
        id: 'repont-score-num', type: 'symbol', source: 'repont',
        filter: ['all', ['!', ['has', 'point_count']], ['has', 'score']],
        layout: {
          'text-field': ['to-string', ['get', 'score']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 6, 8.5, 11, 11.5, 16, 14]
        },
        paint: { 'text-color': '#0A0B03' }
      });

      // az első három legközelebbi pont lime-számú jelölője
      map.addLayer({
        id: 'repont-rank', type: 'symbol', source: 'repont',
        filter: ['all', ['!', ['has', 'point_count']], ['<=', ['get', 'rank'], 3]],
        layout: {
          'text-field': ['get', 'rank'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-offset': [0, -1.35],
          'text-allow-overlap': true
        },
        paint: { 'text-color': '#D8E02F', 'text-halo-color': '#050607', 'text-halo-width': 2 }
      });

      // modern klaszter: lime ragyogás a korong alatt, belső fénymag, sötét számláló
      map.addLayer({
        id: 'repont-cluster-glow', type: 'circle', source: 'repont',
        filter: ['has', 'point_count'],
        paint: {
          'circle-radius': clusterGlowRadius(0),
          'circle-color': '#D8E02F',
          'circle-opacity': .2,
          'circle-blur': 1
        }
      });

      map.addLayer({
        id: 'repont-clusters', type: 'circle', source: 'repont',
        filter: ['has', 'point_count'],
        paint: {
          'circle-radius': ['step', ['get', 'point_count'], 16, 10, 20, 50, 25, 200, 31],
          'circle-color': 'rgba(7,8,10,.94)',
          'circle-stroke-color': '#D8E02F',
          'circle-stroke-width': 2
        }
      });

      map.addLayer({
        id: 'repont-cluster-core', type: 'circle', source: 'repont',
        filter: ['has', 'point_count'],
        paint: {
          'circle-radius': ['step', ['get', 'point_count'], 9, 10, 12, 50, 15, 200, 18],
          'circle-color': 'rgba(216,224,47,.14)',
          'circle-blur': .55
        }
      });

      map.addLayer({
        id: 'repont-cluster-count', type: 'symbol', source: 'repont',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['step', ['get', 'point_count'], 13, 10, 14, 50, 15]
        },
        paint: { 'text-color': '#D8E02F', 'text-halo-color': 'rgba(3,4,5,.9)', 'text-halo-width': 2 }
      });

      // hover: lime keret a pont alatt (az egér fölé érésre)
      map.addLayer({
        id: 'repont-hover', type: 'circle', source: 'repont',
        filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'id'], -1]],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 9, 11, 13, 16, 16.5],
          'circle-color': 'rgba(216,224,47,.08)',
          'circle-stroke-color': '#D8E02F',
          'circle-stroke-width': 1.8
        }
      });

      map.addLayer({
        id: 'repont-sel', type: 'circle', source: 'repont',
        filter: ['==', ['get', 'id'], -1],
        paint: {
          'circle-radius': 9.5,
          'circle-color': '#D8E02F',
          'circle-stroke-color': 'rgba(216,224,47,.45)',
          'circle-stroke-width': 7
        }
      });
    }

    if (!map.getSource('route')) {
      // lineMetrics: kell a line-gradient-hez (futó fény az útvonalon)
      map.addSource('route', { type: 'geojson', data: EMPTY_FC, lineMetrics: true });
      map.addLayer({
        id: 'route-case', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#050607', 'line-width': 12, 'line-opacity': .85 }
      });
      map.addLayer({
        id: 'route-line', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#D8E02F',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3.5, 15, 6],
          'line-opacity': .95
        }
      });
      // az útvonalon végigfutó „energia-fény": fej + lime utófény (animálva)
      map.addLayer({
        id: 'route-flow', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 6, 15, 9],
          'line-opacity': 1,
          'line-gradient': flowGradient(.15)
        }
      });
    }
  }

  function setSelected(id) {
    if (!map.getLayer('repont-sel')) return;
    map.setFilter('repont-sel', ['==', ['get', 'id'], id]);
  }

  function bindLayerHandlers() {
    if (handlersBound) return;
    handlersBound = true;

    map.on('click', 'repont-clusters', function (e) {
      var f = map.queryRenderedFeatures(e.point, { layers: ['repont-clusters'] })[0];
      if (!f) return;
      var coords = f.geometry.coordinates;
      var src = map.getSource('repont');
      var zoom;
      try { zoom = src.getClusterExpansionZoom(f.properties.cluster_id); } catch (err) { zoom = null; }
      if (zoom && typeof zoom.then === 'function') {
        zoom.then(function (z) { map.easeTo({ center: coords, zoom: z, duration: 650 }); })
          .catch(function () { map.easeTo({ center: coords, zoom: map.getZoom() + 2.5, duration: 650 }); });
      } else {
        map.easeTo({ center: coords, zoom: map.getZoom() + 2.5, duration: 650 });
      }
    });

    map.on('click', function (e) {
      if (!isMobile() || !document.body.classList.contains('is-search')) return;
      var hit = map.queryRenderedFeatures(e.point, { layers: ['repont-clusters', 'repont-dot', 'repont-score'].filter(function (l) { return map.getLayer(l); }) });
      if (hit.length) return;
      setSearchOpen(false);
      setDock('dockMap');
    });

    map.on('click', 'repont-dot', function (e) {
      var f = map.queryRenderedFeatures(e.point, { layers: ['repont-dot'] })[0];
      if (!f) return;
      select(f.properties.id, { fromMap: true });
    });

    map.on('click', 'repont-score', function (e) {
      var f = map.queryRenderedFeatures(e.point, { layers: ['repont-score'] })[0];
      if (!f) return;
      select(f.properties.id, { fromMap: true });
    });

    ['repont-dot', 'repont-clusters', 'repont-score'].forEach(function (lid) {
      map.on('mouseenter', lid, function () { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', lid, function () { map.getCanvas().style.cursor = ''; });
    });

    // --- hover: lime keret + lebegő előnézet (csak egérrel, asztali gépen) ---
    if (HOVER_CAPABLE) {
      map.on('mousemove', onHoverMove);
      map.on('dragstart', function () { hoverDrag = true; clearHover(); });
      map.on('dragend', function () { hoverDrag = false; });
      map.on('movestart', clearHover);
      map.on('click', clearHover);
    }
  }

  /* ==================== hover + lebegő előnézet ==================== */

  var HOVER_CAPABLE = !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  var hoverId = null, hoverLast = 0, hoverDrag = false;

  function setHoverRing(id) {
    if (!map || !map.getLayer('repont-hover')) return;
    try {
      map.setFilter('repont-hover', ['all', ['!', ['has', 'point_count']], ['==', ['get', 'id'], id == null ? -1 : id]]);
    } catch (e) { }
  }

  function moveTip(pt) {
    var t = el.mapTip;
    if (!t || t.hidden) return;
    var pad = 12, w = t.offsetWidth, h = t.offsetHeight;
    var container = map.getContainer();
    var x = pt.x + 14, y = pt.y - h - 14;          // a kurzor fölé
    if (x + w > container.clientWidth - pad) x = pt.x - 14 - w;   // jobb szél → balra
    if (y < pad) y = pt.y + 22;                                  // nincs hely fent → lent
    t.style.transform = 'translate(' + Math.round(Math.max(pad, x)) + 'px,' + Math.round(y) + 'px)';
  }

  function showTip(html, pt) {
    var t = el.mapTip;
    if (!t) return;
    if (t.innerHTML !== html) t.innerHTML = html;
    if (t.hidden) { t.hidden = false; t.classList.add('is-on'); }
    moveTip(pt);
  }

  function hideTip() {
    var t = el.mapTip;
    if (!t || t.hidden) return;
    t.classList.remove('is-on');
    t.hidden = true;
  }

  function tipHtmlFor(f) {
    var pr = f.properties || {};
    if (pr.point_count != null) {
      return '<b>' + esc(String(pr.point_count_abbreviated || pr.point_count)) + ' pont</b>' +
        '<span class="tip-sub">Kattints a nagyításhoz</span>';
    }
    var p = state.byId.get(pr.id);
    if (!p) return null;
    var st = statusOf(p, new Date());
    return '<b>' + esc(p.name) + '</b>' +
      '<span class="tip-row">' +
        '<span class="tag ' + p.type + '">' + (p.type === 'automata' ? 'Automata' : 'Kézi') + '</span>' +
        '<span class="tip-st ' + st + '">' + OPEN_LABEL[st] + '</span>' +
        (p._d != null ? '<span class="tip-d">' + fmtDist(p._d) + '</span>' : '') +
      '</span>';
  }

  function clearHover() {
    hoverId = null;
    setHoverRing(null);
    hideTip();
  }

  function onHoverMove(e) {
    if (hoverDrag || map.isMoving()) return;
    var now = Date.now();
    if (now - hoverLast < 55) return;     // ne kérdezgessünk minden képkockán
    hoverLast = now;

    var layers = ['repont-dot', 'repont-score', 'repont-clusters'].filter(function (l) { return map.getLayer(l); });
    if (!layers.length) return;
    var f = map.queryRenderedFeatures(e.point, { layers: layers })[0];
    if (!f) { if (hoverId != null) clearHover(); return; }

    var html = tipHtmlFor(f);
    if (!html) { clearHover(); return; }

    var pr = f.properties || {};
    var id = pr.point_count != null ? 'c' + pr.cluster_id : pr.id;
    if (id !== hoverId) {
      hoverId = id;
      setHoverRing(pr.point_count != null ? null : pr.id);
    }
    showTip(html, e.point);
  }

  function popupHtml(p, now) {
    var st = statusOf(p, now);
    var d = fbOf(p.id);
    return '<div class="pop-name">' + esc(p.name) + '</div>' +
      '<div class="pop-addr">' + esc(addrText(p)) + '</div>' +
      '<div class="pop-row">' +
        '<span class="pop-open ' + (st === 'open' || st === 'soon' ? 'yes' : (st === 'closed' ? 'no' : '')) + '">' +
          OPEN_LABEL[st] + '</span>' +
        '<span class="tag ' + p.type + '">' + (p.type === 'automata' ? 'Automata' : 'Kézi') + '</span>' +
        (p._d != null ? '<span>' + fmtDist(p._d) + '</span>' : '') +
        (d ? '<span class="rate-mini">★ ' + d.score + '/10</span>' : '') +
      '</div>' +
      '<div class="pop-actions">' +
        '<button class="pop-link" data-route="' + p.id + '">Útvonal</button>' +
        '<button class="pop-link-ghost" data-detail="' + p.id + '">Részletek</button>' +
      '</div>';
  }

  function openPopupFor(p) {
    closePopup();
    popup = new maplibregl.Popup({ closeButton: true, offset: 18, maxWidth: '280px' })
      .setLngLat([p.lng, p.lat])
      .setHTML(popupHtml(p, new Date()))
      .addTo(map);
  }

  function closePopup() {
    if (popup) { try { popup.remove(); } catch (e) { } popup = null; }
  }

  function setPoints(points) {
    var store = loadFbStore();
    state.geojson = {
      type: 'FeatureCollection',
      features: points.map(function (p) {
        var d = store[p.id];
        var props = { id: p.id, type: p.type, rank: p._rank || 99 };
        if (d && d.score != null) props.score = d.score;   // csak létező pontszám
        if (social.reports[p.id]) props.report = social.reports[p.id].status;
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
          properties: props
        };
      })
    };
    var src = map && map.getSource && map.getSource('repont');
    if (src) src.setData(state.geojson);
  }

  /* ==================== útvonal (oldalon belüli navigáció) ==================== */

  function drawRouteLayer(geojson) {
    if (!map.getSource('route')) return;
    map.getSource('route').setData(geojson || EMPTY_FC);
  }

  function routeStepsHtml(steps) {
    if (!steps || !steps.length) return '';
    return steps.map(function (s, i) {
      var ico = stepIcon(s.maneuver);
      return '<div class="rstep" data-step="' + i + '" role="button" tabindex="0" title="Megnézem ezt a lépést">' +
        '<span class="rstep-ico">' + ico + '</span>' +
        '<span class="rstep-txt">' + esc(s.instruction || stepText(s)) +
          (s.name ? '<i>' + esc(s.name) + '</i>' : '') +
        '</span>' +
        '<span class="rstep-d">' + (s.distance ? fmtDist(s.distance) : '') + '</span>' +
      '</div>';
    }).join('');
  }

  // az OSRM manőver-típusaiból magyar leírás + ikon
  function stepText(s) {
    var m = s.maneuver || {};
    var t = m.type, mod = m.modifier;
    if (t === 'depart') return 'Indulj ' + (m.direction || 'előre');
    if (t === 'arrive') return 'Megérkeztél';
    if (t === 'roundabout' || t === 'rotary') return 'Hajts be a körforgalomba' + (m.exit ? ' (' + m.exit + '. kijárat)' : '');
    if (t === 'merge') return 'Hajts rá az útra';
    if (t === 'on ramp') return 'Hajts fel az felhajtóra';
    if (t === 'off ramp') return 'Hajts le a lehajtóról';
    if (t === 'fork') return 'Válassz ágat';
    if (t === 'end of road') return 'A út végén ' + dirWord(mod);
    if (t === 'new name') return 'Folytasd az ' + (s.name ? '' : 'új ') + 'úton';
    if (t === 'continue') return mod ? dirWord(mod) : 'Folytasd egyenesen';
    if (t === 'turn') return dirWord(mod);
    return s.name ? 'Haladj tovább ' + s.name + ' irányába' : 'Haladj tovább';
  }

  function dirWord(mod) {
    switch (mod) {
      case 'left': return 'balra kanyarodj';
      case 'right': return 'jobbra kanyarodj';
      case 'sharp left': return 'élesen balra';
      case 'sharp right': return 'élesen jobbra';
      case 'slight left': return 'kicsit balra';
      case 'slight right': return 'kicsit jobbra';
      case 'straight': return 'egyenesen';
      case 'uturn': return 'fordulj vissza';
      default: return 'kanyarodj';
    }
  }

  function stepIcon(maneuver) {
    var t = maneuver && maneuver.type, mod = maneuver && maneuver.modifier;
    if (t === 'arrive') return '⚑';
    if (t === 'depart') return '▶';
    if (t === 'roundabout' || t === 'rotary') return '↻';
    if (mod === 'left' || mod === 'sharp left' || mod === 'slight left') return '←';
    if (mod === 'right' || mod === 'sharp right' || mod === 'slight right') return '→';
    if (mod === 'uturn') return '↶';
    return '↑';
  }

  var routeAbort = null;

  /* --- útvonal: Valhalla (kerékpár / gyalog) + OSRM (autó) --- */

  // Valhalla polyline6 (1e6 pontosságú) dekódoló
  function decodePolyline6(str) {
    var coords = [], index = 0, lat = 0, lng = 0, b, shift, result;
    while (index < str.length) {
      shift = 0; result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : (result >> 1);
      coords.push([lng / 1e6, lat / 1e6]);
    }
    return coords;
  }

  function valhallaStepType(t) {
    if (t === 4 || t === 5 || t === 6) return 'arrive';
    if (t === 1 || t === 2 || t === 3) return 'depart';
    if (t === 26 || t === 27) return 'roundabout';
    if (t === 25) return 'merge';
    if (t === 7) return 'new name';
    if (t === 8 || t === 22) return 'continue';
    return 'turn';
  }

  function valhallaModifier(t) {
    if (t === 9) return 'slight right';
    if (t === 10 || t === 18 || t === 20 || t === 23) return 'right';
    if (t === 11) return 'sharp right';
    if (t === 12 || t === 13) return 'uturn';
    if (t === 14) return 'sharp left';
    if (t === 15 || t === 19 || t === 21 || t === 24) return 'left';
    if (t === 16) return 'slight left';
    return 'straight';
  }

  // a Valhalla manővereit az app saját (OSRM-szerű) lépésformájára hozzuk
  function valhallaSteps(leg, coords) {
    var out = [];
    (leg.maneuvers || []).forEach(function (m) {
      var idx = Math.max(0, Math.min(m.begin_shape_index || 0, coords.length - 1));
      out.push({
        instruction: '',
        name: '',
        distance: (m.length || 0) * 1000,
        maneuver: {
          type: valhallaStepType(m.type),
          modifier: valhallaModifier(m.type),
          location: [coords[idx][0], coords[idx][1]]
        }
      });
    });
    return out;
  }

  function fetchValhallaRoute(me, p, costing, signal) {
    return fetch(VALHALLA, {
      method: 'POST',
      signal: signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locations: [{ lat: me.lat, lon: me.lng }, { lat: p.lat, lon: p.lng }],
        costing: costing,
        directions_options: { units: 'kilometers', language: 'hu-HU' }
      })
    })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var trip = j && j.trip;
        var leg = trip && trip.legs && trip.legs[0];
        if (!leg || !leg.shape) throw new Error('nincs útvonal');
        var coords = decodePolyline6(leg.shape);
        if (coords.length < 2) throw new Error('nincs útvonal');
        var sum = trip.summary || leg.summary || {};
        return {
          distance: sum.length ? sum.length * 1000 : 0,
          duration: sum.time || 0,
          steps: valhallaSteps(leg, coords),
          geometry: { type: 'LineString', coordinates: coords }
        };
      });
  }

  // egységes útvonal-kérés: autó → OSRM, kerékpár/gyalog → Valhalla
  function requestRoute(me, p, mode, signal) {
    if (mode === 'cycling' || mode === 'foot') {
      return fetchValhallaRoute(me, p, mode === 'cycling' ? 'bicycle' : 'pedestrian', signal);
    }
    var url = OSRM + 'driving/' + me.lng + ',' + me.lat + ';' + p.lng + ',' + p.lat +
      '?overview=full&geometries=geojson&steps=true&annotations=false';
    return fetch(url, { signal: signal })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j.routes || !j.routes.length) throw new Error('nincs útvonal');
        var rt = j.routes[0];
        var leg = rt.legs && rt.legs[0];
        return {
          distance: rt.distance,
          duration: rt.duration,
          steps: (leg && leg.steps) || null,
          geometry: rt.geometry
        };
      });
  }

  function startRoute(p, mode, opts) {
    mode = mode || (state.route && state.route.point === p ? state.route.mode : 'driving');

    if (!state.me) {
      askLocation({ route: p.id, navigate: !!(opts && opts.navigate), mode: mode });
      return;
    }

    if (routeAbort) routeAbort.abort();
    routeAbort = new AbortController();

    var me = state.me;
    var routeReq = requestRoute(me, p, mode, routeAbort.signal);

    el.routeCard.hidden = false;
    el.routeName.textContent = p.name;
    el.routeAddr.textContent = addrText(p);
    el.routeDist.textContent = '…';
    el.routeTime.textContent = '…';
    el.routeGo.href = NAV_GOOGLE + p.lat + ',' + p.lng;
    Array.prototype.forEach.call(el.routeModes.children, function (b) {
      b.classList.toggle('is-active', b.dataset.mode === mode);
    });

    state.route = { point: p, mode: mode, geojson: null, dist: null, dur: null, steps: null };
    document.body.classList.add('is-routing');
    selectedId = p.id;
    highlightCard(p.id);
    setSelected(p.id);
    closePopup();
    if (!isMobile()) openPopupFor(p);

    routeReq
      .then(function (rt) {
        state.route.dist = rt.distance;
        state.route.dur = rt.duration;
        state.route.steps = rt.steps || null;
        state.route.geojson = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: rt.geometry, properties: {} }] };

        drawRouteLayer(state.route.geojson);
        el.routeDist.textContent = fmtDist(rt.distance);
        el.routeTime.textContent = fmtDur(rt.duration);
        el.routeSteps.innerHTML = routeStepsHtml(state.route.steps);
        el.routeStepsToggle.hidden = !(state.route.steps && state.route.steps.length > 3);
        el.routeSteps.hidden = true;
        // lépésről lépésre léptető sáv (legalább 2 lépés kell)
        clearStepPreview();
        el.stepNav.hidden = !(state.route.steps && state.route.steps.length > 1);

        if (opts && opts.navigate) { startNavigation(); return; }
        fitRoute(rt.geometry.coordinates, p);
      })
      .catch(function (e) {
        if (e.name === 'AbortError') return;
        // sincs útvonal → egyenes vonal
        var line = [[me.lng, me.lat], [p.lng, p.lat]];
        state.route.geojson = {
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: {} }]
        };
        drawRouteLayer(state.route.geojson);
        var d = dist(me.lat, me.lng, p.lat, p.lng);
        state.route.dist = d;
        el.routeDist.textContent = fmtDist(d);
        el.routeTime.textContent = '–';
        el.routeSteps.innerHTML = '';
        el.routeStepsToggle.hidden = true;
        el.stepNav.hidden = true;
        if (opts && opts.navigate) { startNavigation(); return; }
        fitRoute(line, p);
        toast('Az útvonalszolgáltató nem érhető el — egyenes vonalat rajzoltam');
      });
  }

  function fitRoute(coords, p) {
    if (!coords || coords.length < 2) {
      map.easeTo({ center: [p.lng, p.lat], zoom: 15, duration: 700 });
      return;
    }
    var b = new maplibregl.LngLatBounds();
    coords.forEach(function (c) { b.extend(c); });
    if (state.me) b.extend([state.me.lng, state.me.lat]);
    try {
      map.fitBounds(b, {
        padding: isMobile()
          ? { top: 90, bottom: Math.round(window.innerHeight * 0.55), left: 24, right: 24 }
          : { top: 110, bottom: 110, left: 420, right: 120 },
        duration: 900,
        maxZoom: 15.5
      });
    } catch (e) {
      map.easeTo({ center: [p.lng, p.lat], zoom: 14, duration: 700 });
    }
  }

  function stopRoute() {
    if (nav) stopNavigation();
    state.route = null;
    el.routeCard.hidden = true;
    el.routeSteps.hidden = true;
    el.stepNav.hidden = true;
    clearStepPreview();
    document.body.classList.remove('is-routing');
    drawRouteLayer(null);
  }

  /* ==================== lépésről lépésre kattintható előnézet ==================== */

  // az adott lépésre ugrik a térképen, és odaállítja a lépés-jelölőt
  function previewStep(i) {
    var steps = (state.route && state.route.steps) || [];
    if (!steps.length) return;
    if (i < 0) i = 0;
    if (i > steps.length - 1) i = steps.length - 1;
    stepIdx = i;
    var s = steps[i];
    var loc = s.maneuver && s.maneuver.location;

    // sor kiemelése + görgetés
    Array.prototype.forEach.call(el.routeSteps.children, function (row) {
      row.classList.toggle('is-active', Number(row.dataset.step) === i);
    });
    var act = el.routeSteps.querySelector('.rstep.is-active');
    if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
    if (el.routeSteps.hidden) {
      el.routeSteps.hidden = false;
      el.routeStepsToggle.textContent = 'Lépések elrejtése';
    }

    el.stepLabel.textContent = (i + 1) + ' / ' + steps.length;

    if (!loc) return;
    setStepMarker(loc, stepIcon(s.maneuver));
    try {
      map.easeTo({
        center: loc,
        zoom: Math.max(map.getZoom(), 16),
        duration: REDUCED_MOTION ? 0 : 700
      });
    } catch (e) { }
  }

  // a lépés-jelölő lerakása / áthelyezése (kattintásra vissza az útvonalhoz)
  function setStepMarker(loc, ico) {
    if (!stepMarker) {
      var d = document.createElement('div');
      d.className = 'step-marker';
      d.title = 'Vissza az útvonalhoz';
      d.addEventListener('click', function () {
        if (nav) navStepsClose();
        else { clearStepPreview(); fitRouteTo(); }
      });
      stepMarker = new maplibregl.Marker({ element: d, anchor: 'center' });
    }
    stepMarker.setLngLat(loc).addTo(map);
    stepMarker.getElement().textContent = ico;
  }

  // vissza a teljes útvonal nézetéhez
  function fitRouteTo() {
    if (!state.route || !state.route.geojson) return;
    var f = state.route.geojson.features[0];
    if (f && f.geometry) fitRoute(f.geometry.coordinates, state.route.point);
  }

  function clearStepPreview() {
    stepIdx = -1;
    if (stepMarker) { stepMarker.remove(); stepMarker = null; }
    Array.prototype.forEach.call(el.routeSteps.children, function (row) {
      row.classList.remove('is-active');
    });
    Array.prototype.forEach.call(el.navStepsList.children, function (row) {
      row.classList.remove('is-active');
    });
    el.stepLabel.textContent = '– / –';
  }

  /* ==================== navigáció: kattintható lépéslista ==================== */

  function navStepsHighlight(i) {
    Array.prototype.forEach.call(el.navStepsList.children, function (row) {
      row.classList.toggle('is-active', Number(row.dataset.step) === i);
    });
  }

  // a lépéslista kinyitása navigáció közben
  function openNavSteps() {
    if (!nav || !state.route || !state.route.steps || !state.route.steps.length) {
      toast('Nincsenek lépések ehhez az útvonalhoz');
      return;
    }
    el.navStepsList.innerHTML = routeStepsHtml(state.route.steps);
    el.navStepsPanel.hidden = false;
    el.navStepsBtn.classList.add('is-active');
    document.body.classList.add('is-navsteps');   // a HUD-kártyák a lista mellett maradjanak
    navStepsHighlight(nav.stepIdx);
    var act = el.navStepsList.querySelector('.rstep.is-active');
    if (act && act.scrollIntoView) act.scrollIntoView({ block: 'center' });
  }

  // egy lépés előnézete navigáció közben (a GPS-et addig nem követi a kamera)
  function navStepPreview(i) {
    var steps = (state.route && state.route.steps) || [];
    if (!steps.length) return;
    if (i < 0) i = 0;
    if (i > steps.length - 1) i = steps.length - 1;
    stepIdx = i;
    navStepsHighlight(i);
    var row = el.navStepsList.querySelector('.rstep.is-active');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    var s = steps[i];
    var loc = s.maneuver && s.maneuver.location;
    if (!loc) return;
    if (nav) nav.suppressFollow = true;   // ne rángassa vissza a GPS a nézetet
    setStepMarker(loc, stepIcon(s.maneuver));
    try {
      map.easeTo({ center: loc, zoom: Math.max(map.getZoom(), 16), duration: REDUCED_MOTION ? 0 : 700 });
    } catch (e) { }
  }

  // a lista bezárása → vissza a valós idejű követéshez
  function navStepsClose() {
    el.navStepsPanel.hidden = true;
    el.navStepsBtn.classList.remove('is-active');
    document.body.classList.remove('is-navsteps');
    clearStepPreview();
    if (nav) {
      nav.suppressFollow = false;
      nav.lastFollow = 0;             // azonnal ugorjon vissza a saját pozícióra
      if (state.me) navUpdate(state.me);
    }
  }

  /* ==================== appon belüli turn-by-turn navigáció ==================== */

  function navIconHtml(maneuver) {
    var t = maneuver && maneuver.type, mod = maneuver && maneuver.modifier;
    if (t === 'arrive') {
      return '<svg viewBox="0 0 24 24" width="42" height="42"><path d="M6 3h12v18l-6-4-6 4z" fill="currentColor"/></svg>';
    }
    if (t === 'roundabout' || t === 'rotary') {
      return '<svg viewBox="0 0 24 24" width="42" height="42">' +
        '<path d="M12 5a7 7 0 1 0 7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>' +
        '<path d="M12 1.5 16 5l-4 3.5z" fill="currentColor"/></svg>';
    }
    if (mod === 'uturn') {
      return '<svg viewBox="0 0 24 24" width="42" height="42">' +
        '<path d="M8 21V10a4 4 0 0 1 8 0v7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>' +
        '<path d="M19 13.5 16 18l-3-4.5z" fill="currentColor"/></svg>';
    }
    var rot = 0;
    if (mod === 'left' || mod === 'sharp left') rot = -90;
    else if (mod === 'right' || mod === 'sharp right') rot = 90;
    else if (mod === 'slight left') rot = -40;
    else if (mod === 'slight right') rot = 40;
    return '<svg viewBox="0 0 24 24" width="42" height="42" style="transform:rotate(' + rot + 'deg)">' +
      '<path d="M12 3 4 12h4v8h8v-8h4z" fill="currentColor" transform="rotate(180 12 12)"/></svg>';
  }

  function nearestIndexOnLine(line, loc) {
    var best = 0, bd = Infinity;
    for (var i = 0; i < line.length; i++) {
      var d = dist(loc[1], loc[0], line[i][1], line[i][0]);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  function startNavigation() {
    var r = state.route;
    if (!r || !r.geojson || !r.geojson.features || !r.geojson.features.length) {
      toast('Előbb számítsd ki az útvonalat');
      return;
    }
    var line = r.geojson.features[0].geometry.coordinates;
    if (!line || line.length < 2) { toast('Nincs meg az útvonal'); return; }

    // kumulatív távolságok a vonalon (m)
    var cum = [0];
    for (var i = 1; i < line.length; i++) {
      cum.push(cum[i - 1] + (dist(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0]) || 0));
    }

    // a lépések kezdőpontjai a fő vonalon (index)
    var stepStarts = [];
    var steps = r.steps || [];
    var lastStart = -1;
    steps.forEach(function (s) {
      var loc = s.maneuver && s.maneuver.location;
      var idx = loc ? nearestIndexOnLine(line, loc) : 0;
      if (idx <= lastStart) idx = Math.min(line.length - 1, lastStart + 1);
      lastStart = idx;
      stepStarts.push(idx);
    });

    nav = {
      line: line,
      cum: cum,
      total: cum[cum.length - 1] || 1,
      stepStarts: stepStarts,
      stepIdx: -1,
      arrived: false,
      simPos: 0,
      lastFollow: 0,
      suppressFollow: false
    };

    el.navView.hidden = false;
    el.navNext.hidden = true;
    document.body.classList.add('is-nav');
    closePopup();   // a HUD ne takarjon alatta kibukkanó pontkártyát
    clearStepPreview();  // lépés-előnézet jelölője ne maradjon a térképen
    recordVisit(state.route && state.route.point ? state.route.point.id : null);
    startWatch();
    if (state.me) navUpdate(state.me);
    else toast('Kövesd a nyilakat — a helyzeted frissítése folyamatban');
  }

  function stopNavigation() {
    nav = null;
    el.navView.hidden = true;
    el.arrive.hidden = true;
    el.navNext.hidden = true;
    el.navStepsPanel.hidden = true;
    el.navStepsBtn.classList.remove('is-active');
    document.body.classList.remove('is-navsteps');
    clearStepPreview();
    document.body.classList.remove('is-nav');
    if (state.route && state.route.geojson && state.route.geojson.features.length) {
      fitRoute(state.route.geojson.features[0].geometry.coordinates, state.route.point);
    }
  }

  function navArrived() {
    if (!nav || nav.arrived) return;
    nav.arrived = true;
    el.navStepsPanel.hidden = true;
    el.navStepsBtn.classList.remove('is-active');
    document.body.classList.remove('is-navsteps');
    clearStepPreview();
    el.arriveName.textContent = state.route ? state.route.point.name : '';
    el.arrive.hidden = false;
    document.body.classList.remove('is-nav');
    if (state.route) {
      map.easeTo({ center: [state.route.point.lng, state.route.point.lat], zoom: 17, duration: 900 });
    }
  }

  function navUpdate(me) {
    if (!nav || nav.arrived || !me) return;
    var pos = nearestOnPolyline(me.lat, me.lng, nav.line);
    var remainAlong = Math.max(0, nav.total - pos.along);
    var steps = (state.route && state.route.steps) || [];

    // következő manőver keresése
    var stepIdx = steps.length;
    for (var i = 0; i < nav.stepStarts.length; i++) {
      if (nav.stepStarts[i] > pos.idx) { stepIdx = i; break; }
    }

    if (remainAlong < 20 || stepIdx >= steps.length) { navArrived(); return; }

    var step = steps[stepIdx];
    var toManeuver = Math.max(0, (nav.cum[nav.stepStarts[stepIdx]] || nav.total) - pos.along);

    // HUD frissítése csak akkor, ha lényegesen változott
    if (nav.stepIdx !== stepIdx) {
      nav.stepIdx = stepIdx;
      el.navArrow.innerHTML = navIconHtml(step.maneuver);
      var label = stepText(step);
      if (step.name && label.toLowerCase().indexOf(String(step.name).toLowerCase()) === -1) {
        label += ' · ' + step.name;
      }
      el.navStreet.textContent = label;

      // következő lépés előnézete
      var nxt = steps[stepIdx + 1];
      if (nxt) {
        var nl = stepText(nxt);
        if (nxt.name && nl.toLowerCase().indexOf(String(nxt.name).toLowerCase()) === -1) nl += ' · ' + nxt.name;
        el.navNext.innerHTML = '<span class="nav-next-ico">' + stepIcon(nxt.maneuver) + '</span>' +
          '<span>Majd: ' + esc(nl) + '</span>';
        el.navNext.hidden = false;
      } else {
        el.navNext.hidden = true;
      }
    }

    el.navDist.textContent = fmtDist(toManeuver);
    el.navRemain.textContent = fmtDist(remainAlong);
    el.navTotal.textContent = fmtDist(nav.total);
    if (state.route && state.route.dur) {
      el.navEta.textContent = fmtEta(remainAlong / nav.total * state.route.dur);
    } else {
      el.navEta.textContent = '–';
    }

    // térkép követése: irányba fordulva, emelt nézettel (Waze-szerű)
    if (nav.suppressFollow) return;
    var moved = nav.lastFollowLat == null || dist(me.lat, me.lng, nav.lastFollowLat, nav.lastFollowLng) > 9;
    var now = Date.now();
    if (!moved && now - nav.lastFollow < 1400) return;
    nav.lastFollow = now;
    nav.lastFollowLat = me.lat;
    nav.lastFollowLng = me.lng;

    var ahead = pointAtDistance(nav, Math.min(nav.total, pos.along + 70));
    var head = bearing(me.lat, me.lng, ahead[1], ahead[0]);
    try {
      map.easeTo({
        center: [me.lng, me.lat],
        zoom: map.getZoom() < 15 ? 16.2 : Math.max(map.getZoom(), 16.2),
        bearing: head,
        pitch: 52,
        duration: 950
      });
    } catch (e) { }
  }

  // a következő manőver előnézete (nem követ tovább néhány másodpercig)
  function navPreviewNext() {
    if (!nav) return;
    var steps = (state.route && state.route.steps) || [];
    var idx = nav.stepIdx + 1;
    if (idx >= steps.length) { toast('Ez az utolsó lépés'); return; }
    var loc = steps[idx].maneuver && steps[idx].maneuver.location;
    if (!loc) return;
    nav.suppressFollow = true;
    try {
      map.easeTo({ center: loc, zoom: 16.5, duration: 750 });
    } catch (e) { }
    clearTimeout(navPreviewNext._t);
    navPreviewNext._t = setTimeout(function () { if (nav) nav.suppressFollow = false; }, 3800);
  }

  // GPS nélküli demó: a vonal mentén „sétál" (teszteléshez / asztali előnézet)
  function navSimulate(step) {
    if (!nav) return null;
    nav.simPos = Math.min(nav.total, nav.simPos + (step == null ? 35 : step));
    var pt = pointAtDistance(nav, nav.simPos);
    navUpdate({ lat: pt[1], lng: pt[0] });
    return { pos: nav.simPos, total: nav.total, stepIdx: nav.stepIdx, arrived: nav.arrived };
  }

  /* ==================== betöltő, alap dolgok ==================== */

  function maybeHideLoader() {
    if (!ready.data || !ready.style) return;
    if (pendingPlace) { var fn = pendingPlace; pendingPlace = null; fn(); }
    el.loader.classList.add('is-done');
    setTimeout(function () { el.loader.style.display = 'none'; }, 500);
  }

  /* ==================== szűrés, lista ==================== */

  function applyFilters() {
    var terms = stripAcc(state.query.trim()).split(/\s+/).filter(Boolean);
    var now = new Date();
    var store = loadFbStore();

    var list = state.points.filter(function (p) {
      if (state.filter === 'automata' && p.type !== 'automata') return false;
      if (state.filter === 'kezi' && p.type !== 'kezi') return false;
      if (state.filter === 'open') {
        var st = statusOf(p, now);
        if (st !== 'open' && st !== 'soon') return false;
      }
      if (state.filter === 'rated' && !store[p.id]) return false;
      if (state.filter === 'fav' && !isFav(p.id)) return false;
      for (var i = 0; i < terms.length; i++) {
        if (p._hay.indexOf(terms[i]) === -1) return false;
      }
      return true;
    });

    if (state.me) {
      list.forEach(function (p) { p._d = dist(state.me.lat, state.me.lng, p.lat, p.lng); });
    }

    if (state.sort === 'rating') {
      list.sort(function (a, b) {
        var ka = communityOf(a.id), kb = communityOf(b.id);
        var ra = store[a.id] ? store[a.id].score : (ka ? ka.avg : -1);
        var rb = store[b.id] ? store[b.id].score : (kb ? kb.avg : -1);
        if (rb !== ra) return rb - ra;
        return (a._d || 1e12) - (b._d || 1e12);
      });
    } else if (state.me) {
      list.sort(function (a, b) { return a._d - b._d; });
    }

    // az első három (távolság szerint) kap sorszámot a térképen
    var byDist = list.slice();
    if (state.me) byDist.sort(function (a, b) { return (a._d || 1e12) - (b._d || 1e12); });
    state.points.forEach(function (p) { p._rank = 0; });
    byDist.slice(0, 3).forEach(function (p, i) { p._rank = i + 1; });

    state.filtered = list;
    render(store);
  }

  function render(store) {
    var now = new Date();
    store = store || loadFbStore();
    el.resultsCount.textContent = state.filtered.length.toLocaleString('hu-HU') + ' pont';

    if (state.filter === 'open') el.resultsLabel.textContent = 'Most nyitva';
    else if (state.filter === 'automata') el.resultsLabel.textContent = 'Automaták';
    else if (state.filter === 'kezi') el.resultsLabel.textContent = 'Kézi pontok';
    else if (state.filter === 'rated') el.resultsLabel.textContent = 'Értékelt pontok';
    else if (state.filter === 'fav') el.resultsLabel.textContent = 'Kedvencek';
    else el.resultsLabel.textContent = state.me ? 'Legközelebbi pontok' : 'Minden pont';

    var top = state.filtered.slice(0, 80);
    if (!top.length) {
      el.results.innerHTML = '<div class="empty">' +
        (state.filter === 'rated'
          ? 'Még nem értékeltél egy pontot sem.<br>Nyiss meg egy REpontot, és osztályozd 1–10-ig.'
          : (state.filter === 'fav'
            ? 'Még nincs kedvenc pontod.<br>Koppints a kártyán a ★ jelre, és itt megtalálod.'
            : 'Nincs ilyen találat.<br>Próbálj másik települést vagy címet.')) +
        '</div>';
    } else {
      el.results.innerHTML = top.map(function (p, i) { return cardHtml(p, now, i, store[p.id]); }).join('') +
        (state.filtered.length > 80
          ? '<div class="empty" style="padding:18px 24px">…és további ' + (state.filtered.length - 80) +
            ' pont. Szűkíts a kereséssel vagy nagyíts a térképre.</div>'
          : '');
    }

    setPoints(state.filtered);
    renderQbar(now);
  }

  function cardHtml(p, now, i, rating) {
    var st = statusOf(p, now);
    var sc = rating ? rating.score : null;
    // a pont színe a saját értékelésed alapján (Budicheck-stílus)
    var dotStyle = sc == null ? '' :
      ';background:' + (sc >= 9 ? '#D8E02F' : (sc >= 7 ? '#F16524' : '#DA1E28')) +
      ';box-shadow:0 0 0 4px rgba(255,255,255,.06),0 0 14px ' + (sc >= 9 ? '#D8E02F' : (sc >= 7 ? '#F16524' : '#DA1E28'));
    return '<button class="card' + (p.id === selectedId ? ' is-sel' : '') + '" data-id="' + p.id +
      '" role="listitem" style="--i:' + Math.min(i || 0, 14) + '">' +
      (p._rank ? '<span class="card-rank">#' + p._rank + ' LEGKÖZELEBB</span>' : '') +
      '<span class="card-dot ' + p.type + '"' + (dotStyle ? ' style="' + dotStyle + '"' : '') + '></span>' +
      '<span class="card-main">' +
        '<span class="card-name">' + esc(p.name) + '</span>' +
        '<span class="card-sub">' + esc(addrText(p)) + '</span>' +
        '<span class="card-meta">' + openPill(st) +
          '<span class="tag ' + p.type + '">' + (p.type === 'automata' ? 'Automata' : 'Kézi') + '</span>' +
          (rating
            ? '<span class="score ' + scoreClass(sc) + ' score-xs">' + sc + '</span>'
            : communityBadgeHtml(p.id)) +
          reportChipHtml(p.id) +
        '</span>' +
      '</span>' +
      (p._d != null
        ? '<span class="card-dist">' + fmtDist(p._d) + '<small>tőled</small></span>'
        : '') +
      '<span class="card-fav' + (isFav(p.id) ? ' is-on' : '') + '" role="button" tabindex="0" data-fav="' + p.id +
        '" aria-label="' + (isFav(p.id) ? 'Eltávolítás a kedvencekből' : 'Hozzáadás a kedvencekhez') + '">★</span>' +
      '<span class="card-route">ÚTVONAL →</span>' +
    '</button>';
  }

  function renderQbar(now) {
    if (!state.me || !state.filtered.length) { el.qbar.hidden = true; return; }
    var top = state.filtered.filter(function (p) { return p._d != null; }).slice(0, 2);
    if (!top.length) { el.qbar.hidden = true; return; }
    el.qbar.hidden = false;
    el.qbarList.innerHTML = top.map(function (p) {
      return '<button class="qbar-item" data-id="' + p.id + '">' +
        scoreBadge(scoreOf(p.id)) +
        '<span class="qbar-text">' +
          '<b>' + esc(p.name) + '</b>' +
          '<small>' + fmtDist(p._d) + '<span class="qbar-city"> · ' + esc(p.city || addrText(p)) + '</span></small>' +
        '</span>' +
      '</button>';
    }).join('');

    // a nagy lime gomb rögtön navigál a legközelebbi ponthoz
    el.qbarGo.onclick = function () { startRoute(top[0], null, { navigate: true }); };
  }

  function highlightCard(id) {
    Array.prototype.forEach.call(el.results.querySelectorAll('.card'), function (c) {
      c.classList.toggle('is-sel', +c.dataset.id === id);
    });
  }

  /* ==================== kiválasztás, részletek ==================== */

  function select(id, opts) {
    opts = opts || {};
    var p = state.byId.get(id);
    if (!p) return;
    selectedId = id;
    highlightCard(id);
    setSelected(id);
    loadFbIntoUI(id);
    refreshSheetRate();
    try { history.replaceState(null, '', '#pont/' + id); } catch (e) { }

    if (opts.fromMap) {
      if (isMobile()) openSheet(p); else openPopupFor(p);
      return;
    }

    if (isMobile()) { setSearchOpen(false); setDock('dockMap'); }
    map.easeTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 14), duration: 750 });
    if (!isMobile()) openPopupFor(p);
    openSheet(p);
  }

  function openSheet(p) {
    var now = new Date();
    var st = statusOf(p, now);

    el.sheetType.textContent = p.type === 'automata' ? 'AUTOMATA' : 'KÉZI GYŰJTÉS';
    el.sheetType.className = 'sheet-type ' + p.type;
    el.sheetName.textContent = p.name;
    el.sheetAddr.textContent = addrText(p) + (p.zip && addrText(p).indexOf(p.zip) === -1 ? ' · ' + p.zip : '');
    el.sheetDist.textContent = p._d != null ? fmtDist(p._d) + ' tőled' : '';
    refreshSheetFav();
    refreshSheetSocial();
    refreshSheetRate();
    closeShare();
    setHoursOpen(false);
    setReportsOpen(false);
    loadPointReviews(p.id);

    var hrs = hoursOf(p);
    var today = now.getDay();
    paintSheetStatus(st, hrs, today, now);

    var order = [1, 2, 3, 4, 5, 6, 0];
    var names = { 1: 'Hétfő', 2: 'Kedd', 3: 'Szerda', 4: 'Csütörtök', 5: 'Péntek', 6: 'Szombat', 0: 'Vasárnap' };
    el.sheetHours.innerHTML = order.map(function (d) {
      var r = dayRange(hrs, d);
      var txt = r ? esc(r.text) : 'Zárva';
      return '<tr' + (d === today ? ' class="is-today"' : '') + '><th>' + names[d] + '</th>' +
        '<td' + (r ? '' : ' class="closed"') + '>' + txt + '</td></tr>';
    }).join('');
    el.hoursBlock.classList.remove('is-open');
    el.hoursToggle.setAttribute('aria-expanded', 'false');
    el.hoursToggle.textContent = 'Teljes nyitvatartás';

    el.sheetRoute.onclick = function () { closeSheet(); startRoute(p, null); };
    el.copyAddr.onclick = function () {
      var addr = addrText(p);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(addr)
          .then(function () { toast('Cím a vágólapra másolva'); })
          .catch(function () { toast('Nem sikerült másolni'); });
      } else {
        toast('A másolás nem támogatott ebben a böngészőben');
      }
    };

    if (el.sheetShare) el.sheetShare.onclick = function () { openShare(p.id); };
    if (el.sheetSharePc) el.sheetSharePc.onclick = function () { openShare(p.id); };

    if (sheetCloseTimer) {
      clearTimeout(sheetCloseTimer);
      sheetCloseTimer = null;
    }
    el.sheet.classList.remove('is-closing');
    el.sheetScrim.classList.remove('is-closing');
    el.sheet.hidden = false;
    el.sheetScrim.hidden = false;
    el.sheet.scrollTop = 0;
    setHeroMapLive(false);
    paintSheetMiniMap(p);
  }

  // nagy státuszsor: „Ma 9:00 - 20:00” + állapot + vékony lime sáv
  function paintSheetStatus(st, hrs, day, now) {
    var mins = now.getHours() * 60 + now.getMinutes();
    var r = dayRange(hrs, day);
    var txt, sub, fill = 0;

    if (r) {
      txt = 'Ma ' + r.text;
      if (st === 'open' || st === 'soon') {
        var left = leftText(r.close - mins);
        sub = st === 'soon' ? ('Hamarosan zár · ' + left + ' van hátra') : ('Nyitva · ' + left + ' múlva zár');
        fill = Math.max(3, Math.min(100, ((r.close - mins) / Math.max(1, r.close - r.open)) * 100));
      } else {
        sub = 'Zárva most';
        var nx = nextOpenText(hrs, day, mins);
        if (nx) sub += ' · ' + nx;
      }
    } else if (hrs) {
      txt = 'Ma zárva';
      sub = nextOpenText(hrs, day, mins) || 'Ma már nem nyit ki';
    } else {
      txt = 'Nincs adat';
      sub = 'Erre a pontra nincs nyitvatartás megadva';
    }

    el.sheetStatusBox.className = 'sheet-status ' +
      (st === 'open' ? 'is-open' : (st === 'soon' ? 'is-soon' : (st === 'closed' ? 'is-closed' : 'is-unknown')));
    el.sheetStatusText.textContent = txt;
    el.sheetStatusSub.textContent = sub;
    el.sheetStatusBar.style.setProperty('--fill', Math.round(fill) + '%');
  }

  // mini térkép-előnézet a lapka fejlécében (egyszer jön létre, utána csak ugrik)
  var miniMap = null;

  function paintSheetMiniMap(p) {
    if (!el.sheetMini || typeof maplibregl.Map !== 'function') return;
    if (!miniMap) {
      miniMap = new maplibregl.Map({
        container: el.sheetMini,
        style: MAP_STYLE,
        center: [p.lng, p.lat],
        zoom: 16.2,
        interactive: false,
        attributionControl: false,
        renderWorldCopies: false
      });
    } else {
      miniMap.jumpTo({ center: [p.lng, p.lat], zoom: 16.2 });
    }
    setTimeout(function () { if (miniMap) miniMap.resize(); }, 90);
  }

  // a fejléc-térkép csak koppintásra válik mozgathatóvá (mint egy beágyazott térkép)
  function setHeroMapLive(on) {
    if (!el.sheetHero) return;
    if (!miniMap) on = false;
    if (on) {
      miniMap.dragPan.enable();
      miniMap.touchZoomRotate.enable();
      miniMap.doubleClickZoom.enable();
    } else if (miniMap) {
      miniMap.dragPan.disable();
      miniMap.touchZoomRotate.disable();
      miniMap.doubleClickZoom.disable();
    }
    el.sheetHero.classList.toggle('is-map-live', !!on);
    if (el.sheetMapHint) {
      el.sheetMapHint.textContent = on ? 'Húzd a térképet · koppints ide a kikapcsoláshoz' : 'Koppints a térképhez';
    }
  }

  // üzemállapot-jelző popover
  function setReportsOpen(on) {
    if (el.reportsPop) el.reportsPop.classList.toggle('is-open', !!on);
    if (el.reportFig) {
      el.reportFig.classList.toggle('is-open', !!on);
      el.reportFig.setAttribute('aria-expanded', on ? 'true' : 'false');
    }
  }

  function toggleReportsOpen() {
    if (!el.reportsPop) return;
    setReportsOpen(!el.reportsPop.classList.contains('is-open'));
  }

  var sheetCloseTimer = null;

  function closeSheet() {
    if (el.sheet.hidden || sheetCloseTimer) return;
    closeShare();
    setHoursOpen(false);
    setReportsOpen(false);
    setHeroMapLive(false);
    el.sheet.classList.add('is-closing');
    el.sheetScrim.classList.add('is-closing');
    sheetCloseTimer = setTimeout(function () {
      sheetCloseTimer = null;
      el.sheet.hidden = true;
      el.sheetScrim.hidden = true;
      el.sheet.classList.remove('is-closing');
      el.sheetScrim.classList.remove('is-closing');
    }, 270);
  }

  /* ==================== ranglista / profil ==================== */

  function openOverlay(kind) {
    overlayKind = kind;
    var store = loadFbStore();
    var ids = Object.keys(store);

    if (kind === 'top') {
      el.overlayEyebrow.textContent = 'Ranglista';
      el.overlayTitle.textContent = 'Legjobbra értékelt REpontok';
      if (!ids.length) {
        el.overlayBody.innerHTML = '<div class="overlay-empty">Még nincs értékelésed.<br>' +
          'Nyiss meg egy REpontot a térképen, és osztályozd 1–10-ig.</div>';
      } else {
        var rows = ids.map(function (id) {
          var p = state.byId.get(+id);
          return p ? { p: p, d: store[id] } : null;
        }).filter(Boolean);
        rows.sort(function (a, b) {
          if (b.d.score !== a.d.score) return b.d.score - a.d.score;
          return (b.d.at || 0) - (a.d.at || 0);
        });
        el.overlayBody.innerHTML = rows.slice(0, 12).map(function (r, i) {
          return '<div class="rank-row" data-id="' + r.p.id + '">' +
            '<span class="rank-pos">' + (i + 1) + '.</span>' +
            scoreBadge(r.d.score) +
            '<span class="rank-main"><b>' + esc(r.p.name) + '</b>' +
            '<small>' + esc(r.p.city || addrText(r.p)) +
            (r.p._d != null ? ' · ' + fmtDist(r.p._d) + ' tőled' : '') + '</small></span>' +
          '</div>';
        }).join('');
      }
    } else if (kind === 'friends') {
      el.overlayEyebrow.textContent = 'Közösség';
      el.overlayTitle.textContent = 'Barátok';
      renderFriendsView();
    } else {
      el.overlayEyebrow.textContent = 'Profil';
      el.overlayTitle.textContent = 'Profilom';
      el.overlayBody.innerHTML = profileHtml();
      profileRefresh();   // megye-tábla / fióklátogatások betöltése után újrarajzolás
    }

    if (kind === 'profile') {
      var headWrap = document.createElement('div');
      headWrap.innerHTML = accountHeadHtml();
      el.overlayBody.insertBefore(headWrap.firstChild, el.overlayBody.firstChild);
      var actWrap = document.createElement('div');
      actWrap.innerHTML = accountActionsHtml();
      while (actWrap.firstChild) el.overlayBody.appendChild(actWrap.firstChild);
    }

    el.overlay.hidden = false;
    document.body.classList.add('is-page');
  }

  function closeOverlay() {
    overlayKind = null;
    el.overlay.hidden = true;
    document.body.classList.remove('is-page');
  }

  /* ==================== geolokáció ==================== */

  var pendingRoute = null;   // { id, navigate }

  function askLocation(req) {
    if (!navigator.geolocation) {
      toast('A böngésződ nem támogatja a helymeghatározást');
      return;
    }
    var why = 'locate';
    if (req && req.route != null) { pendingRoute = { id: req.route, navigate: !!req.navigate, mode: req.mode || null }; why = 'route'; }
    else if (req && req.sos) why = 'sos';

    el.locateBtn.disabled = true;
    navigator.geolocation.getCurrentPosition(function (pos) {
      el.locateBtn.disabled = false;
      setMe(pos.coords.latitude, pos.coords.longitude, why);
    }, function (err) {
      el.locateBtn.disabled = false;
      pendingRoute = null;
      toast(err.code === 1 ? 'A helymeghatározást megtagadtad' : 'Nem sikerült meghatározni a pozíciód');
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  }

  function meDot() {
    var d = document.createElement('div');
    d.className = 'me-dot';
    return d;
  }

  function setMe(lat, lng, why) {
    state.me = { lat: lat, lng: lng };
    state.points.forEach(function (p) { p._d = dist(lat, lng, p.lat, p.lng); });

    if (why !== 'sos' && why !== 'route') { applyFilters(); }

    var place = function () {
      if (meMarker) meMarker.remove();
      meMarker = new maplibregl.Marker({ element: meDot(), anchor: 'center' })
        .setLngLat([lng, lat])
        .addTo(map);

      if (why === 'sos') { startSos(); return; }

      if (why === 'route') {
        applyFilters();
        var pr = pendingRoute;
        pendingRoute = null;
        var p = pr ? state.byId.get(pr.id) : null;
        if (p) { startRoute(p, pr.mode || null, { navigate: pr.navigate }); return; }
      }

      applyFilters();
      map.easeTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 12), duration: 750 });
      toast('A távolságokat a helyzetedhez rendeztük');
    };

    // a stílus már betöltődött → rögtön; különben az onStyleLoad hívja
    if (ready.style || map.isStyleLoaded()) place();
    else pendingPlace = place;
  }

  function startWatch() {
    if (state.watchId != null || !navigator.geolocation) return;
    state.watchId = navigator.geolocation.watchPosition(function (pos) {
      state.me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (meMarker) meMarker.setLngLat([state.me.lng, state.me.lat]);
      state.points.forEach(function (p) { p._d = dist(state.me.lat, state.me.lng, p.lat, p.lng); });
      if (!el.sosView.hidden) showSos();
      if (nav) navUpdate(state.me);
      renderQbar(new Date());
    }, function () { }, { enableHighAccuracy: true, maximumAge: 8000 });
  }

  /* ==================== SOS ==================== */

  function startSos() {
    if (!state.me) { askLocation({ sos: true }); return; }
    var now = new Date();
    var open = state.points.filter(function (p) {
      var st = statusOf(p, now);
      return st === 'open' || st === 'soon';
    });
    if (!open.length) { toast('Jelenleg egy nyitott pont sincs az országban'); return; }

    open.sort(function (a, b) { return a._d - b._d; });
    state.sosList = open.slice(0, 6);
    state.sosIndex = 0;
    el.sosView.hidden = false;
    el.sosBtn.classList.add('is-active');
    el.sosBtn.setAttribute('aria-pressed', 'true');
    document.body.classList.add('is-sos');
    map.easeTo({ center: [state.me.lng, state.me.lat], zoom: 13, duration: 750 });
    showSos();
    startWatch();
  }

  function stopSos() {
    el.sosView.hidden = true;
    document.body.classList.remove('is-sos');
    el.sosBtn.classList.remove('is-active');
    el.sosBtn.setAttribute('aria-pressed', 'false');
    // a figyelést csak akkor állítjuk le, ha nincs aktív navigáció
    if (state.watchId != null && !nav) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
    }
  }

  function showSos() {
    var p = state.sosList[state.sosIndex];
    if (!p) { stopSos(); return; }
    if (p._d == null) p._d = dist(state.me.lat, state.me.lng, p.lat, p.lng);

    var b = bearing(state.me.lat, state.me.lng, p.lat, p.lng);
    el.sosArrow.style.transform = 'rotate(' + b.toFixed(1) + 'deg)';
    el.sosDist.textContent = fmtDist(p._d);
    el.sosName.textContent = p.name;
    el.sosAddr.textContent = addrText(p);
    el.sosBadge.textContent = 'NYITVA · ' + (state.sosIndex + 1) + '/' + state.sosList.length;
    el.sosBadge.classList.remove('no');

    // Indulás → az appon belül indul a turn-by-turn navigáció
    el.sosGo.onclick = function () {
      stopSos();
      startRoute(p, 'driving', { navigate: true });
    };
    el.sosDetail.onclick = function () { stopSos(); select(p.id, {}); };

    // további nyitott pontok listája
    el.sosMoreList.innerHTML = state.sosList.map(function (q, i) {
      if (i === state.sosIndex) return '';
      if (q._d == null) q._d = dist(state.me.lat, state.me.lng, q.lat, q.lng);
      return '<button class="sos-more-item" data-i="' + i + '">' +
        scoreBadge(scoreOf(q.id)) +
        '<span class="sos-more-main"><b>' + esc(q.name) + '</b>' +
        '<small>' + esc(addrText(q)) + '</small></span>' +
        '<span class="sos-more-dist">' + fmtDist(q._d) + '</span>' +
      '</button>';
    }).join('') || '<div class="overlay-empty" style="padding:12px">Nincs több nyitott pont a közelben.</div>';

    selectedId = p.id;
    setSelected(p.id);
    highlightCard(p.id);
  }

  /* ==================== helyszín-javaslatok ==================== */

  var sugAbort = null;
  var fetchSuggest = debounce(async function (q) {
    if (sugAbort) sugAbort.abort();
    if (q.length < 3) { hideSuggest(); return; }
    sugAbort = new AbortController();
    try {
      var res = await fetch('https://photon.komoot.io/api/?q=' + encodeURIComponent(q) + '&limit=6',
        { signal: sugAbort.signal });
      if (!res.ok) throw new Error(res.status);
      var json = await res.json();
      var items = (json.features || []).map(function (f) {
        var c = f.geometry.coordinates, pr = f.properties || {};
        var main = pr.name || pr.street || pr.city || q;
        var sub = [pr.street, pr.city || pr.locality, pr.state, pr.country].filter(Boolean).join(', ');
        return { lat: c[1], lng: c[0], main: main, sub: sub };
      });
      showSuggest(items);
    } catch (e) {
      if (e.name !== 'AbortError') hideSuggest();
    }
  }, 320);

  function showSuggest(items) {
    if (!items.length) { hideSuggest(); return; }
    el.searchSuggest.innerHTML = items.map(function (it, i) {
      return '<button type="button" data-i="' + i + '">' + esc(it.main) +
        (it.sub ? '<span class="sub">' + esc(it.sub) + '</span>' : '') + '</button>';
    }).join('');
    el.searchSuggest._items = items;
    el.searchSuggest.hidden = false;
  }

  function hideSuggest() {
    el.searchSuggest.hidden = true;
    el.searchSuggest.innerHTML = '';
  }

  /* ==================== adat ==================== */

  async function loadData() {
    try {
      var res = await fetch('data/repontok.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var points = await res.json();
      state.points = points;
      state.byId.clear();
      state.points.forEach(function (p) {
        p._hay = stripAcc([p.name, p.address, p.city, p.zip].filter(Boolean).join(' '));
        state.byId.set(p.id, p);
      });
      ready.data = true;
      renderRecent();
      refreshSocial();
      maybeHideLoader();
      applyFilters();
      loadMeta();
      // a profil látogatás/kedvenc/sorozat szekciói pontok nélkül üresek maradnának
      if (overlayKind === 'profile') openOverlay('profile');
      var pos = positionFromHash();
      if (pos) setMe(pos.lat, pos.lng, null);
      openPointFromHash();
      setTimeout(maybeIntro, 700);
    } catch (e) {
      var p = el.loader.querySelector('p');
      if (p) p.innerHTML = 'Nem sikerült betölteni az adatokat.<br>Generáld le: <b>node tools/fetch-data.mjs</b>';
    }
  }

  function positionFromHash() {
    var m = (location.hash || '').match(/^#(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/);
    if (!m) return null;
    var lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    return (isFinite(lat) && isFinite(lng)) ? { lat: lat, lng: lng } : null;
  }

  function pointFromHash() {
    var m = (location.hash || '').match(/^#pont\/(\d+)$/);
    return m ? +m[1] : null;
  }

  function openPointFromHash() {
    var id = pointFromHash();
    if (id == null || !ready.data || !state.byId.has(id)) return;
    if (selectedId === id && el.sheet && !el.sheet.hidden) return;
    select(id, {});
  }

  async function loadMeta() {
    try {
      var res = await fetch('data/repontok-meta.json', { cache: 'no-cache' });
      if (!res.ok) return;
      var m = await res.json();
      el.statAll.textContent  = (m.total || 0).toLocaleString('hu-HU');
      el.statAuto.textContent = (m.automata || 0).toLocaleString('hu-HU');
      el.statKezi.textContent = (m.kezi || 0).toLocaleString('hu-HU');
    } catch (e) { }
  }

  // A menü helye: telefon/tablet (<= 900px) -> alsó lebegő sáv (SOS-sel együtt), PC -> fejléc
  function placeDock() {
    var stage = document.querySelector('.stage');
    var topbar = document.querySelector('.topbar');
    var stats = document.getElementById('topStats');
    var sos = el.sosBtn;
    if (!stage || !topbar || !el.dock || !sos) return;
    if (isMobile()) {
      if (el.dock.parentNode !== stage) stage.appendChild(el.dock);
      var row = document.querySelector('.float-row');
      if (row && sos.parentNode !== row) row.insertBefore(sos, row.firstChild);
    } else {
      if (el.dock.parentNode !== topbar) topbar.insertBefore(el.dock, stats);
      if (sos.parentNode !== topbar) topbar.appendChild(sos);
      el.panel.classList.remove('is-expanded');
    }
  }

  // Mobilon a keresőpanel alapból rejtve van, csak a Keresés gombra jön be
  function setSearchOpen(open) {
    var on = !!open;
    document.body.classList.toggle('is-search', on);
    if (!on) el.panel.classList.remove('is-expanded');
    setTimeout(function () { map.resize(); }, 340);
  }

  function setDock(activeId) {
    ['dockTop', 'dockMap', 'dockFriends', 'dockProfile', 'dockSearch'].forEach(function (id) {
      if (el[id]) el[id].classList.toggle('is-active', id === activeId);
    });
    syncDockPill();
  }

  // a kiválasztott fül "folyékony" pirulája a gomb valódi helyére/méretére csúszik
  function syncDockPill() {
    if (!el.dock) return;
    var active = null;
    ['dockTop', 'dockMap', 'dockFriends', 'dockProfile', 'dockSearch'].forEach(function (id) {
      if (el[id] && el[id].classList.contains('is-active')) active = el[id];
    });
    if (!active || !active.offsetWidth) {
      el.dock.style.setProperty('--pill-w', '0px');
      return;
    }
    el.dock.style.setProperty('--pill-x', active.offsetLeft + 'px');
    el.dock.style.setProperty('--pill-w', active.offsetWidth + 'px');
  }

  /* ==================== események ==================== */

  function bindEvents() {
    var applyDebounced = debounce(applyFilters, 170);

    el.searchInput.addEventListener('input', function () {
      el.searchClear.hidden = !this.value;
      state.query = this.value;
      applyDebounced();
      fetchSuggest(this.value.trim());
    });
    el.searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hideSuggest();
    });
    el.searchClear.addEventListener('click', function () {
      el.searchInput.value = '';
      el.searchClear.hidden = true;
      state.query = '';
      hideSuggest();
      applyFilters();
      el.searchInput.focus();
    });

    el.searchSuggest.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      var it = (el.searchSuggest._items || [])[+btn.dataset.i];
      if (!it) return;
      hideSuggest();
      el.searchInput.value = it.main;
      el.searchClear.hidden = false;
      // A helyszínjavaslatra kattintva is maradjon aktív a keresőszó,
      // különben a lista újra az összes pontot mutatja (pl. „Mezőhegyes”).
      state.query = it.main;
      applyFilters();
      map.easeTo({ center: [it.lng, it.lat], zoom: 14, duration: 800 });
    });

    document.addEventListener('click', function (e) {
      if (!e.target.closest('.search-block')) hideSuggest();

      var routeBtn = e.target.closest('[data-route]');
      if (routeBtn) {
        e.preventDefault();
        var rp = state.byId.get(+routeBtn.dataset.route);
        if (rp) startRoute(rp, null);
        return;
      }
      var detBtn = e.target.closest('[data-detail]');
      if (detBtn) {
        e.preventDefault();
        select(+detBtn.dataset.detail, {});
      }
    });

    Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (chip) {
      chip.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (c) {
          c.classList.remove('is-active');
        });
        chip.classList.add('is-active');
        state.filter = chip.dataset.filter;
        applyFilters();
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('.sort'), function (btn) {
      btn.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.sort'), function (c) {
          c.classList.remove('is-active');
        });
        btn.classList.add('is-active');
        state.sort = btn.dataset.sort;
        applyFilters();
      });
    });

    el.locateBtn.addEventListener('click', function () { askLocation('locate'); });

    el.resetBtn.addEventListener('click', function () {
      el.searchInput.value = '';
      el.searchClear.hidden = true;
      state.query = '';
      state.filter = 'all';
      Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (c) {
        c.classList.toggle('is-active', c.dataset.filter === 'all');
      });
      hideSuggest();
      closeSheet();
      stopSos();
      stopRoute();
      applyFilters();
      map.easeTo({ center: [19.4597, 47.1625], zoom: 6.9, duration: 800 });
    });

    el.results.addEventListener('click', function (e) {
      var favEl = e.target.closest('[data-fav]');
      if (favEl) { e.stopPropagation(); toggleFav(+favEl.dataset.fav); return; }
      var card = e.target.closest('.card');
      if (!card) return;
      var id = +card.dataset.id;
      var p = state.byId.get(id);
      // a kártya jobb alsó sarkában az „ÚTVONAL" feliratra kattintva rögtön útvonal
      if (e.target.closest('.card-route') && p && state.me) {
        e.stopPropagation();
        startRoute(p, null);
        return;
      }
      select(id, {});
    });

    el.qbarList.addEventListener('click', function (e) {
      var item = e.target.closest('.qbar-item');
      if (item) select(+item.dataset.id, {});
    });

    el.routeClose.addEventListener('click', stopRoute);
    el.routeDetail.addEventListener('click', function () {
      if (state.route && state.route.point) select(state.route.point.id, {});
    });
    el.routeModes.addEventListener('click', function (e) {
      var b = e.target.closest('.rmode');
      if (!b || !state.route) return;
      startRoute(state.route.point, b.dataset.mode);
    });
    el.routeStepsToggle.addEventListener('click', function () {
      var open = el.routeSteps.hidden;
      el.routeSteps.hidden = !open;
      el.routeStepsToggle.textContent = open ? 'Lépések elrejtése' : 'Lépések megjelenítése';
    });

    // lépésről lépésre kattintgatás: a lépéssorra kattintva odanéz,
    // a ‹ › nyilakkal végiglapozható az egész útvonal
    el.routeSteps.addEventListener('click', function (e) {
      var row = e.target.closest('.rstep');
      if (!row || row.dataset.step == null) return;
      previewStep(Number(row.dataset.step));
    });
    el.routeSteps.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var row = e.target.closest('.rstep');
      if (!row || row.dataset.step == null) return;
      e.preventDefault();
      previewStep(Number(row.dataset.step));
    });
    el.stepPrev.addEventListener('click', function () {
      if (stepIdx < 0) previewStep(0);
      else if (stepIdx === 0) toast('Ez az első lépés');
      else previewStep(stepIdx - 1);
    });
    el.stepNext.addEventListener('click', function () {
      var steps = (state.route && state.route.steps) || [];
      if (!steps.length) return;
      if (stepIdx >= steps.length - 1) { toast('Megérkeztél a célhoz ⚑'); return; }
      previewStep(stepIdx + 1);
    });
    el.stepReset.addEventListener('click', function () {
      clearStepPreview();
      fitRouteTo();
    });
    // Indítás → appon belüli turn-by-turn navigáció
    el.routeStart.addEventListener('click', function () {
      if (nav) { toast('A navigáció már fut'); return; }
      if (state.route && state.route.geojson) startNavigation();
      else if (state.route && state.route.point) startRoute(state.route.point, null, { navigate: true });
    });

    // Navigációs HUD
    el.navExit.addEventListener('click', stopNavigation);
    el.navPreview.addEventListener('click', navPreviewNext);
    // lépéslista: kinyitás / bezárás, lépésre kattintás → odanézés
    el.navStepsBtn.addEventListener('click', function () {
      if (el.navStepsPanel.hidden) openNavSteps();
      else navStepsClose();
    });
    el.navStepsResume.addEventListener('click', navStepsClose);
    el.navStepsList.addEventListener('click', function (e) {
      var row = e.target.closest('.rstep');
      if (!row || row.dataset.step == null) return;
      navStepPreview(Number(row.dataset.step));
    });
    el.navStepsList.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var row = e.target.closest('.rstep');
      if (!row || row.dataset.step == null) return;
      e.preventDefault();
      navStepPreview(Number(row.dataset.step));
    });
    el.arriveOk.addEventListener('click', function () {
      el.arrive.hidden = true;
      stopNavigation();
    });

    // SOS
    el.sosBtn.addEventListener('click', function () {
      if (el.sosView.hidden) startSos(); else stopSos();
    });
    el.sosClose.addEventListener('click', stopSos);
    el.sosNext.addEventListener('click', function () {
      if (!state.sosList.length) return;
      state.sosIndex = (state.sosIndex + 1) % state.sosList.length;
      showSos();
    });
    el.sosMoreList.addEventListener('click', function (e) {
      var item = e.target.closest('.sos-more-item');
      if (!item) return;
      state.sosIndex = +item.dataset.i;
      showSos();
    });

    // Lebegő eszközök (telefon/tablet)
    el.toolLocate.addEventListener('click', function () { askLocation('locate'); });
    el.tool3D.addEventListener('click', toggle3D);
    el.toolFilter.addEventListener('click', function () {
      closeOverlay();
      setDock('dockSearch');
      setSearchOpen(true);
    });

    // Dokk

    el.dockTop.addEventListener('click', function () { setSearchOpen(false); openOverlay('top'); setDock('dockTop'); });
    el.dockFriends.addEventListener('click', function () { setSearchOpen(false); openFriendsOverlay(); setDock('dockFriends'); });
    el.dockMap.addEventListener('click', function () {
      closeOverlay();
      setSearchOpen(false);
      setDock('dockMap');
      if (state.me) map.easeTo({ center: [state.me.lng, state.me.lat], zoom: Math.max(map.getZoom(), 13), duration: 750 });
      else map.easeTo({ center: [19.4597, 47.1625], zoom: 6.9, duration: 750 });
    });
    el.dockProfile.addEventListener('click', function () { setSearchOpen(false); openOverlay('profile'); setDock('dockProfile'); });
    el.dockSearch.addEventListener('click', function () {
      closeOverlay();
      // újabb kattintás a Keresésre bezárja a panelt (minden nézetben)
      if (document.body.classList.contains('is-search') && el.dockSearch.classList.contains('is-active')) {
        setSearchOpen(false);
        setDock('dockMap');
        return;
      }
      setDock('dockSearch');
      setSearchOpen(true);
      if (isMobile()) el.panel.classList.add('is-expanded');
      el.searchInput.focus();
      el.searchInput.select();
    });

    // Mélyhivatkozás: #pont/<id> (QR / megosztott link)
    window.addEventListener('hashchange', openPointFromHash);

    // Megosztás a pont részleteiben (link, QR, Web Share, barátoknak)
    if (el.shareCopy) el.shareCopy.addEventListener('click', function () {
      if (selectedId != null) copyText(pointUrl(selectedId));
    });
    if (el.shareNative) el.shareNative.addEventListener('click', function () {
      if (selectedId == null) return;
      var sp = state.byId.get(selectedId);
      var data = { title: sp ? sp.name : 'REpont', url: pointUrl(selectedId) };
      if (navigator.share) navigator.share(data).catch(function () { });
      else copyText(data.url);
    });
    if (el.shareFriend) el.shareFriend.addEventListener('click', function () {
      if (selectedId != null) sharePointToFriend(selectedId);
    });

    // Barátok / csoportok / chat / bökés
    el.overlay.addEventListener('click', friendsClick);
    el.overlay.addEventListener('submit', function (e) {
      var f = e.target;
      if (!f || !f.dataset) return;
      if (f.dataset.fr === 'searchform') {
        e.preventDefault();
        var si = f.querySelector('input');
        if (si) searchUsers(si.value);
      } else if (f.dataset.fr === 'sendform') {
        e.preventDefault();
        var mi = f.querySelector('input');
        if (mi) sendChat(soc.chatId, mi.value);
      }
    });

    // Visszaváltás-napló (kassza) a profilban
    el.overlay.addEventListener('submit', function (e) {
      var f = e.target;
      if (!f || !f.dataset || f.dataset.cash !== 'add') return;
      e.preventDefault();
      cashAddFromForm(f);
    });
    el.overlay.addEventListener('click', function (e) {
      var d = e.target.closest('[data-cashdel]');
      if (!d) return;
      cashRemove(d.dataset.cashdel);
    });

    // Fiók / bejelentkezés
    el.authClose.addEventListener('click', authClose);
    el.authView.addEventListener('click', function (e) {
      if (e.target === el.authView) authClose();
    });
    el.authTabs.addEventListener('click', function (e) {
      var t = e.target.closest('[data-tab]');
      if (!t) return;
      authSetMode(t.dataset.tab);
    });
    el.authForgot.addEventListener('click', function () { authSetMode('forgot'); el.authEmail.focus(); });
    el.authBack.addEventListener('click', function () { authSetMode('login'); el.authEmail.focus(); });
    el.authForm.addEventListener('submit', function (e) { e.preventDefault(); authSubmit(); });

    // Közösségi állapot / kedvencek
    el.results.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var favEl = e.target.closest('[data-fav]');
      if (!favEl) return;
      e.preventDefault();
      e.stopPropagation();
      toggleFav(+favEl.dataset.fav);
    });
    [el.sheetFav, el.sheetFavPc].forEach(function (btn) {
      if (!btn) return;
      btn.addEventListener('click', function () {
        if (selectedId != null) toggleFav(selectedId);
      });
    });
    if (el.reportBtns) {
      el.reportBtns.addEventListener('click', function (e) {
        var b = e.target.closest('[data-report]');
        if (!b || selectedId == null) return;
        sendReport(selectedId, b.dataset.report);
        setReportsOpen(false);
      });
    }
    if (el.reportFig) el.reportFig.addEventListener('click', toggleReportsOpen);

    // megosztás-ablak
    if (el.shareClose) el.shareClose.addEventListener('click', closeShare);
    if (el.sharePopBack) el.sharePopBack.addEventListener('click', closeShare);

    // nyitvatartás-ablak (PC-n középre igazított felugró ablak)
    if (el.hoursOpen) el.hoursOpen.addEventListener('click', function () { setHoursOpen(true); });
    if (el.hoursClose) el.hoursClose.addEventListener('click', function () { setHoursOpen(false); });
    if (el.hoursBlock) {
      el.hoursBlock.addEventListener('click', function (e) {
        if (e.target === el.hoursBlock) setHoursOpen(false);
      });
    }

    // fejléc-térkép: koppintásra mozgatható, újra koppintásra (vagy a tippre) visszazár
    if (el.sheetHero) {
      el.sheetHero.addEventListener('click', function (e) {
        if (e.target.closest('button, a, .sheet-hero-top, .sheet-hero-body, .sheet-map-hint')) return;
        setHeroMapLive(!el.sheetHero.classList.contains('is-map-live'));
      });
    }
    if (el.sheetMapHint) {
      el.sheetMapHint.addEventListener('click', function (e) {
        e.stopPropagation();
        if (el.sheetHero && el.sheetHero.classList.contains('is-map-live')) setHeroMapLive(false);
      });
    }

    // Overlay
    el.overlayClose.addEventListener('click', function () { closeOverlay(); setDock('dockMap'); });
    el.overlay.addEventListener('click', function (e) {
      var accBtn = e.target.closest('[data-account]');
      if (accBtn) {
        var act = accBtn.dataset.account;
        if (act === 'login' || act === 'register') { authOpen(act); return; }
        if (act === 'password') { authOpen('reset'); return; }
        if (act === 'intro') { closeOverlay(); setDock('dockMap'); setTimeout(introShow, 160); return; }
        if (act === 'logout') { authSignOut(); return; }
        if (act === 'delete') { authDeleteAccount(); return; }
        if (act === 'name') { profileNameEdit(); return; }
        if (act === 'avatar') { profileAvatarEdit(); return; }
      }
      // profil sorok: értékelés törlés / szerkesztés, kedvenc útvonal
      var delBtn = e.target.closest('[data-fbdel]');
      if (delBtn) { removeRating(+delBtn.dataset.fbdel); return; }
      var editBtn = e.target.closest('[data-fbedit]');
      if (editBtn) { editRating(+editBtn.dataset.fbedit); return; }
      var routeBtn = e.target.closest('[data-route]');
      if (routeBtn) { routeFromProfile(+routeBtn.dataset.route); return; }
      if (e.target === el.overlay) { closeOverlay(); setDock('dockMap'); return; }
      var row = e.target.closest('.rank-row');
      if (row) {
        closeOverlay();
        setDock('dockMap');
        select(+row.dataset.id, {});
      }
    });

    if (el.hoursToggle) {
      el.hoursToggle.addEventListener('click', function () {
        var open = el.hoursBlock.classList.toggle('is-open');
        el.hoursToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        el.hoursToggle.textContent = open ? 'Csak a mai nap' : 'Teljes nyitvatartás';
      });
    }

    if (el.introView) {
      el.introClose.addEventListener('click', introHide);
      el.introNext.addEventListener('click', function () { introSlide(introIndex + 1); });
      el.introSlides.addEventListener('click', function (e) {
        if (e.target.closest('.intro-actions')) return;
        introSlide(introIndex + 1);
      });
      el.introDots.addEventListener('click', function (e) {
        var d = e.target.closest('[data-slide]');
        if (d) introSlide(+d.dataset.slide);
      });
      el.introRegister.addEventListener('click', function () { introStart('register'); });
      el.introLogin.addEventListener('click', function () { introStart('login'); });
      el.introGuest.addEventListener('click', introHide);
      el.introView.addEventListener('click', function (e) {
        if (e.target === el.introView) introHide();
      });
    }

    el.sheetClose.addEventListener('click', closeSheet);
    if (el.sheetClosePc) el.sheetClosePc.addEventListener('click', closeSheet);
    el.sheetScrim.addEventListener('click', closeSheet);

    document.addEventListener('keydown', function (e) {
      if (el.introView && !el.introView.hidden) {
        if (e.key === 'ArrowLeft') { introSlide(introIndex - 1); return; }
        if (e.key === 'ArrowRight') { introSlide(introIndex + 1); return; }
        if (e.key === 'Escape') { introHide(); return; }
        return;
      }
      if (e.key !== 'Escape') return;
      if (el.sharePop && !el.sharePop.hidden) { closeShare(); return; }
      if (el.hoursBlock && el.hoursBlock.classList.contains('is-popped')) { setHoursOpen(false); return; }
      if (el.reportsPop && el.reportsPop.classList.contains('is-open')) { setReportsOpen(false); return; }
      if (!el.authView.hidden) { authClose(); return; }
      if (!el.overlay.hidden) { closeOverlay(); setDock('dockMap'); return; }
      if (!el.arrive.hidden) { el.arrive.hidden = true; stopNavigation(); return; }
      if (!el.sosView.hidden) { stopSos(); return; }
      if (nav) { stopNavigation(); return; }
      if (document.body.classList.contains('is-search') && el.sheet.hidden) { setSearchOpen(false); setDock('dockMap'); return; }
      closeSheet(); hideSuggest(); closePopup();
    });

    el.panelGrip.addEventListener('click', function () {
      el.panel.classList.toggle('is-expanded');
      setTimeout(function () { map.resize(); }, 340);
    });
  }

  /* ==================== értékelések (névvel) + megosztás / QR ==================== */

  // A pont részleteiben megjelenő, névvel ellátott értékelések (point_reviews nézet)
  function renderReviews(id, rows, err) {
    if (!el.reviewsList || selectedId !== id) return;
    if (err) {
      var msg = String((err && err.message) || '');
      var missing = err && (err.code === '42P01' || err.code === 'PGRST202' ||
        /relation .* does not exist/i.test(msg) || /friend|point_reviews|user_names/i.test(msg));
      el.reviewsList.innerHTML = missing
        ? '<div class="chat-hint">Az értékelésekhez futtasd a <b>data/supabase-friends.sql</b> fájlt a Supabase SQL Editorban.</div>'
        : '<div class="chat-hint">Az értékelések most nem érhetők el.</div>';
      if (el.reviewsStatus) el.reviewsStatus.textContent = '';
      return;
    }
    bindRevSocial();
    rows = rows || [];
    revSocial.point = id;
    revSocial.rows = rows;
    if (el.reviewsStatus) el.reviewsStatus.textContent = rows.length ? rows.length + ' db' : '';
    if (!rows.length) {
      el.reviewsList.innerHTML = '<div class="chat-hint is-empty"><b>Még nincs értékelés</b>' +
        'Ezt a pontot még senki sem értékelte — te lehetsz az első!</div>';
      return;
    }
    var uid = account.user && account.user.id;
    el.reviewsList.innerHTML = rows.map(function (r) {
      var tags = (r.tags || []).map(tagLabel);
      var at = r.updated_at ? Date.parse(r.updated_at) : 0;
      var who = r.display_name || 'Ismeretlen';
      return '<div class="review-row">' +
        '<span class="review-av" aria-hidden="true">' + esc(initial(who)) + '</span>' +
        '<span class="rank-main">' +
          '<span class="rv-top"><b>' + esc(who) + (uid && r.user_id === uid ? ' <i>(te)</i>' : '') + '</b>' +
          (at ? '<span class="rv-date">' + esc(fmtWhen(at)) + '</span>' : '') + '</span>' +
          (tags.length ? '<span class="rv-tags">' + tags.map(function (t) {
            return '<span class="rv-tag">' + esc(t) + '</span>';
          }).join('') + '</span>' : '') +
          (r.note ? '<p class="review-note">' + esc(r.note) + '</p>' : '') +
          reviewSocialHtml(r.user_id, uid) +
        '</span>' +
        scoreBadge(r.score) +
      '</div>';
    }).join('');
  }

  /* --- értékelés-reakciók (szív / like / dislike) és válasz-kommentek --- */

  var revSocial = {
    point: null, rows: null, available: false,
    reacts: {}, mine: {}, replies: {}, open: {}
  };
  var revBound = false;

  function bindRevSocial() {
    if (revBound || !el.reviewsList) return;
    revBound = true;
    el.reviewsList.addEventListener('click', revListClick);
    el.reviewsList.addEventListener('submit', revListSubmit);
  }

  function repaintReviews() {
    if (revSocial.point == null || revSocial.rows == null) return;
    renderReviews(revSocial.point, revSocial.rows);
  }

  function reactBtn(rid, kind, emo, label, count, mine) {
    var on = mine === kind;
    return '<button class="rv-react' + (on ? ' is-on' : '') + '" type="button"' +
      ' data-rv-react="' + esc(rid) + '" data-rv-kind="' + kind + '"' +
      ' title="' + esc(label) + '" aria-label="' + esc(label) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
      '<span class="rv-emo">' + emo + '</span>' +
      (count ? '<span class="rv-cnt">' + count + '</span>' : '') +
      '</button>';
  }

  function reviewSocialHtml(rid, uid) {
    if (!revSocial.available) return '';
    var c = revSocial.reacts[rid] || { heart: 0, like: 0, dislike: 0 };
    var mine = revSocial.mine[rid] || '';
    var reps = revSocial.replies[rid] || [];
    var out = '<span class="rv-social">' +
      reactBtn(rid, 'heart', '❤️', 'Imádom', c.heart || 0, mine) +
      reactBtn(rid, 'like', '👍', 'Tetszik', c.like || 0, mine) +
      reactBtn(rid, 'dislike', '👎', 'Nem tetszik', c.dislike || 0, mine) +
      '<button class="rv-reply-btn' + (revSocial.open[rid] ? ' is-on' : '') + '" type="button"' +
      ' data-rv-reply="' + esc(rid) + '">💬 Válasz' + (reps.length ? ' · ' + reps.length : '') + '</button>' +
      '</span>';
    if (reps.length) {
      out += '<span class="rv-replies">' + reps.map(function (p) {
        return '<span class="rv-reply">' +
          '<b>' + esc(p.display_name || 'Ismeretlen') + '</b>' +
          '<span class="rv-reply-txt">' + esc(p.body) + '</span>' +
          '<small>' + esc(fmtWhen(Date.parse(p.created_at))) + '</small>' +
          (uid && p.author_id === uid
            ? '<button class="rv-reply-del" type="button" data-rv-del="' + esc(p.id) + '" title="Válasz törlése">✕</button>'
            : '') +
          '</span>';
      }).join('') + '</span>';
    }
    if (revSocial.open[rid]) {
      out += '<form class="rv-form" data-rv-form="' + esc(rid) + '">' +
        '<input type="text" maxlength="800" placeholder="Írd le a válaszod…" aria-label="Válasz az értékelésre">' +
        '<button class="rv-send" type="submit">Küldés</button>' +
        '</form>';
    }
    return out;
  }

  function loadReviewSocial(id, rows) {
    revSocial.point = id;
    revSocial.rows = rows;
    revSocial.reacts = {};
    revSocial.mine = {};
    revSocial.replies = {};
    revSocial.open = {};
    revSocial.available = false;
    if (!sb || !account.user || !(rows || []).length) return Promise.resolve();

    function safe(q) {
      return q.then(function (r) { return r; }).catch(function (e) { return { error: e }; });
    }
    var cq = safe(sb.from('review_reaction_counts')
      .select('review_user_id,hearts,likes,dislikes').eq('point_id', +id));
    var mq = safe(sb.from('review_reactions')
      .select('review_user_id,kind').eq('point_id', +id).eq('user_id', account.user.id));
    var pq = safe(sb.from('review_reply_list')
      .select('id,review_user_id,author_id,body,created_at,display_name')
      .eq('point_id', +id).order('created_at', { ascending: true }).limit(200));

    return Promise.all([cq, mq, pq]).then(function (res) {
      if (res[0].error || res[1].error || res[2].error) return;
      revSocial.available = true;
      (res[0].data || []).forEach(function (x) {
        revSocial.reacts[x.review_user_id] = {
          heart: +x.hearts, like: +x.likes, dislike: +x.dislikes
        };
      });
      (res[1].data || []).forEach(function (x) {
        revSocial.mine[x.review_user_id] = x.kind;
      });
      (res[2].data || []).forEach(function (p) {
        var arr = revSocial.replies[p.review_user_id] ||
          (revSocial.replies[p.review_user_id] = []);
        arr.push(p);
      });
    });
  }

  function revReact(rid, kind) {
    if (!requireLogin('A reakcióhoz')) return;
    if (!sb || revSocial.point == null || !account.user) return;
    var uid = account.user.id;
    var prev = revSocial.mine[rid] || '';
    var next = prev === kind ? '' : kind;
    var c = revSocial.reacts[rid] || (revSocial.reacts[rid] = { heart: 0, like: 0, dislike: 0 });

    if (prev && c[prev] > 0) c[prev]--;
    revSocial.mine[rid] = next;
    if (next) c[next] = (c[next] || 0) + 1;
    repaintReviews();

    var t = sb.from('review_reactions');
    var q;
    if (!next) {
      q = t.delete().eq('point_id', +revSocial.point).eq('review_user_id', rid).eq('user_id', uid);
    } else if (prev) {
      q = t.update({ kind: next }).eq('point_id', +revSocial.point).eq('review_user_id', rid).eq('user_id', uid);
    } else {
      q = t.insert({
        point_id: +revSocial.point, review_user_id: rid, user_id: uid, kind: next
      });
    }
    q.then(function (r) {
      if (!r.error) return;
      if (next && c[next] > 0) c[next]--;
      if (prev) c[prev] = (c[prev] || 0) + 1;
      revSocial.mine[rid] = prev;
      repaintReviews();
      toast('A reakció nem ment: ' + authErr(r.error));
    }).catch(function () { });
  }

  function revToggleReply(rid) {
    if (!requireLogin('A válaszhoz')) return;
    revSocial.open[rid] = !revSocial.open[rid];
    repaintReviews();
    if (revSocial.open[rid]) {
      setTimeout(function () {
        var inp = el.reviewsList.querySelector('[data-rv-form="' + rid + '"] input');
        if (inp) inp.focus();
      }, 40);
    }
  }

  function revReloadReplies() {
    if (!sb || revSocial.point == null) return;
    sb.from('review_reply_list')
      .select('id,review_user_id,author_id,body,created_at,display_name')
      .eq('point_id', +revSocial.point).order('created_at', { ascending: true }).limit(200)
      .then(function (res) {
        if (res.error) return;
        revSocial.replies = {};
        (res.data || []).forEach(function (p) {
          var arr = revSocial.replies[p.review_user_id] ||
            (revSocial.replies[p.review_user_id] = []);
          arr.push(p);
        });
        repaintReviews();
      });
  }

  function revSendReply(rid, body) {
    if (!requireLogin('A válaszhoz')) return;
    if (!sb || revSocial.point == null || !account.user) return;
    sb.from('review_replies').insert({
      point_id: +revSocial.point, review_user_id: rid, author_id: account.user.id, body: body
    }).then(function (r) {
      if (r.error) { toast('A válasz nem ment: ' + authErr(r.error)); return; }
      revSocial.open[rid] = false;
      revReloadReplies();
      toast('Válasz elküldve 💬');
    }).catch(function (e) { toast('A válasz nem ment: ' + authErr(e)); });
  }

  function revDeleteReply(id) {
    if (!sb) return;
    sb.from('review_replies').delete().eq('id', +id).then(function (r) {
      if (r.error) { toast('Nem sikerült törölni: ' + authErr(r.error)); return; }
      revReloadReplies();
      toast('Válasz törölve');
    });
  }

  function revListClick(e) {
    var rb = e.target.closest('[data-rv-react]');
    if (rb) { e.preventDefault(); revReact(rb.dataset.rvReact, rb.dataset.rvKind); return; }
    var tb = e.target.closest('[data-rv-reply]');
    if (tb) { e.preventDefault(); revToggleReply(tb.dataset.rvReply); return; }
    var db = e.target.closest('[data-rv-del]');
    if (db) { e.preventDefault(); revDeleteReply(db.dataset.rvDel); return; }
  }

  function revListSubmit(e) {
    var f = e.target.closest('[data-rv-form]');
    if (!f) return;
    e.preventDefault();
    var inp = f.querySelector('input');
    var val = inp && inp.value ? inp.value.trim() : '';
    if (!val) { toast('Írj valamit a válaszba'); return; }
    revSendReply(f.dataset.rvForm, val);
  }

  function loadPointReviews(id) {
    if (!el.reviewsList) return;
    if (id == null) return;
    if (!sb) { renderReviews(id, []); return; }
    el.reviewsList.innerHTML = '<div class="chat-hint">Betöltés…</div>';
    if (el.reviewsStatus) el.reviewsStatus.textContent = '';
    sb.from('point_reviews')
      .select('user_id,score,tags,note,updated_at,display_name')
      .eq('point_id', +id)
      .order('updated_at', { ascending: false })
      .limit(40)
      .then(function (res) {
        if (selectedId !== id) return;
        if (res.error) { renderReviews(id, null, res.error); return; }
        var rows = res.data || [];
        renderReviews(id, rows);
        return loadReviewSocial(id, rows).then(function () {
          if (selectedId === id) renderReviews(id, rows);
        });
      })
      .catch(function (e) { if (selectedId === id) renderReviews(id, null, e); });
  }

  // mélyhivatkozás: https://<oldal>/#pont/123
  function pointUrl(id) {
    return location.origin + location.pathname + '#pont/' + id;
  }

  function copyText(txt) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt)
        .then(function () { toast('Link a vágólapra másolva'); })
        .catch(function () { toast('Nem sikerült másolni'); });
    } else {
      toast('A másolás nem támogatott ebben a böngészőben');
    }
  }

  function renderShareBox(id) {
    if (!el.shareBox) return;
    var p = state.byId.get(+id);
    if (!p) return;
    var url = pointUrl(p.id);
    if (el.shareTitle) el.shareTitle.textContent = p.name;
    if (el.shareUrlText) el.shareUrlText.textContent = url;
    if (el.shareQr) {
      if (typeof window.qrcode !== 'function') {
        el.shareQr.innerHTML = '<span class="share-qr-missing">A QR-könyvtár nem töltődött be.</span>';
      } else {
        try {
          var qr = window.qrcode(0, 'M');
          qr.addData(url);
          qr.make();
          el.shareQr.innerHTML = qr.createImgTag(4, 8, 'QR-kód: ' + p.name);
        } catch (e) {
          el.shareQr.innerHTML = '<span class="share-qr-missing">QR-kód nem készíthető.</span>';
        }
      }
    }
    if (el.sharePop) el.sharePop.hidden = false;
  }

  function openShare(id) {
    if (id == null) return;
    renderShareBox(id);
  }

  function closeShare() {
    if (el.sharePop && !el.sharePop.hidden) el.sharePop.hidden = true;
  }

  function setHoursOpen(on) {
    if (!el.hoursBlock) return;
    if (on && !el.hoursBlock.classList.contains('is-floating')) on = false;
    el.hoursBlock.classList.toggle('is-popped', !!on);
    if (el.hoursOpen) el.hoursOpen.setAttribute('aria-expanded', on ? 'true' : 'false');
  }

  // PC-n a nyitvatartás az oldal közepén nyílik: a blokk a body alá kerül (mobilon a lapban marad)
  var hoursHome = null;
  function placeHoursBlock() {
    if (!el.hoursBlock) return;
    var blk = el.hoursBlock;
    if (window.innerWidth > 900) {
      if (!hoursHome) hoursHome = { parent: blk.parentNode, next: blk.nextSibling };
      if (blk.parentNode !== document.body) document.body.appendChild(blk);
      blk.classList.add('is-floating');
    } else {
      blk.classList.remove('is-floating');
      blk.classList.remove('is-popped');
      if (hoursHome && blk.parentNode !== hoursHome.parent) {
        hoursHome.parent.insertBefore(blk, hoursHome.next);
      }
    }
  }

  function closeHours() {
    if (el.hoursBlock && el.hoursBlock.classList.contains('is-popped')) setHoursOpen(false);
  }

  function pointFromHash() {
    var m = (location.hash || '').match(/^#pont\/(\d+)$/);
    return m ? +m[1] : null;
  }

  function openPointFromHash() {
    var id = pointFromHash();
    if (id == null || !ready.data || !state.byId.has(id)) return;
    if (selectedId === id && el.sheet && !el.sheet.hidden) return;
    select(id, {});
  }

  /* ==================== barátok, csoportok, chat, bökés ==================== */

  var CHAT_KEY = 'vissza.chat-seen.v1';
  var soc = {
    friends: [],      // [{ id, at }]
    requests: [],     // [{ id, at, dir: 'in'|'out' }]
    convs: [],        // [{ id, kind, name, members, last, unread }]
    msgs: [],         // a nyitott beszélgetés üzenetei
    pokes: [],        // kapott, nem látott bökések
    shownPokes: {},   // ezen a munkameneten már kiírt bökések
    names: {},        // userId -> megjelenített név
    seen: {},         // convId -> utoljára látott üzenet (ms)
    search: [],
    searchQ: '',
    view: 'list',     // list | chat | newgroup
    chatId: null,
    groupPick: [],
    pendingPoint: null,   // barátnak küldésre kijelölt pont
    loaded: false
  };
  var socialTimer = 0, socialTickN = 0;

  soc.seen = readJSON(CHAT_KEY, {}) || {};

  function requireLogin(msg) {
    if (!sb) { toast('A funkcióhoz Supabase-kapcsolat kell (js/config.js)'); return false; }
    if (!account.user) {
      authOpen('login');
      authMessage(msg + ' — jelentkezz be, hogy használhasd.', 'info');
      return false;
    }
    return true;
  }

  function initial(name) {
    var s = String(name == null ? '' : name).trim();
    return (s.charAt(0) || '?').toUpperCase();
  }

  function nameOf(id) {
    if (account.user && id === account.user.id) return displayName();
    return soc.names[id] || 'Ismeretlen';
  }

  function sortedPair(a, b) {
    a = String(a); b = String(b);
    return a < b ? { user_id: a, friend_id: b } : { user_id: b, friend_id: a };
  }

  function loadUserNames(ids) {
    if (!sb || !account.user) return Promise.resolve();
    var uniq = [];
    (ids || []).forEach(function (id) {
      id = String(id == null ? '' : id);
      if (id && !soc.names[id] && uniq.indexOf(id) === -1) uniq.push(id);
    });
    if (!uniq.length) return Promise.resolve();
    return sb.from('user_names').select('id,display_name').in('id', uniq)
      .then(function (res) {
        if (res.error || !res.data) return;
        res.data.forEach(function (r) { if (r.display_name) soc.names[r.id] = r.display_name; });
      })
      .catch(function () { });
  }

  function loadFriends() {
    if (!sb || !account.user) return Promise.resolve();
    var uid = account.user.id;

    var fP = sb.from('friendships').select('user_id,friend_id,created_at')
      .or('user_id.eq.' + uid + ',friend_id.eq.' + uid)
      .then(function (res) {
        if (res.error || !res.data) return [];
        return res.data.map(function (r) {
          return { id: r.user_id === uid ? r.friend_id : r.user_id, at: Date.parse(r.created_at) || 0 };
        });
      })
      .catch(function () { return []; });

    var rP = sb.from('friend_requests').select('sender_id,receiver_id,created_at')
      .or('sender_id.eq.' + uid + ',receiver_id.eq.' + uid)
      .then(function (res) {
        if (res.error || !res.data) return [];
        return res.data.map(function (r) {
          var incoming = r.receiver_id === uid;
          return {
            id: incoming ? r.sender_id : r.receiver_id,
            at: Date.parse(r.created_at) || 0,
            dir: incoming ? 'in' : 'out'
          };
        });
      })
      .catch(function () { return []; });

    return Promise.all([fP, rP]).then(function (r) {
      soc.friends = (r[0] || []).sort(function (a, b) { return a.id < b.id ? -1 : 1; });
      soc.requests = r[1] || [];
      return loadUserNames(soc.friends.map(function (f) { return f.id; })
        .concat(soc.requests.map(function (q) { return q.id; })));
    }).then(function () { soc.loaded = true; });
  }

  function loadConvs() {
    if (!sb || !account.user) return Promise.resolve();
    var uid = account.user.id;

    return sb.from('conversation_members').select('conversation_id').eq('user_id', uid)
      .then(function (res) {
        if (res.error || !res.data || !res.data.length) { soc.convs = []; return null; }
        var ids = res.data.map(function (r) { return r.conversation_id; });

        var cP = sb.from('conversations').select('id,kind,name,created_at').in('id', ids)
          .then(function (r2) { return (r2 && !r2.error && r2.data) || []; })
          .catch(function () { return []; });
        var pP = sb.from('conversation_participants').select('conversation_id,user_id,display_name').in('conversation_id', ids)
          .then(function (r2) { return (r2 && !r2.error && r2.data) || []; })
          .catch(function () { return []; });
        var mP = sb.from('messages').select('conversation_id,body,created_at,sender_id')
          .in('conversation_id', ids)
          .order('created_at', { ascending: false })
          .limit(300)
          .then(function (r2) { return (r2 && !r2.error && r2.data) || []; })
          .catch(function () { return []; });

        return Promise.all([cP, pP, mP]).then(function (r3) {
          var cs = r3[0], ps = r3[1], ms = r3[2];
          var last = {}, unread = {};
          ms.forEach(function (m) {
            if (!last[m.conversation_id]) last[m.conversation_id] = m;
            var at = Date.parse(m.created_at) || 0;
            if (m.sender_id !== uid && at > (soc.seen[m.conversation_id] || 0)) {
              unread[m.conversation_id] = (unread[m.conversation_id] || 0) + 1;
            }
          });
          var byConv = {};
          ps.forEach(function (p) {
            (byConv[p.conversation_id] = byConv[p.conversation_id] || []).push({ id: p.user_id, name: p.display_name });
            if (p.display_name) soc.names[p.user_id] = p.display_name;
          });
          soc.convs = cs.map(function (c) {
            var l = last[c.id] || null;
            return {
              id: c.id, kind: c.kind, name: c.name,
              members: byConv[c.id] || [],
              last: l ? { body: l.body, at: Date.parse(l.created_at) || 0, sender: l.sender_id } : null,
              unread: unread[c.id] || 0
            };
          }).sort(function (a, b) { return (b.last ? b.last.at : 0) - (a.last ? a.last.at : 0); });
        });
      })
      .catch(function () { });
  }

  function convById(id) {
    for (var i = 0; i < soc.convs.length; i++) if (soc.convs[i].id === id) return soc.convs[i];
    return null;
  }

  function convTitle(c) {
    if (!c) return 'Beszélgetés';
    if (c.kind === 'group') return c.name || 'Csoport';
    var me = account.user && account.user.id;
    var other = null;
    (c.members || []).forEach(function (m) { if (m.id !== me) other = m; });
    return other ? other.name : 'Beszélgetés';
  }

  function updateFriendsDot() {
    var dot = el.dockFriendsDot;
    if (!dot) return;
    var n = soc.pokes.length + soc.requests.filter(function (q) { return q.dir === 'in'; }).length;
    dot.hidden = !n;
    dot.textContent = n > 9 ? '9+' : String(n || '');
  }

  function frRow(av, name, sub, acts) {
    return '<div class="fr-row">' +
      '<span class="fr-av" aria-hidden="true">' + esc(av) + '</span>' +
      '<span class="rank-main"><b>' + esc(name) + '</b>' +
      (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span>' +
      (acts ? '<span class="fr-acts">' + acts + '</span>' : '') +
    '</div>';
  }

  function convRowHtml(c) {
    var title = convTitle(c);
    var sub = c.last
      ? (c.last.sender && !(account.user && c.last.sender === account.user.id) ? nameOf(c.last.sender) + ': ' : '') + c.last.body
      : 'Még nincs üzenet';
    return '<div class="fr-row' + (c.unread ? ' is-unread' : '') + '" data-fr="open" data-conv="' + esc(c.id) + '">' +
      '<span class="fr-av" aria-hidden="true">' + (c.kind === 'group' ? '👥' : '💬') + '</span>' +
      '<span class="rank-main"><b>' + esc(title) + '</b><small>' + esc(String(sub).slice(0, 70)) + '</small></span>' +
      (c.unread ? '<span class="fr-badge">' + (c.unread > 9 ? '9+' : c.unread) + '</span>' : '') +
    '</div>';
  }

  function friendsListHtml() {
    if (!sb) return '<div class="chat-hint">A Supabase nincs bekötve (<b>js/config.js</b>) — a barátok funkció nem elérhető.</div>';
    if (!account.user) {
      return '<div class="overlay-empty">Jelentkezz be, hogy barátokat hívj, csevegj,<br>csoportot hozz létre és bökj.</div>' +
        '<div class="account-actions">' +
          '<button class="btn btn-primary" type="button" data-account="login">Bejelentkezés</button>' +
          '<button class="btn btn-ghost" type="button" data-account="register">Regisztráció</button>' +
        '</div>';
    }
    if (!soc.loaded) return '<div class="chat-hint">Betöltés…</div>';

    var out = [];

    if (soc.pendingPoint) {
      var pp = state.byId.get(soc.pendingPoint);
      out.push('<div class="fr-pending">Kinek küldöd: <b>' + esc(pp ? pp.name : ('#' + soc.pendingPoint)) + '</b>' +
        ' <button class="p-btn p-btn-ghost" type="button" data-fr="cancelpending">Mégse</button></div>');
    }

    out.push('<form class="fr-search" data-fr="searchform">' +
      '<input type="search" id="frSearchInput" placeholder="Név keresése…" autocomplete="off" value="' + esc(soc.searchQ) + '">' +
      '<button class="btn btn-primary" type="submit">Keresés</button>' +
      '</form>');

    if (soc.search.length) {
      out.push('<section class="p-sec"><div class="p-sec-head"><h3>Találatok</h3><span>' + soc.search.length + '</span></div>' +
        '<div class="p-sec-body">' +
        soc.search.map(function (u) {
          var isFriend = soc.friends.some(function (f) { return f.id === u.id; });
          var pend = soc.requests.some(function (q) { return q.id === u.id; });
          var act = isFriend ? '<span class="fr-tag">barát ✓</span>'
            : (pend ? '<span class="fr-tag">függő…</span>'
              : '<button class="p-btn" type="button" data-fr="add" data-id="' + u.id + '">Felkérés</button>');
          return frRow(initial(u.name), u.name, '', act);
        }).join('') +
        '</div></section>');
    }

    var incoming = soc.requests.filter(function (q) { return q.dir === 'in'; });
    var outgoing = soc.requests.filter(function (q) { return q.dir === 'out'; });
    if (incoming.length || outgoing.length) {
      out.push('<section class="p-sec"><div class="p-sec-head"><h3>Barátkérések</h3>' +
        '<span>' + (incoming.length + outgoing.length) + '</span></div><div class="p-sec-body">' +
        incoming.map(function (q) {
          return frRow(initial(nameOf(q.id)), nameOf(q.id), 'felkért téged',
            '<button class="p-btn" type="button" data-fr="accept" data-id="' + q.id + '">Elfogad</button> ' +
            '<button class="p-btn p-btn-ghost" type="button" data-fr="decline" data-id="' + q.id + '">Elutasít</button>');
        }).join('') +
        outgoing.map(function (q) {
          return frRow(initial(nameOf(q.id)), nameOf(q.id), 'meghívtad',
            '<span class="fr-tag">várakozik</span> ' +
            '<button class="p-btn p-btn-ghost" type="button" data-fr="cancel" data-id="' + q.id + '">Visszavonás</button>');
        }).join('') +
        '</div></section>');
    }

    out.push('<section class="p-sec"><div class="p-sec-head"><h3>Barátaid</h3><span>' + soc.friends.length + '</span></div>' +
      '<div class="p-sec-body">');
    if (!soc.friends.length) {
      out.push('<div class="chat-hint">Még nincs barátod. Keress rájuk névvel, és küldj felkérést.</div>');
    } else {
      out.push(soc.friends.map(function (f) {
        var n = nameOf(f.id);
        return frRow(initial(n), n, '',
          '<button class="p-btn" type="button" data-fr="chat" data-id="' + f.id + '" title="Csevegés">💬</button> ' +
          '<button class="p-btn p-btn-ghost" type="button" data-fr="poke" data-id="' + f.id + '" title="Bökés">🍾</button> ' +
          '<button class="p-btn p-btn-ghost" type="button" data-fr="remove" data-id="' + f.id + '" title="Barát eltávolítása">✕</button>');
      }).join(''));
    }
    out.push('</div></section>');

    var groups = soc.convs.filter(function (c) { return c.kind === 'group'; });
    var dms = soc.convs.filter(function (c) { return c.kind === 'dm'; });

    out.push('<section class="p-sec"><div class="p-sec-head"><h3>Csoportok</h3>' +
      '<button class="p-btn" type="button" data-fr="newgroup">+ Új</button></div><div class="p-sec-body">');
    if (!groups.length) out.push('<div class="chat-hint">Hozz létre egy csoportot a barátaiddal.</div>');
    else out.push(groups.map(convRowHtml).join(''));
    out.push('</div></section>');

    out.push('<section class="p-sec"><div class="p-sec-head"><h3>Üzenetek</h3><span>' + dms.length + '</span></div>' +
      '<div class="p-sec-body">');
    if (!dms.length) out.push('<div class="chat-hint">A 💬 gombbal indíthatsz beszélgetést egy barátoddal.</div>');
    else out.push(dms.map(convRowHtml).join(''));
    out.push('</div></section>');

    return out.join('');
  }

  function msgsHtml() {
    var c = convById(soc.chatId);
    if (!soc.msgs.length) return '<div class="chat-hint">Még nincs üzenet. Írj elsőként!</div>';
    var me = account.user && account.user.id;
    return soc.msgs.map(function (m) {
      var mine = m.sender_id === me;
      var isLink = /#pont\/\d+/.test(m.body);
      var body = isLink
        ? '<a href="' + esc(m.body) + '" data-fr="link">📍 REpont megnyitása</a>'
        : esc(m.body);
      return '<div class="msg' + (mine ? ' is-mine' : '') + '">' +
        (!mine && c && c.kind === 'group' ? '<span class="msg-who">' + esc(nameOf(m.sender_id)) + '</span>' : '') +
        '<span class="msg-bubble">' + body + '</span>' +
        '<span class="msg-time">' + new Date(m.at).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' }) + '</span>' +
      '</div>';
    }).join('');
  }

  function chatHtml() {
    var c = convById(soc.chatId);
    if (!c) { soc.view = 'list'; return friendsListHtml(); }
    return '<div class="chat-head">' +
        '<button class="fr-back" type="button" data-fr="back" aria-label="Vissza">←</button>' +
        '<span class="rank-main"><b>' + esc(convTitle(c)) + '</b>' +
        '<small>' + (c.kind === 'group' ? c.members.length + ' tag' : 'közvetlen üzenet') + '</small></span>' +
      '</div>' +
      '<div class="chat-msgs" id="chatMsgs">' + msgsHtml() + '</div>' +
      '<form class="chat-form" data-fr="sendform">' +
        '<input type="text" id="chatInput" maxlength="1000" placeholder="Írj egy üzenetet…" autocomplete="off">' +
        '<button class="btn btn-primary" type="submit">Küldés</button>' +
      '</form>';
  }

  function newGroupHtml() {
    var out = '<div class="chat-head">' +
      '<button class="fr-back" type="button" data-fr="back" aria-label="Vissza">←</button>' +
      '<span class="rank-main"><b>Új csoport</b><small>jelöld ki a tagokat</small></span>' +
    '</div>';
    out += '<div class="fr-search">' +
      '<input type="text" id="groupName" maxlength="40" placeholder="Csoport neve…">' +
      '<button class="btn btn-primary" type="button" data-fr="create">Létrehozás</button>' +
    '</div>';
    out += '<section class="p-sec"><div class="p-sec-head"><h3>Tagok</h3><span>' + soc.friends.length + '</span></div>' +
      '<div class="p-sec-body">';
    if (!soc.friends.length) {
      out += '<div class="chat-hint">Előbb adj hozzá barátokat.</div>';
    } else {
      out += soc.friends.map(function (f) {
        var on = soc.groupPick.indexOf(f.id) !== -1;
        var n = nameOf(f.id);
        return '<div class="fr-row is-pick' + (on ? ' is-on' : '') + '" data-fr="pick" data-id="' + f.id + '">' +
          '<span class="fr-av" aria-hidden="true">' + esc(initial(n)) + '</span>' +
          '<span class="rank-main"><b>' + esc(n) + '</b></span>' +
          '<span class="fr-tag">' + (on ? '✓' : '') + '</span>' +
        '</div>';
      }).join('');
    }
    out += '</div></section>';
    return out;
  }

  function renderFriendsView() {
    if (!el.overlayBody) return;
    if (soc.view === 'chat') { el.overlayBody.innerHTML = chatHtml(); scrollChat(); return; }
    if (soc.view === 'newgroup') { el.overlayBody.innerHTML = newGroupHtml(); return; }
    el.overlayBody.innerHTML = friendsListHtml();
  }

  // listafelfrissítés újrarajzolás nélkül, ha épp gépel a felhasználó
  function repaintFriendsList() {
    if (overlayKind !== 'friends' || soc.view !== 'list') return;
    var ae = document.activeElement;
    if (ae && el.overlayBody && el.overlayBody.contains(ae) && /^(INPUT|TEXTAREA)$/.test(ae.tagName)) return;
    el.overlayBody.innerHTML = friendsListHtml();
  }

  function scrollChat() {
    var box = document.getElementById('chatMsgs');
    if (box) box.scrollTop = box.scrollHeight;
  }

  function markSeen(convId) {
    if (!convId) return;
    soc.seen[convId] = Date.now();
    writeJSON(CHAT_KEY, soc.seen);
    var c = convById(convId);
    if (c) c.unread = 0;
    updateFriendsDot();
  }

  function refreshFriendData() {
    if (!sb || !account.user) { updateFriendsDot(); return Promise.resolve(); }
    return loadFriends().then(loadConvs).then(function () {
      repaintFriendsList();
      updateFriendsDot();
    });
  }

  function openFriendsOverlay() {
    soc.view = 'list';
    soc.chatId = null;
    openOverlay('friends');
    if (!sb || !account.user) { updateFriendsDot(); return; }
    refreshFriendData();
    pollPokes();
  }

  function searchUsers(q) {
    q = String(q == null ? '' : q).trim();
    soc.searchQ = q;
    if (!q) { soc.search = []; renderFriendsView(); return; }
    if (!requireLogin('A kereséshez')) return;
    el.overlayBody.innerHTML = '<div class="chat-hint">Keresés…</div>';
    sb.from('user_names').select('id,display_name')
      .ilike('display_name', '%' + q.replace(/[%_\\]/g, '') + '%')
      .neq('id', account.user.id)
      .limit(20)
      .then(function (res) {
        if (res.error) throw res.error;
        soc.search = (res.data || []).map(function (r) {
          if (r.display_name) soc.names[r.id] = r.display_name;
          return { id: r.id, name: r.display_name || 'Ismeretlen' };
        });
        if (!soc.search.length) toast('Nincs ilyen nevű felhasználó');
        renderFriendsView();
      })
      .catch(function (e) {
        toast('A keresés nem sikerült: ' + authErr(e));
        renderFriendsView();
      });
  }

  function sendFriendRequest(otherId) {
    if (!requireLogin('A felkéréshez')) return;
    sb.from('friend_requests').insert({ sender_id: account.user.id, receiver_id: otherId })
      .then(function (r) {
        if (r.error) {
          if (r.error.code === '23505') { toast('Ez a felkérés már függőben van'); return; }
          throw r.error;
        }
        toast('Felkérés elküldve 🍾');
        refreshFriendData();
      })
      .catch(function (e) { toast('Nem sikerült: ' + authErr(e)); });
  }

  function acceptRequest(otherId) {
    if (!requireLogin('Az elfogadáshoz')) return;
    var uid = account.user.id;
    sb.from('friend_requests').delete().eq('sender_id', otherId).eq('receiver_id', uid)
      .then(function (r) {
        if (r.error) throw r.error;
        return sb.from('friendships').insert(sortedPair(uid, otherId));
      })
      .then(function (r) {
        if (r.error && r.error.code !== '23505') throw r.error;
        toast('Mostantól barátok vagytok 🤝');
        refreshFriendData();
      })
      .catch(function (e) { toast('Nem sikerült: ' + authErr(e)); });
  }

  function declineRequest(otherId) {
    if (!requireLogin('Az elutasításhoz')) return;
    sb.from('friend_requests').delete().eq('sender_id', otherId).eq('receiver_id', account.user.id)
      .then(function (r) { if (r.error) throw r.error; refreshFriendData(); })
      .catch(function (e) { toast('Nem sikerült: ' + authErr(e)); });
  }

  function cancelRequest(otherId) {
    if (!requireLogin('A visszavonáshoz')) return;
    sb.from('friend_requests').delete().eq('sender_id', account.user.id).eq('receiver_id', otherId)
      .then(function (r) { if (r.error) throw r.error; refreshFriendData(); })
      .catch(function (e) { toast('Nem sikerült: ' + authErr(e)); });
  }

  function removeFriend(otherId) {
    if (!requireLogin('Az eltávolításhoz')) return;
    if (!window.confirm('Biztosan törlöd ezt a barátot?')) return;
    var p = sortedPair(account.user.id, otherId);
    sb.from('friendships').delete().eq('user_id', p.user_id).eq('friend_id', p.friend_id)
      .then(function (r) { if (r.error) throw r.error; toast('Eltávolítva a barátok közül'); refreshFriendData(); })
      .catch(function (e) { toast('Nem sikerült: ' + authErr(e)); });
  }

  function sendPoke(otherId) {
    if (!requireLogin('A bökéshez')) return;
    sb.from('pokes').insert({ from_id: account.user.id, to_id: otherId })
      .then(function (r) { if (r.error) throw r.error; toast('Megbökted 🍾'); })
      .catch(function (e) { toast('Nem sikerült: ' + authErr(e)); });
  }

  function openDmWith(otherId, withMsg) {
    if (!requireLogin('A csevegéshez')) return;
    var uid = account.user.id;
    var convId = 'dm-' + [uid, otherId].sort().join('-');

    // A DM azonosítója kiszámítható: ha már létezik (pl. a barátod hozta létre),
    // NEM írjuk felül — az RLS a WITH CHECK feltételt az ON CONFLICT DO NOTHING
    // előtt is ellenőrzi, így a "created_by = auth.uid()" ilyenkor hibát adna.
    sb.from('conversations').select('id').eq('id', convId).maybeSingle()
      .then(function (r) {
        if (r.error) throw r.error;
        if (r.data) return null; // már megvan, a barát hozta létre
        return sb.from('conversations').insert({
          id: convId, kind: 'dm', created_by: uid
        }).then(function (ins) {
          // párhuzamos létrehozásnál 23505 (duplicate) → nincs tennivaló
          if (ins.error && ins.error.code !== '23505') throw ins.error;
          return null;
        });
      })
      .then(function () {
        // 1) ELŐBB a saját tagságom — az RLS a beszélgetés sorát csak tagnak
        //    engedi látni, enélkül a barát tagsága nem szúrható be
        return sb.from('conversation_members').upsert(
          { conversation_id: convId, user_id: uid },
          { onConflict: 'conversation_id,user_id', ignoreDuplicates: true });
      })
      .then(function (r) {
        if (r.error) throw r.error;
        // 2) ezután jöhet a barát (létrehozóként már látom a beszélgetést)
        return sb.from('conversation_members').upsert(
          { conversation_id: convId, user_id: otherId },
          { onConflict: 'conversation_id,user_id', ignoreDuplicates: true });
      })
      .then(function (r) {
        if (r.error) throw r.error;
        return loadConvs();
      })
      .then(function () {
        openChat(convId);
        if (withMsg) return sendChat(convId, withMsg);
      })
      .catch(function (e) { toast('Nem sikerült: ' + authErr(e)); });
  }

  function openChat(convId) {
    if (!requireLogin('A csevegéshez')) return;
    soc.chatId = convId;
    soc.view = 'chat';
    soc.msgs = [];
    if (overlayKind !== 'friends') openOverlay('friends');
    else renderFriendsView();
    refreshChat(true);
  }

  function refreshChat(scroll) {
    var convId = soc.chatId;
    if (!convId || soc.view !== 'chat' || !sb || !account.user) return Promise.resolve();
    return sb.from('messages').select('id,body,created_at,sender_id')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true })
      .limit(300)
      .then(function (res) {
        if (res.error || soc.chatId !== convId || soc.view !== 'chat') return;
        soc.msgs = (res.data || []).map(function (m) {
          return { id: m.id, body: m.body, sender_id: m.sender_id, at: Date.parse(m.created_at) || 0 };
        });
        var box = document.getElementById('chatMsgs');
        if (box) box.innerHTML = msgsHtml();
        if (scroll !== false) scrollChat();
        markSeen(convId);
      })
      .catch(function () { });
  }

  function sendChat(convId, body) {
    body = String(body == null ? '' : body).trim().slice(0, 1000);
    if (!body || !convId || !sb || !account.user) return Promise.resolve();
    var input = document.getElementById('chatInput');
    if (input) input.value = '';
    return sb.from('messages').insert({
      conversation_id: convId,
      sender_id: account.user.id,
      body: body
    })
      .then(function (r) {
        if (r.error) throw r.error;
        return refreshChat(true);
      })
      .catch(function (e) {
        var again = document.getElementById('chatInput');
        if (again) again.value = body;
        toast('Az üzenet nem ment: ' + authErr(e));
      });
  }

  function createGroup(name, memberIds) {
    if (!requireLogin('A csoporthoz')) return;
    name = String(name == null ? '' : name).trim().slice(0, 40);
    if (!name) { toast('Adj nevet a csoportnak'); return; }
    if (!memberIds || !memberIds.length) { toast('Jelölj ki legalább egy tagot'); return; }
    var uid = account.user.id;
    var id = 'grp-' + (window.crypto && window.crypto.randomUUID
      ? window.crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));

    sb.from('conversations').insert({ id: id, kind: 'group', name: name, created_by: uid })
      .then(function (r) {
        if (r.error) throw r.error;
        // 1) előbb a saját taggá válásom (RLS: a beszélgetés csak tagnak látszik)
        return sb.from('conversation_members').upsert(
          { conversation_id: id, user_id: uid },
          { onConflict: 'conversation_id,user_id', ignoreDuplicates: true });
      })
      .then(function (r) {
        if (r.error) throw r.error;
        // 2) utána jöhetnek a többiek
        var rows = memberIds.map(function (u) {
          return { conversation_id: id, user_id: u };
        });
        if (!rows.length) return null;
        return sb.from('conversation_members').upsert(rows, {
          onConflict: 'conversation_id,user_id', ignoreDuplicates: true
        });
      })
      .then(function (r) {
        if (r.error) throw r.error;
        soc.groupPick = [];
        soc.view = 'list';
        return refreshFriendData();
      })
      .then(function () { openChat(id); toast('Csoport létrehozva 👥'); })
      .catch(function (e) { toast('Nem sikerült: ' + authErr(e)); });
  }

  function sharePointToFriend(id) {
    if (!requireLogin('A megosztáshoz')) return;
    soc.pendingPoint = +id;
    soc.view = 'list';
    soc.chatId = null;
    if (overlayKind !== 'friends') openOverlay('friends');
    else renderFriendsView();
    toast('Válaszd ki, kinek küldöd');
  }

  function pollPokes() {
    if (!sb || !account.user) return Promise.resolve();
    var uid = account.user.id;
    return sb.from('pokes').select('id,from_id,created_at')
      .eq('to_id', uid).eq('seen', false)
      .order('created_at', { ascending: false })
      .limit(20)
      .then(function (res) {
        if (res.error || !res.data || !res.data.length) {
          soc.pokes = [];
          updateFriendsDot();
          return;
        }
        soc.pokes = res.data;
        var fresh = res.data.filter(function (p) { return !soc.shownPokes[p.id]; });
        return loadUserNames(fresh.map(function (p) { return p.from_id; })).then(function () {
          fresh.slice(0, 3).forEach(function (p) {
            soc.shownPokes[p.id] = 1;
            toast(nameOf(p.from_id) + ' megbökött 🍾');
          });
          updateFriendsDot();
          return sb.from('pokes').update({ seen: true })
            .in('id', res.data.map(function (p) { return p.id; }));
        });
      })
      .catch(function () { });
  }

  function startSocialTick() {
    if (socialTimer) return;
    socialTimer = setInterval(socialTick, 5000);
  }

  function stopSocialTick() {
    clearInterval(socialTimer);
    socialTimer = 0;
  }

  // egyszerű frissítés: nincs Realtime, csak időzített lekérdezés
  function socialTick() {
    if (!sb || !account.user || document.hidden) return;
    socialTickN++;
    if (overlayKind === 'friends') {
      if (soc.view === 'chat') refreshChat(false);
      else if (soc.view === 'list' && socialTickN % 2 === 0) refreshFriendData();
    }
    if (socialTickN % 3 === 0) pollPokes();
  }

  function friendsClick(e) {
    var t = e.target.closest('[data-fr]');
    if (!t) return;
    var act = t.dataset.fr;
    if (act === 'searchform' || act === 'sendform') return;
    var id = t.dataset.id;

    if (act === 'add') { sendFriendRequest(id); return; }
    if (act === 'accept') { acceptRequest(id); return; }
    if (act === 'decline') { declineRequest(id); return; }
    if (act === 'cancel') { cancelRequest(id); return; }
    if (act === 'remove') { removeFriend(id); return; }
    if (act === 'poke') { sendPoke(id); return; }
    if (act === 'chat') {
      var pid = soc.pendingPoint;
      soc.pendingPoint = null;
      openDmWith(id, pid ? pointUrl(pid) : null);
      return;
    }
    if (act === 'open') { openChat(t.dataset.conv); return; }
    if (act === 'back') { soc.view = 'list'; soc.chatId = null; renderFriendsView(); refreshFriendData(); return; }
    if (act === 'newgroup') { soc.view = 'newgroup'; soc.groupPick = []; renderFriendsView(); return; }
    if (act === 'pick') {
      var i = soc.groupPick.indexOf(id);
      if (i === -1) soc.groupPick.push(id); else soc.groupPick.splice(i, 1);
      renderFriendsView();
      return;
    }
    if (act === 'create') {
      var gi = document.getElementById('groupName');
      createGroup(gi ? gi.value : '', soc.groupPick.slice());
      return;
    }
    if (act === 'cancelpending') { soc.pendingPoint = null; renderFriendsView(); return; }
    if (act === 'link') { closeOverlay(); setDock('dockMap'); return; }
  }

  /* ==================== visszaváltás-napló + kassza ==================== */

  var CASH_KEY = 'vissza.cash.v1';
  var CASH_PRICE = 50;                 // Ft / palack visszaváltási érték
  var CASH_MONTHS = ['jan.', 'febr.', 'márc.', 'ápr.', 'máj.', 'jún.',
                     'júl.', 'aug.', 'szept.', 'okt.', 'nov.', 'dec.'];

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  }

  function cashList() {
    if (!Array.isArray(state.cash)) {
      var v = readJSON(CASH_KEY, []);
      state.cash = Array.isArray(v)
        ? v.filter(function (e) { return e && e.at && e.bottles != null; })
        : [];
    }
    return state.cash;
  }

  function cashSave(list) {
    state.cash = list;
    writeJSON(CASH_KEY, list);
  }

  function fmtFt(n) {
    return Math.round(+n || 0).toLocaleString('hu-HU') + ' Ft';
  }

  function cashMonthKey(at) { return String(at || '').slice(0, 7); }   // 'ÉÉÉÉ-HH'

  function cashMonthTitle(key) {
    var p = String(key || '').split('-');
    var y = +p[0], m = +p[1];
    if (!y || !m || m < 1 || m > 12) return key || '';
    return CASH_MONTHS[m - 1] + ' ' + y;
  }

  function cashFt(entry) {
    return (+entry.bottles || 0) * CASH_PRICE + (+entry.kaucio || 0);
  }

  function cashTotals(list) {
    var now = todayStr().slice(0, 7);
    var t = { bottles: 0, ft: 0, monthBottles: 0, monthFt: 0, count: list.length };
    list.forEach(function (e) {
      var b = +e.bottles || 0;
      t.bottles += b;
      t.ft += cashFt(e);
      if (cashMonthKey(e.at) === now) {
        t.monthBottles += b;
        t.monthFt += cashFt(e);
      }
    });
    return t;
  }

  // utolsó 6 hónap oszlopdiagramja (HTML/CSS, könyvtár nélkül)
  function cashChartHtml(list) {
    var now = new Date();
    var months = [];
    for (var i = 5; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'),
        ft: 0, bottles: 0
      });
    }
    var idx = {};
    months.forEach(function (m, i) { idx[m.key] = i; });
    list.forEach(function (e) {
      var i = idx[cashMonthKey(e.at)];
      if (i == null) return;
      months[i].ft += cashFt(e);
      months[i].bottles += (+e.bottles || 0);
    });

    var max = 1;
    months.forEach(function (m) { if (m.ft > max) max = m.ft; });

    return '<div class="cash-chart" role="img" aria-label="Havi visszaváltás az utolsó hat hónapban">' +
      months.map(function (m, i) {
        var pct = m.ft ? Math.max(8, Math.round((m.ft / max) * 100)) : 0;
        var isNow = i === months.length - 1;
        var lbl = CASH_MONTHS[+m.key.slice(5, 7) - 1];
        return '<div class="cash-bar' + (isNow ? ' is-now' : '') + '" ' +
          'title="' + esc(cashMonthTitle(m.key)) + ': ' + esc(fmtFt(m.ft)) + ' · ' + m.bottles + ' palack">' +
          '<span class="cash-bar-val">' + (m.ft ? esc(fmtFt(m.ft)) : '') + '</span>' +
          '<span class="cash-bar-track"><i style="height:' + pct + '%"></i></span>' +
          '<span class="cash-bar-lbl">' + esc(lbl) + '</span>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  function cashDateText(at) {
    var t = Date.parse(String(at) + 'T00:00:00');
    if (!isFinite(t)) return String(at || '');
    return new Date(t).toLocaleDateString('hu-HU', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function cashRowHtml(e) {
    var b = +e.bottles || 0;
    var k = +e.kaucio || 0;
    return '<div class="cash-row">' +
      '<span class="p-ico" aria-hidden="true">🍾</span>' +
      '<span class="rank-main"><b>' + esc(fmtFt(cashFt(e))) + '</b>' +
      '<small>' + esc(cashDateText(e.at)) + ' · ' + b + ' palack' +
      (k ? ' + ' + esc(fmtFt(k)) + ' kaució' : '') + '</small></span>' +
      '<button class="p-ico-btn" type="button" data-cashdel="' + esc(String(e.id)) + '" ' +
      'title="Törlés" aria-label="Bejegyzés törlése">🗑</button>' +
    '</div>';
  }

  function cashSectionHtml() {
    var list = cashList().slice().sort(function (a, b) {
      if (a.at === b.at) return 0;
      return a.at < b.at ? 1 : -1;
    });
    var t = cashTotals(list);

    var out = '<div class="cash-stats">' +
      '<div class="cash-stat"><b>' + t.bottles.toLocaleString('hu-HU') + '</b><span>palack összesen</span></div>' +
      '<div class="cash-stat is-money"><b>' + esc(fmtFt(t.ft)) + '</b><span>bevétel összesen</span></div>' +
      '<div class="cash-stat"><b>' + t.monthBottles.toLocaleString('hu-HU') + '</b><span>palack e hónapban</span></div>' +
      '<div class="cash-stat is-money"><b>' + esc(fmtFt(t.monthFt)) + '</b><span>bevétel e hónapban</span></div>' +
    '</div>';

    out += cashChartHtml(list);

    out += '<form class="cash-form" data-cash="add">' +
      '<input type="date" name="date" value="' + esc(todayStr()) + '" aria-label="Dátum" required>' +
      '<input type="number" name="bottles" min="1" max="99999" inputmode="numeric" ' +
      'placeholder="Palack (db)" aria-label="Palackok száma" required>' +
      '<input type="number" name="kaucio" min="0" step="10" inputmode="numeric" ' +
      'placeholder="Kaució (Ft)" aria-label="Kaució forintban">' +
      '<button class="btn btn-primary" type="submit">Hozzáadás</button>' +
    '</form>';

    out += list.length
      ? list.map(cashRowHtml).join('')
      : '<div class="chat-hint">Még nincs bejegyzésed. Add meg, hány palackot váltottál vissza — a ' +
        CASH_PRICE + ' Ft/db és a kaució alapján számoljuk a kasszát.</div>';

    return out;
  }

  function cashAddFromForm(form) {
    var date = (form.querySelector('[name="date"]') || {}).value || todayStr();
    var bottles = parseInt((form.querySelector('[name="bottles"]') || {}).value, 10);
    var kaucioRaw = (form.querySelector('[name="kaucio"]') || {}).value;
    var kaucio = kaucioRaw === '' || kaucioRaw == null ? 0 : parseInt(kaucioRaw, 10);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('Adj meg egy dátumot'); return; }
    if (!isFinite(bottles) || bottles < 1) { toast('Adj meg hány palackot váltottál vissza'); return; }
    if (!isFinite(kaucio) || kaucio < 0) { toast('A kaució nem lehet negatív'); return; }

    var list = cashList().slice();
    list.push({
      id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      at: date,
      bottles: Math.min(bottles, 99999),
      kaucio: Math.min(kaucio, 10000000)
    });
    cashSave(list);

    if (overlayKind === 'profile') openOverlay('profile');
    toast('Rögzítve: ' + bottles + ' palack · ' + fmtFt(bottles * CASH_PRICE + kaucio));
  }

  function cashRemove(id) {
    var list = cashList().filter(function (e) { return String(e.id) !== String(id); });
    if (list.length === cashList().length) return;
    cashSave(list);
    if (overlayKind === 'profile') openOverlay('profile');
    toast('Bejegyzés törölve');
  }

  /* ==================== indítás ==================== */

  // rejtett tesztelő felület (pl. GPS nélküli demó: __vissza.navSim())
  window.__vissza = {
    navStart: function () { startNavigation(); },
    navStop: stopNavigation,
    intro: function (on) { if (on === false) introHide(); else introShow(); },
    sheetMap: function () {
      if (!miniMap) return null;
      var c = miniMap.getCanvas();
      return {
        zoom: miniMap.getZoom(),
        center: miniMap.getCenter(),
        styleLoaded: miniMap.isStyleLoaded(),
        loaded: miniMap.loaded(),
        tiles: miniMap.areTilesLoaded(),
        size: c.width + 'x' + c.height
      };
    },
    navSim: navSimulate,
    navState: function () {
      return nav ? { stepIdx: nav.stepIdx, total: nav.total, simPos: nav.simPos, arrived: nav.arrived } : null;
    },
    routeState: function () {
      return state.route ? { name: state.route.point.name, mode: state.route.mode, dist: state.route.dist, dur: state.route.dur } : null;
    }
  };

  function boot() {
    ['searchInput', 'searchClear', 'searchSuggest', 'locateBtn', 'resetBtn', 'panel',
     'panelGrip', 'results', 'resultsLabel', 'resultsCount', 'qbar', 'qbarList', 'qbarGo',
     'dock', 'dockTop', 'dockMap', 'dockProfile', 'dockSearch', 'dockFriends', 'dockFriendsDot',
     'sosBtn', 'sosView', 'sosClose', 'sosArrow', 'sosDist', 'sosBadge', 'sosName',
     'sosAddr', 'sosGo', 'sosNext', 'sosDetail', 'sosMoreList',
     'navView', 'navArrow', 'navDist', 'navStreet', 'navEta', 'navRemain', 'navTotal',
     'navExit', 'navPreview', 'navNext',
     'navStepsBtn', 'navStepsPanel', 'navStepsList', 'navStepsResume',
     'arrive', 'arriveName', 'arriveOk',
     'overlay', 'overlayClose', 'overlayEyebrow', 'overlayTitle', 'overlayBody',
     'authView', 'authClose', 'authEyebrow', 'authTitle', 'authSub', 'authTabs',
     'authTabLogin', 'authTabRegister', 'authForm', 'authEmailField', 'authEmail',
     'authNameField', 'authName', 'authPasswordField', 'authPassword',
     'authPassword2Field', 'authPassword2', 'authMsg', 'authSubmit', 'authForgot', 'authBack',
     'introView', 'introClose', 'introSlides', 'introDots', 'introNext', 'introRegister', 'introLogin', 'introGuest',
     'recentCard', 'recentName', 'recentMeta', 'recentGo',

     'sheetFav', 'sheetFavPc', 'sheetCommunity', 'reportBtns', 'reportStatus',
     'reportFig', 'reportFigHint', 'reportsPop',
     'sheetHero', 'sheetMapHint', 'sheetTopbar',
     'hoursCard', 'hoursOpen', 'hoursClose',
     'sheetShare', 'sheetSharePc', 'shareBox', 'sharePop', 'sharePopBack', 'shareClose',
     'shareTitle', 'shareQr', 'shareUrlText',
     'shareCopy', 'shareNative', 'shareFriend',
     'reviewsBox', 'reviewsList', 'reviewsStatus',
     'sheet', 'sheetScrim', 'sheetType',
     'sheetName', 'sheetAddr', 'sheetDist', 'sheetRate', 'sheetHours', 'sheetMini',
     'sheetStatusBox', 'sheetStatusText', 'sheetStatusSub', 'sheetStatusBar',
     'hoursBlock', 'hoursToggle',
     'sheetClose', 'sheetClosePc', 'sheetRoute', 'copyAddr',
     'toast', 'loader', 'statAll', 'statAuto', 'statKezi', 'toolFilter', 'toolLocate', 'tool3D', 'mapTip',
     'routeCard', 'routeClose', 'routeModes', 'routeDist', 'routeTime', 'routeName',
     'routeAddr', 'routeSteps', 'routeStepsToggle', 'routeStart', 'routeGo', 'routeDetail',
     'stepNav', 'stepPrev', 'stepNext', 'stepLabel', 'stepReset',
     'feedback', 'fbScores', 'fbTags', 'fbNote', 'fbSend', 'fbDelete', 'fbDone',
     'fbScale', 'fbRange', 'fbBigNum', 'fbVerdict'
    ].forEach(function (id) { el[id] = $(id); });

    initMap();
    initFeedbackUI();
    initAuth();
    initSocial();
    placeDock();
    syncDockPill();
    window.addEventListener('resize', debounce(function () { placeDock(); syncDockPill(); placeHoursBlock(); }, 120));
    placeHoursBlock();
    bindEvents();
    loadData();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
