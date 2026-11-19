/* Vissza! – service worker
   Cél: az app és a pont-adatok offline is betöltsenek, a térképcsempék
   pedig a már megnézett területekről maradjanak meg. */

var VERSION = 'v2';
var SHELL_CACHE = 'vissza-shell-' + VERSION;
var DATA_CACHE = 'vissza-data-' + VERSION;
var TILE_CACHE = 'vissza-tiles';
var CDN_CACHE = 'vissza-cdn-' + VERSION;
var TILE_LIMIT = 450;

var SHELL_ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './manifest.webmanifest',
  './assets/img/icon-192.png',
  './assets/img/icon-512.png',
  './assets/img/icon.svg',
  './map/style.json',
  './data/repontok-meta.json'
];

var DATA_ASSETS = [
  './data/repontok.json',
  './data/zip-megye.json'
];

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    var shell = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL_ASSETS.map(function (url) {
      return shell.add(new Request(url, { cache: 'reload' })).catch(function () { });
    }));
    var data = await caches.open(DATA_CACHE);
    await Promise.all(DATA_ASSETS.map(function (url) {
      return data.add(new Request(url, { cache: 'reload' })).catch(function () { });
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    var keep = [SHELL_CACHE, DATA_CACHE, TILE_CACHE, CDN_CACHE];
    var keys = await caches.keys();
    await Promise.all(keys.map(function (k) {
      if (keep.indexOf(k) === -1) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('message', function (event) {
  var msg = event.data || {};
  if (msg.type === 'SKIP_WAITING') self.skipWaiting();
  if (msg.type === 'VERSION') {
    event.source && event.source.postMessage({ type: 'VERSION', version: VERSION });
  }
});

function isTile(url) {
  return /(^|\.)tiles\.openfreemap\.org$/.test(url.hostname) ||
    /(^|\.)tile\.openstreetmap\.org$/.test(url.hostname);
}

function isCdn(url) {
  return url.hostname === 'cdn.jsdelivr.net' ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com' ||
    url.hostname === 'unpkg.com';
}

async function trimCache(name, max) {
  var cache = await caches.open(name);
  var keys = await cache.keys();
  if (keys.length <= max) return;
  for (var i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

/* hálózat előbb, cache a tartalék – adatnál ez a helyes sorrend */
async function networkFirst(request, cacheName) {
  var cache = await caches.open(cacheName);
  try {
    var res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    var hit = await cache.match(request, { ignoreSearch: true });
    if (hit) {
      var headers = new Headers(hit.headers);
      headers.set('x-vissza-offline', '1');
      return new Response(hit.body, { status: 200, headers: headers });
    }
    throw e;
  }
}

/* cache előbb, háttérben frissítés – statikus fájloknál */
async function staleWhileRevalidate(request, cacheName) {
  var cache = await caches.open(cacheName);
  var hit = await cache.match(request, { ignoreSearch: true });
  var network = fetch(request).then(function (res) {
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  }).catch(function () { return null; });
  if (hit) return hit;
  var res = await network;
  if (res) return res;
  return new Response('', { status: 504, statusText: 'Offline' });
}

/* csempék: cache előbb, és max. TILE_LIMIT darabig gyűjtünk */
async function tileFirst(request) {
  var cache = await caches.open(TILE_CACHE);
  var hit = await cache.match(request);
  if (hit) return hit;
  try {
    var res = await fetch(request);
    if (res && res.ok) {
      cache.put(request, res.clone());
      trimCache(TILE_CACHE, TILE_LIMIT);
    }
    return res;
  } catch (e) {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url;
  try { url = new URL(request.url); } catch (e) { return; }

  // Supabase / auth / analytics: soha nem cache-elünk
  if (/supabase\.co$/.test(url.hostname)) return;

  if (isTile(url)) {
    event.respondWith(tileFirst(request));
    return;
  }

  if (isCdn(url)) {
    event.respondWith(staleWhileRevalidate(request, CDN_CACHE));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // oldalbetöltés: hálózat, hiba esetén a mentett shell
  if (request.mode === 'navigate') {
    event.respondWith((async function () {
      try {
        var res = await fetch(request);
        if (res && res.ok) {
          var cache = await caches.open(SHELL_CACHE);
          cache.put('./index.html', res.clone());
        }
        return res;
      } catch (e) {
        var cache2 = await caches.open(SHELL_CACHE);
        var page = await cache2.match('./index.html') || await cache2.match('./');
        if (page) {
          var headers = new Headers(page.headers);
          headers.set('x-vissza-offline', '1');
          return new Response(page.body, { status: 200, headers: headers });
        }
        return new Response('Az app offline állapotban van, és a mentett változat nem található.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })());
    return;
  }

  if (url.pathname.indexOf('/data/') > -1) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  // kód és stílus: mindig friss (offline a cache-ből) – így egy kiadás után
  // nem marad a régi CSS/JS a böngészőben
  if (/\.(css|js|json|webmanifest)$/.test(url.pathname)) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});

/* --- web push (B szint): értesítés zárt appnál is --- */

self.addEventListener('push', function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }

  var title = data.title || 'Vissza!';
  var options = {
    body: data.body || '',
    icon: './assets/img/icon-192.png',
    badge: './assets/img/icon-192.png',
    lang: 'hu',
    tag: data.tag || 'vissza-ann',
    data: { url: data.url || './' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || './';

  event.waitUntil((async function () {
    var all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (var i = 0; i < all.length; i++) {
      var c = all[i];
      if ('focus' in c) {
        try { await c.navigate(target); } catch (e) { }
        return c.focus();
      }
    }
    if (clients.openWindow) return clients.openWindow(target);
  })());
});
