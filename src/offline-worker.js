// The production build prepends the exact public files for this release.
const base = new URL('./', self.location.href);
const prefix = 'two-charts-offline:' + base.pathname + ':';
const cacheName = prefix + offline.version;
const urls = offline.files.map(file => new URL(file, base).href);
const staticAssets = new Set(urls.filter(url => new URL(url).pathname.startsWith(base.pathname + 'assets/')));
const index = new URL('index.html', base).href;
const pagePaths = new Set([base.pathname, new URL(index).pathname]);
const config = new URL('firebase.local.json', base).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll(urls.map(url => new Request(url, {cache: 'reload', redirect: 'error'})));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const installed = await caches.keys();
    await Promise.all(installed.filter(name => name.startsWith(prefix) && name !== cacheName)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function networkWithOfflineCopy(request, fallback) {
  try {
    return await fetch(request);
  } catch (error) {
    const stored = await caches.match(fallback, {cacheName});
    if (stored) return stored;
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const {request} = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== base.origin) return;

  if (request.mode === 'navigate' && pagePaths.has(url.pathname)) {
    event.respondWith(networkWithOfflineCopy(request, index));
  } else if (url.href === config && urls.includes(config)) {
    event.respondWith(networkWithOfflineCopy(request, config));
  } else if (staticAssets.has(url.href)) {
    // Module requests and the pre-cache request can carry different Origin headers.
    event.respondWith(caches.match(url.href, {cacheName, ignoreVary: true}).then(stored => stored ?? fetch(request)));
  }
});
