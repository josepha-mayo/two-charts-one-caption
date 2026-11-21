function waitUntilCached(worker, mayWait) {
  return new Promise((resolve, reject) => {
    function finish(error) {
      clearTimeout(timeout);
      worker.removeEventListener('statechange', check);
      if (error) reject(error);
      else resolve();
    }
    function check() {
      if (worker.state === 'activated' || (mayWait && worker.state === 'installed')) finish();
      if (worker.state === 'redundant') finish(Error('Offline download failed. Reconnect and try again.'));
    }
    const timeout = setTimeout(() => finish(Error('Offline download timed out. Try again when connected.')), 30_000);
    worker.addEventListener('statechange', check);
    check();
  });
}

export async function saveOfflineApp(workerUrl, version) {
  if (!/^[a-f0-9]{16}$/.test(version ?? '')) throw Error('Open the hosted app to save an offline copy.');
  const service = navigator.serviceWorker;
  const root = new URL('./', new URL(workerUrl, location.href));
  const page = new URL('index.html', root);
  const cacheName = 'two-charts-offline:' + root.pathname + ':' + version;
  const hasRelease = () => caches.match(page.href, {cacheName});
  let registration = await service.getRegistration(root.href);
  if (!registration || !await hasRelease()) {
    if (navigator.onLine === false) throw Error('Reconnect to save this version for offline use.');
    registration = registration ? await registration.update() : await service.register(workerUrl, {updateViaCache: 'none'});
  }
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (!worker) throw Error('This browser could not start the offline download.');
  const mayWait = Boolean(registration.active && worker !== registration.active);
  await waitUntilCached(worker, mayWait);
  if (!await hasRelease()) throw Error('This version could not be saved. Reopen the app online and try again.');
  return {waiting: worker.state === 'installed'};
}
