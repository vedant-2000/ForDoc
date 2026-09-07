'use strict';

// Minimal service worker — installability only, deliberately no caching.
//
// WHY THIS FILE EXISTS
// Chrome and Edge only fire `beforeinstallprompt` (the event the in-app
// "Install Treatment Plan" banner waits for, see
// lib/widgets/pwa_install_prompt_web.dart) when the site is HTTPS, has a
// valid manifest AND has a registered service worker with a fetch handler.
// Flutter used to generate that worker. As of Flutter 3.41 the generated
// `flutter_service_worker.js` is a stub whose only job is to call
// `self.registration.unregister()` — Flutter has dropped its service worker
// entirely. With no worker registered the install event never fires and the
// browser offers only a plain "Add to Home screen" bookmark, so the app has
// to ship its own worker now.
//
// WHY IT CACHES NOTHING
// This is a clinical record app: a cached page could show a doctor a stale
// patient chart or a stale stock count. The fetch handler therefore goes
// straight to the network for everything and stores nothing. That satisfies
// the installability requirement without introducing any staleness. The app
// has no offline mode, which Chrome no longer requires for installability.
//
// If offline support is ever wanted, cache ONLY the content-addressed build
// assets (main.dart.js, canvaskit/, assets/) keyed on version.json — never
// /api/ responses and never index.html.

self.addEventListener('install', () => {
  // Take over immediately rather than waiting for every tab to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Purge anything an older Flutter-generated (offline-first) worker left
      // behind. Without this, a device that installed a previous build could
      // keep serving that build's cached bundle indefinitely.
      try {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      } catch (e) {
        console.warn('Failed to clear old caches:', e);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Anything other than a same-origin GET is left entirely alone: uploads,
  // logins, mark saves and Drive calls must never be touched by the worker.
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // The API, uploaded body images and the server-rendered runtime config are
  // explicitly none of our business — let the browser handle them so their
  // own cache headers apply unchanged.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/uploads/') ||
    url.pathname === '/config.js'
  ) {
    return;
  }

  // Everything else: straight to the network, nothing stored. This is a real
  // fetch handler (not an empty one, which browsers skip), which is what makes
  // the app installable.
  event.respondWith(fetch(request));
});
