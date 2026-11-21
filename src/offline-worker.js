// The production build prepends the exact public files for this release.
const base = new URL('./', self.location.href);
const prefix = 'two-charts-offline:' + base.pathname + ':';
const cacheName = prefix + offline.version;
const files = new Map(Object.entries(offline.files).map(([file, digest]) => [new URL(file, base).href, digest]));
const staticAssets = new Set([...files.keys()].filter(url => new URL(url).pathname.startsWith(base.pathname + 'assets/')));
const index = new URL('index.html', base).href;
const pagePaths = new Set([base.pathname, new URL(index).pathname]);
const config = new URL('firebase.local.json', base).href;

async function verifyFile(url, response) {
  if (!response?.ok) throw Error('Offline file could not be fetched.');
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()));
  const digest = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== files.get(url)) throw Error('Offline file differs from the deployed release.');
}

async function prepareFiles() {
  const requestFor = url => new Request(url, {cache: 'reload', redirect: 'error'});
  try {
    const cache = await caches.open(cacheName);
    const assets = [...files.keys()].filter(url => url !== index);
    await cache.addAll(assets.map(requestFor));
    const page = await fetch(requestFor(index));
    await Promise.all([
      verifyFile(index, page.clone()),
      ...assets.map(async url => verifyFile(url, await cache.match(url, {ignoreVary: true}))),
    ]);
    // The editor uses the cached page to know all files for this release are ready.
    await cache.put(index, page);
  } catch (error) {
    await caches.delete(cacheName);
    throw error;
  }
}

self.addEventListener('install', event => {
  event.waitUntil(prepareFiles());
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
  } else if (url.href === config && files.has(config)) {
    event.respondWith(networkWithOfflineCopy(request, config));
  } else if (staticAssets.has(url.href)) {
    // Module requests and the pre-cache request can carry different Origin headers.
    event.respondWith(caches.match(url.href, {cacheName, ignoreVary: true}).then(stored => stored ?? fetch(request)));
  }
});
