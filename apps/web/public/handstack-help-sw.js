const CACHE_NAME = 'handstack-help-v1';
const HELP_SCOPE = '/help';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    !url.pathname.startsWith(HELP_SCOPE)
  )
    return;
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((response) => {
          if (response.ok)
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
          return response;
        }),
    ),
  );
});
