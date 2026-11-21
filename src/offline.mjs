export async function saveOfflineApp(workerUrl) {
  const service = navigator.serviceWorker;
  const current = await service.getRegistration();
  if (current?.active?.state === 'activated') return;
  if (navigator.onLine === false) throw Error('Reconnect to save the app for offline use.');

  const registration = await service.register(workerUrl, {updateViaCache: 'none'});
  const worker = registration.active ?? registration.installing ?? registration.waiting;
  if (!worker) throw Error('This browser could not start the offline download.');

  await new Promise((resolve, reject) => {
    function finish(error) {
      clearTimeout(timeout);
      worker.removeEventListener('statechange', check);
      if (error) reject(error);
      else resolve();
    }
    function check() {
      if (worker.state === 'activated') finish();
      if (worker.state === 'redundant') finish(Error('Offline download failed. Reconnect and try again.'));
    }
    const timeout = setTimeout(() => finish(Error('Offline download timed out. Try again when connected.')), 30_000);
    worker.addEventListener('statechange', check);
    check();
  });
}
