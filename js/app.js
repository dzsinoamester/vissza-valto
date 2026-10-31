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

  var EMPTY_FC = { type: 'FeatureCollection', features: [] };

  var el = {};
  var map = null, popup = null, meMarker = null;
  var selectedId = null;
  var handlersBound = false;
  var ready = { data: false, style: false };
  var pendingPlace = null;   // a stílus betöltéséig függőben lévő „tegyük le a jelölőt" lépés
  var nav = null;            // aktív turn-by-turn navigáció állapota

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
  }

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

  function initMap() {
    map = new maplibregl.Map({
      container: 'map',
      style: 'https://tiles.openfreemap.org/styles/dark',
      center: [19.4597, 47.1625],
      zoom: 6.9,
      minZoom: 6,
      maxZoom: 18,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
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
    map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: false }), 'bottom-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'top-right');
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
    addDataLayers();
    if (selectedId != null) setSelected(selectedId);
    if (state.route) drawRouteLayer(state.route.geojson);
    bindLayerHandlers();
    ready.style = true;
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

  /* --- pontok + klűszerek + útvonal --- */

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

      map.addLayer({
        id: 'repont-clusters', type: 'circle', source: 'repont',
        filter: ['has', 'point_count'],
        paint: {
          'circle-radius': ['step', ['get', 'point_count'], 16, 10, 20, 50, 25, 200, 31],
          'circle-color': 'rgba(4,5,6,.9)',
          'circle-stroke-color': '#D8E02F',
          'circle-stroke-width': 2
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
        paint: { 'text-color': '#D8E02F' }
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
      map.addSource('route', { type: 'geojson', data: EMPTY_FC });
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
          'line-opacity': .95,
          'line-dasharray': [1.2, 1.4]
        }
      });
      // az útvonal mentén futó „csillogás"
      map.addLayer({
        id: 'route-flow', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#FFFFFF',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 15, 2.6],
          'line-opacity': .55,
          'line-dasharray': [0.2, 2.6]
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
    return steps.map(function (s) {
      var ico = stepIcon(s.maneuver);
      return '<div class="rstep">' +
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

  function startRoute(p, mode, opts) {
    mode = mode || (state.route && state.route.point === p ? state.route.mode : 'driving');

    if (!state.me) {
      askLocation({ route: p.id, navigate: !!(opts && opts.navigate) });
      return;
    }

    if (routeAbort) routeAbort.abort();
    routeAbort = new AbortController();

    var me = state.me;
    var url = OSRM + mode + '/' + me.lng + ',' + me.lat + ';' + p.lng + ',' + p.lat +
      '?overview=full&geometries=geojson&steps=true&annotations=false';

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

    fetch(url, { signal: routeAbort.signal })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j.routes || !j.routes.length) throw new Error('nincs útvonal');
        var rt = j.routes[0];
        var leg = rt.legs && rt.legs[0];
        state.route.dist = rt.distance;
        state.route.dur = rt.duration;
        state.route.steps = (leg && leg.steps) || null;
        state.route.geojson = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: rt.geometry, properties: {} }] };

        drawRouteLayer(state.route.geojson);
        el.routeDist.textContent = fmtDist(rt.distance);
        el.routeTime.textContent = fmtDur(rt.duration);
        el.routeSteps.innerHTML = routeStepsHtml(state.route.steps);
        el.routeStepsToggle.hidden = !(state.route.steps && state.route.steps.length > 3);
        el.routeSteps.hidden = true;

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
    document.body.classList.remove('is-routing');
    drawRouteLayer(null);
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
    startWatch();
    if (state.me) navUpdate(state.me);
    else toast('Kövesd a nyilakat — a helyzeted frissítése folyamatban');
  }

  function stopNavigation() {
    nav = null;
    el.navView.hidden = true;
    el.arrive.hidden = true;
    el.navNext.hidden = true;
    document.body.classList.remove('is-nav');
    if (state.route && state.route.geojson && state.route.geojson.features.length) {
      fitRoute(state.route.geojson.features[0].geometry.coordinates, state.route.point);
    }
  }

  function navArrived() {
    if (!nav || nav.arrived) return;
    nav.arrived = true;
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
        var ra = store[a.id] ? store[a.id].score : -1;
        var rb = store[b.id] ? store[b.id].score : -1;
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
    else el.resultsLabel.textContent = state.me ? 'Legközelebbi pontok' : 'Minden pont';

    var top = state.filtered.slice(0, 80);
    if (!top.length) {
      el.results.innerHTML = '<div class="empty">' +
        (state.filter === 'rated'
          ? 'Még nem értékeltél egy pontot sem.<br>Nyiss meg egy REpontot, és osztályozd 1–10-ig.'
          : 'Nincs ilyen találat.<br>Próbálj másik települést vagy címet.') +
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
            : '') +
        '</span>' +
      '</span>' +
      (p._d != null
        ? '<span class="card-dist">' + fmtDist(p._d) + '<small>tőled</small></span>'
        : '') +
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
    el.sheetStatus.innerHTML = bigPill(st);
    el.sheetDist.textContent = p._d != null ? fmtDist(p._d) + ' tőled' : '';
    refreshSheetRate();

    var hrs = hoursOf(p);
    var order = [1, 2, 3, 4, 5, 6, 0];
    var names = { 1: 'Hétfő', 2: 'Kedd', 3: 'Szerda', 4: 'Csütörtök', 5: 'Péntek', 6: 'Szombat', 0: 'Vasárnap' };
    var today = now.getDay();
    el.sheetHours.innerHTML = order.map(function (d) {
      var r = !hrs ? null : (d === 0 ? hrs.v : (d === 6 ? hrs.s : hrs.h));
      var txt = r ? esc(r.text) : 'Zárva';
      return '<tr' + (d === today ? ' class="is-today"' : '') + '><th>' + names[d] + '</th>' +
        '<td' + (r ? '' : ' class="closed"') + '>' + txt + '</td></tr>';
    }).join('');

    var ll = p.lat + ',' + p.lng;
    el.navGoogle.href = NAV_GOOGLE + ll;
    el.navWaze.href = NAV_WAZE + ll + '?navigate=yes';
    el.navApple.href = NAV_APPLE + ll;
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

    el.sheet.hidden = false;
    el.sheetScrim.hidden = false;
  }

  function closeSheet() {
    el.sheet.hidden = true;
    el.sheetScrim.hidden = true;
  }

  /* ==================== ranglista / profil ==================== */

  function openOverlay(kind) {
    var store = loadFbStore();
    var ids = Object.keys(store);

    if (kind === 'top') {
      el.overlayEyebrow.textContent = 'Ranglista';
      el.overlayTitle.textContent = 'Legjobbra értékelt pontok';
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
    } else {
      el.overlayEyebrow.textContent = 'Profil';
      el.overlayTitle.textContent = 'Az értékeléseid';
      if (!ids.length) {
        el.overlayBody.innerHTML = '<div class="overlay-empty">Még nincs egy értékelésed sem.<br>' +
          'Váltass vissza egy automatánál, és értékeld 1–10-ig — a többieknek is segítesz.</div>';
      } else {
        var sum = 0, best = null, tags = {};
        ids.forEach(function (id) {
          var d = store[id];
          sum += d.score || 0;
          if (!best || (d.score || 0) > best.score) best = { id: id, score: d.score };
          (d.tags || []).forEach(function (t) { tags[t] = (tags[t] || 0) + 1; });
        });
        var avg = (sum / ids.length).toFixed(1).replace('.', ',');
        var bestP = best ? state.byId.get(+best.id) : null;
        var topTags = Object.keys(tags).sort(function (a, b) { return tags[b] - tags[a]; }).slice(0, 4);

        el.overlayBody.innerHTML =
          '<div class="profile-stats">' +
            '<div class="profile-stat"><b>' + ids.length + '</b><span>értékelt pont</span></div>' +
            '<div class="profile-stat"><b>' + avg + '</b><span>átlag / 10</span></div>' +
            '<div class="profile-stat"><b>' + best.score + '</b><span>legjobb</span></div>' +
          '</div>' +
          (bestP
            ? '<div class="rank-row" data-id="' + bestP.id + '">' +
                scoreBadge(best.score) +
                '<span class="rank-main"><b>Kedvenc REpontod: ' + esc(bestP.name) + '</b>' +
                '<small>' + esc(addrText(bestP)) + '</small></span>' +
              '</div>'
            : '') +
          (topTags.length
            ? '<div class="fb-tags" style="margin-top:14px">' + topTags.map(function (t) {
                var label = (FB_TAGS.filter(function (x) { return x.id === t; })[0] || {}).label || t;
                return '<span class="fb-tag is-on">' + esc(label) + ' ×' + tags[t] + '</span>';
              }).join('') + '</div>'
            : '');
      }
    }

    el.overlay.hidden = false;
    document.body.classList.add('is-page');
  }

  function closeOverlay() { el.overlay.hidden = true; document.body.classList.remove('is-page'); }

  /* ==================== geolokáció ==================== */

  var pendingRoute = null;   // { id, navigate }

  function askLocation(req) {
    if (!navigator.geolocation) {
      toast('A böngésződ nem támogatja a helymeghatározást');
      return;
    }
    var why = 'locate';
    if (req && req.route != null) { pendingRoute = { id: req.route, navigate: !!req.navigate }; why = 'route'; }
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
        if (p) { startRoute(p, null, { navigate: pr.navigate }); return; }
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
      maybeHideLoader();
      applyFilters();
      loadMeta();
      var pos = positionFromHash();
      if (pos) setMe(pos.lat, pos.lng, null);
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
      document.body.classList.remove('is-search');
      el.panel.classList.remove('is-expanded');
    }
  }

  // Mobilon a keresőpanel alapból rejtve van, csak a Keresés gombra jön be
  function setSearchOpen(open) {
    var on = !!open && isMobile();
    document.body.classList.toggle('is-search', on);
    if (!on) el.panel.classList.remove('is-expanded');
    setTimeout(function () { map.resize(); }, 340);
  }

  function setDock(activeId) {
    ['dockTop', 'dockMap', 'dockProfile', 'dockSearch'].forEach(function (id) {
      if (el[id]) el[id].classList.toggle('is-active', id === activeId);
    });
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
      state.query = '';
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
    // Indítás → appon belüli turn-by-turn navigáció
    el.routeStart.addEventListener('click', function () {
      if (nav) { toast('A navigáció már fut'); return; }
      if (state.route && state.route.geojson) startNavigation();
      else if (state.route && state.route.point) startRoute(state.route.point, null, { navigate: true });
    });

    // Navigációs HUD
    el.navExit.addEventListener('click', stopNavigation);
    el.navPreview.addEventListener('click', navPreviewNext);
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
    el.toolFilter.addEventListener('click', function () {
      closeOverlay();
      setDock('dockSearch');
      setSearchOpen(true);
    });

    // Dokk
    el.dockTop.addEventListener('click', function () { setSearchOpen(false); openOverlay('top'); setDock('dockTop'); });
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
      // mobilon: újabb koppintás a Keresésre bezárja a panelt
      if (isMobile() && document.body.classList.contains('is-search') && el.dockSearch.classList.contains('is-active')) {
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

    // Overlay
    el.overlayClose.addEventListener('click', function () { closeOverlay(); setDock('dockMap'); });
    el.overlay.addEventListener('click', function (e) {
      if (e.target === el.overlay) { closeOverlay(); setDock('dockMap'); return; }
      var row = e.target.closest('.rank-row');
      if (row) {
        closeOverlay();
        setDock('dockMap');
        select(+row.dataset.id, {});
      }
    });

    el.sheetClose.addEventListener('click', closeSheet);
    el.sheetScrim.addEventListener('click', closeSheet);

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
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

  /* ==================== indítás ==================== */

  // rejtett tesztelő felület (pl. GPS nélküli demó: __vissza.navSim())
  window.__vissza = {
    navStart: function () { startNavigation(); },
    navStop: stopNavigation,
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
     'dock', 'dockTop', 'dockMap', 'dockProfile', 'dockSearch',
     'sosBtn', 'sosView', 'sosClose', 'sosArrow', 'sosDist', 'sosBadge', 'sosName',
     'sosAddr', 'sosGo', 'sosNext', 'sosDetail', 'sosMoreList',
     'navView', 'navArrow', 'navDist', 'navStreet', 'navEta', 'navRemain', 'navTotal',
     'navExit', 'navPreview', 'navNext',
     'arrive', 'arriveName', 'arriveOk',
     'overlay', 'overlayClose', 'overlayEyebrow', 'overlayTitle', 'overlayBody',
     'sheet', 'sheetScrim', 'sheetType',
     'sheetName', 'sheetAddr', 'sheetStatus', 'sheetDist', 'sheetRate', 'sheetHours',
     'sheetClose', 'sheetRoute', 'navGoogle', 'navWaze', 'navApple', 'copyAddr',
     'toast', 'loader', 'statAll', 'statAuto', 'statKezi', 'toolFilter', 'toolLocate',
     'routeCard', 'routeClose', 'routeModes', 'routeDist', 'routeTime', 'routeName',
     'routeAddr', 'routeSteps', 'routeStepsToggle', 'routeStart', 'routeGo', 'routeDetail',
     'feedback', 'fbScores', 'fbTags', 'fbNote', 'fbSend', 'fbDelete', 'fbDone'
    ].forEach(function (id) { el[id] = $(id); });

    initMap();
    initFeedbackUI();
    placeDock();
    window.addEventListener('resize', debounce(placeDock, 120));
    bindEvents();
    loadData();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
