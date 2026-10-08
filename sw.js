// 同一オリジンは「ネット優先・つながらなければキャッシュ」。
// 版の固定された CDN（地図部品・デザイントークン・フォント）は「キャッシュ優先」で、圏外で起動しても見た目と地図の部品が崩れないようにする。
// 天気・ルート・地図タイル・写真は触らない（タイルは OSM の規約で一括保存が禁止されているため）。
const CACHE = 'mymap-v2';
const SHELL = ['./', 'index.html', 'app.js', 'lib.js', 'style.css', 'config.json', 'manifest.webmanifest', 'icon.svg',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png'];
const CDN = ['https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/', 'https://cdn.jsdelivr.net/npm/@digital-go-jp/design-tokens@2.0.1/',
  'https://fonts.googleapis.com/', 'https://fonts.gstatic.com/'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (CDN.some((p) => e.request.url.startsWith(p))) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      if (r.ok || r.type === 'opaque') { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    })));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(fetch(e.request)
    .then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
