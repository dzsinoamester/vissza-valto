/* Vissza! landing – élő térkép a valódi pontokból.
   A térkép ugyanazt a stílust (map/style.json) és ugyanazokat a pontokat használja,
   mint az app; a jelölőre koppintva a lapka az adott pontra vált. */

(function () {
  'use strict';

  // Valódi pontok a data/repontok.json-ból (budapesti válogatás, 2026. 10. 31.)
  var POINTS = [
    { id: 17, t: 'automata', n: 'Lidl', a: '1051 Budapest, Arany János utca 27–29.', lat: 47.50224, lng: 19.05306, h: '6:30–21:00' },
    { id: 18, t: 'automata', n: 'Lidl', a: '1074 Budapest, Rákóczi út 48–50.', lat: 47.49749, lng: 19.07103, h: '6:30–21:00' },
    { id: 19, t: 'automata', n: 'Lidl', a: '1053 Budapest, Ferenciek tere 2.', lat: 47.49304, lng: 19.05567, h: '6:30–21:00' },
    { id: 21, t: 'automata', n: 'Lidl', a: '1132 Budapest, Victor Hugo utca 11–15.', lat: 47.51778, lng: 19.05795, h: '7:00–22:00' },
    { id: 22, t: 'automata', n: 'Lidl', a: '1087 Budapest, Hungária körút 26.', lat: 47.49532, lng: 19.10842, h: '6:30–21:30' },
    { id: 3004, t: 'kezi', n: 'Thököly Csemege', a: '1145 Budapest, Thököly út 122.', lat: 47.51432, lng: 19.10321, h: '6:00–21:00' },
    { id: 3034, t: 'kezi', n: 'Mázli ABC', a: '1188 Budapest, Nagykőrösi utca 51.', lat: 47.40345, lng: 19.18634, h: '6:30–21:00' },
    { id: 3109, t: 'kezi', n: 'Reál Élelmiszer Viola ABC', a: '1195 Budapest, Ady Endre út 172.', lat: 47.44735, lng: 19.15065, h: '6:00–21:00' },
    { id: 3111, t: 'kezi', n: 'Uzsidoboz Csemege', a: '1204 Budapest, Nagysándor József utca 59.', lat: 47.43579, lng: 19.10949, h: '6:30–19:30' }
  ];

  var el = {
    map: document.getElementById('landingMap'),
    type: document.getElementById('lmType'),
    hours: document.getElementById('lmHours'),
    name: document.getElementById('lmName'),
    addr: document.getElementById('lmAddr'),
    open: document.getElementById('lmOpen')
  };
  /* --- finom megjelenés görgetésre --- */
  document.body.classList.add('js-reveal');
  var revealNodes = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
    revealNodes.forEach(function (n) { io.observe(n); });
  } else {
    revealNodes.forEach(function (n) { n.classList.add('is-in'); });
  }

  /* --- fejléc: árnyék, olvasási progress, aktív szekció --- */
  var shell = document.querySelector('.nav-shell');
  var progress = document.getElementById('navProgress');
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.nav-center a[data-nav]'));
  var pill = document.getElementById('navPill');
  var activeId = '';

  function movePill(link) {
    if (!pill) return;
    if (!link) { pill.classList.remove('is-on'); return; }
    pill.style.width = link.offsetWidth + 'px';
    pill.style.transform = 'translateX(' + link.offsetLeft + 'px)';
    pill.classList.add('is-on');
  }

  var sectionIds = ['hogyan', 'lapka', 'sos', 'kozosseg'];

  function onScroll() {
    if (shell) shell.classList.toggle('is-scrolled', window.scrollY > 6);
    if (progress) {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var ratio = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      progress.style.transform = 'scaleX(' + ratio + ')';
    }
    var mid = window.innerHeight * 0.5;
    var current = '';
    sectionIds.forEach(function (id) {
      var section = document.getElementById(id);
      if (!section) return;
      var box = section.getBoundingClientRect();
      if (box.top <= mid && box.bottom >= mid) current = id;
    });
    setActive(current);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  onScroll();

  function setActive(id) {
    if (id === activeId) return;
    activeId = id;
    var active = null;
    navLinks.forEach(function (link) {
      var on = link.getAttribute('href') === '#' + id;
      link.classList.toggle('is-active', on);
      if (on) active = link;
    });
    movePill(active);
  }

  window.addEventListener('resize', function () {
    var active = document.querySelector('.nav-center a.is-active');
    if (active) movePill(active);
  });

  /* --- teljes képernyős mobil menü --- */
  var burger = document.getElementById('navBurger');
  var menu = document.getElementById('mobileMenu');
  var menuClose = document.getElementById('menuClose');

  function setMenu(open) {
    if (!menu) return;
    menu.toggleAttribute('hidden', !open);
    document.body.classList.toggle('menu-open', open);
    if (burger) {
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      burger.setAttribute('aria-label', open ? 'Menü bezárása' : 'Menü megnyitása');
    }
  }

  if (burger) {
    burger.addEventListener('click', function () {
      setMenu(menu ? menu.hasAttribute('hidden') : false);
    });
  }
  if (menuClose) menuClose.addEventListener('click', function () { setMenu(false); });
  if (menu) {
    menu.addEventListener('click', function (ev) {
      if (ev.target.closest('a')) setMenu(false);
    });
  }
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') setMenu(false);
  });

  /* --- vissza a tetejére --- */
  var toTop = document.getElementById('toTop');
  if (toTop) {
    toTop.addEventListener('click', function () {
      var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    });
  }

  if (!el.map) return;

  var pins = [];
  var current = null;

  function select(point, pinEl) {
    current = point;
    el.type.textContent = point.t === 'automata' ? 'Automata' : 'Kézi pont';
    el.type.style.color = point.t === 'automata' ? '#FFC0A8' : '#A5E9F8';
    el.name.textContent = point.n;
    el.addr.textContent = point.a;
    el.hours.textContent = 'Ma ' + point.h;
    el.open.href = 'app/#pont/' + point.id;
    pins.forEach(function (p) {
      var on = p.point === point;
      p.el.classList.toggle('is-on', on);
      p.el.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (pinEl) pinEl.blur();
  }

  function fail() {
    el.map.style.display = 'none';
  }

  import('https://cdn.jsdelivr.net/npm/maplibre-gl@6.16.0/dist/maplibre-gl.mjs')
    .then(function (mod) {
      var maplibregl = mod.default || mod;
      if (!maplibregl || typeof maplibregl.Map !== 'function') return fail();

      var map = new maplibregl.Map({
        container: el.map,
        style: 'map/style.json',
        center: [19.09, 47.47],
        zoom: 11.6,
        attributionControl: { compact: true },
        dragRotate: false,
        pitchWithRotate: false,
        scrollZoom: false,
        touchZoomRotate: false,
        fadeDuration: 200
      });

      map.on('error', function (e) {
        // Csempesor hiba esetén a háttér (lm-fallback) marad látható.
        if (e && e.error && /style/i.test(String(e.error.message))) fail();
      });

      var bounds = new maplibregl.LngLatBounds();

      POINTS.forEach(function (point) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'pin' + (point.t === 'kezi' ? ' pin-manual' : '');
        b.setAttribute('aria-label', point.n + ' – ' + point.a);
        b.setAttribute('aria-pressed', 'false');
        b.title = point.n + ' · ' + point.a;
        b.addEventListener('click', function (ev) {
          ev.stopPropagation();
          select(point, b);
        });

        new maplibregl.Marker({ element: b, anchor: 'center' })
          .setLngLat([point.lng, point.lat])
          .addTo(map);

        pins.push({ point: point, el: b });
        bounds.extend([point.lng, point.lat]);
      });

      // saját pozíció (a hero illusztrációja)
      var me = document.createElement('div');
      me.className = 'user-dot';
      new maplibregl.Marker({ element: me, anchor: 'center' })
        .setLngLat([19.0541, 47.4979])
        .addTo(map);

      map.on('load', function () {
        map.fitBounds(bounds, { padding: 80, maxZoom: 13.1, duration: 0 });
      });

      select(POINTS[1], null);
    })
    .catch(fail);
})();
