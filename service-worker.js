/* Event PWA service worker — app-shell caching + OneSignal push handling.
 * OneSignal is configured (serviceWorkerPath) to use THIS file, so there is a
 * single service worker for the scope and no registration conflicts. */
try {
  importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');
} catch (err) {
  // Offline or OneSignal unreachable: keep the app shell working without push.
}

const CACHE_VERSION = 'v1.7.1';
const SHELL_CACHE = `event-shell-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './config.js',
  './styles.css',
  './manifest.json',
  './icons/icon-80.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/mandala.svg',
  './fonts/poppins-latin-400-normal.woff2',
  './fonts/poppins-latin-600-normal.woff2',
  './fonts/yatra-one-latin-400-normal.woff2',
  './fonts/yatra-one-devanagari-400-normal.woff2',
];

// Never intercept: live data, auth and push infrastructure.
const BYPASS_HOSTS = [
  'script.google.com',
  'script.googleusercontent.com',
  'accounts.google.com',
  'oauth2.googleapis.com',
  'onesignal.com',
  'cdn.onesignal.com',
  'api.onesignal.com',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('event-') && k !== SHELL_CACHE)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (BYPASS_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) return;

  // HTML navigations: network-first so updates land quickly, cached shell offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (isShellResponse(request, res)) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html', { ignoreSearch: true }))
    );
    return;
  }

  // Only same-origin static files are cached; nothing user-specific ever goes through here.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
  }
});

// Only the app's own root/index.html HTML may replace the cached offline shell.
const SCOPE_PATH = new URL('./', self.location.href).pathname;
function isShellResponse(request, res) {
  if (!res.ok || res.type !== 'basic') return false;
  const url = new URL(res.url || request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.pathname !== SCOPE_PATH && url.pathname !== `${SCOPE_PATH}index.html`) return false;
  return (res.headers.get('content-type') || '').includes('text/html');
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((res) => {
      if (res?.ok && res.type === 'basic') cache.put(request, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener('message', (event) => {
  // Only our own pages may control the worker.
  if (event.origin !== self.location.origin) return;
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
