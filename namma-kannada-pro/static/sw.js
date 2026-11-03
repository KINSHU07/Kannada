// Service worker: offline shell + cached audio + stale-while-revalidate phrase data.
const V = 'nk-v2';
const SHELL = ['/', '/app.css', '/app.js', '/manifest.webmanifest', '/icon.svg', '/api/scenarios'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
const cacheFirst = async req => { const c = await caches.open(V), hit = await c.match(req); if (hit) return hit; const r = await fetch(req); if (r.ok) c.put(req, r.clone()); return r; };
const swr = async req => { const c = await caches.open(V), hit = await c.match(req); const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit); return hit || net; };
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || e.request.headers.has('range')) return;
  if (u.pathname.startsWith('/api/tts')) return e.respondWith(cacheFirst(e.request));
  if (u.pathname === '/api/scenarios') return e.respondWith(swr(e.request));
  if (u.pathname.startsWith('/api/')) return;
  e.respondWith(swr(e.request));
});
