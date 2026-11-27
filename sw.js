const CACHE_NAME = 'daily-sort-shell-v52';
const APP_SCOPE = self.registration.scope;
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k.startsWith('daily-sort-shell-') && k !== CACHE_NAME).map(k => caches.delete(k)));
  await self.clients.claim();
})()));
self.addEventListener('message', event => { if (event.data?.type === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin || new URL(req.url).pathname.endsWith('/sw.js')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const res = await fetch(new Request(req, {cache:'no-store'}));
      if (res.ok && res.type !== 'opaque') await cache.put(req, res.clone());
      return res;
    } catch (e) {
      const hit = await cache.match(req);
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const fallback = await cache.match(new URL('./', APP_SCOPE).href);
        if (fallback) return fallback;
      }
      throw e;
    }
  })());
});
