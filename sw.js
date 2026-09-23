// Minimal service worker - exists only so Chrome/Edge offer "Install app"
// (an active service worker with a fetch handler is part of their
// installability check). Deliberately does NOT cache anything: every
// request just passes straight through to the network, so the installed
// app always shows the exact same live site/data as an ordinary browser
// tab, with no separate offline copy to go stale or ever need clearing.
self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
  event.respondWith(fetch(event.request));
});
