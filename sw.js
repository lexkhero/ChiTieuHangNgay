// Cache giao diện để mở được khi mất mạng. Dữ liệu (Apps Script) luôn lấy qua mạng.
const CACHE = 'cthn-v3-21';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'classifier.js', 'loan-engine.js', 'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Mạng trước, lỗi mạng thì dùng cache -> luôn nhận bản mới khi có mạng
  // cache: 'no-cache' = luôn hỏi lại máy chủ (ETag) nên nhận bản mới ngay, không bị trình duyệt giữ bản cũ
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
