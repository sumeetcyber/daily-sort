/* Daily Sort v39 service worker */
const CACHE_NAME = 'daily-sort-shell-v39';
const APP_SCOPE = self.registration.scope;
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('daily-sort-shell-') && k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (new URL(req.url).pathname.endsWith('/sw.js')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(new Request(req, {cache:'no-store'}));
      if (response.ok && response.type !== 'opaque') await cache.put(req, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const fallback = await cache.match(new URL('./', APP_SCOPE).href);
        if (fallback) return fallback;
      }
      throw error;
    }
  })());
});
