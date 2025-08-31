// PearMessenger Service Worker
fetch('./manifest.json').then(r => r.json()).then(manifest => {
  const APP_VERSION = manifest.version || '0';
  const CACHE_NAME = `peermsg-cache-v${APP_VERSION}`;

  const urlsToCache = [
    './','./index.html','./manifest.json','./site.webmanifest','./sw.js',
    './app.js','./db.js','./crypto.js','./webrtc.js','./offline.html'
  ];

  self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache)));
    self.skipWaiting();
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys().then(names => Promise.all(names.map(n => { if(n !== CACHE_NAME) return caches.delete(n); }))));
    self.clients.claim();
  });

  self.addEventListener('fetch', (event) => {
    const req = event.request;
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req).catch(() => {
        if (req.headers.get('accept')?.includes('text/html')) return caches.match('./offline.html');
      }))
    );
  });
}).catch(err => console.error('SW failed to read manifest:', err));
