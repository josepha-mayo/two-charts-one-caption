export async function deviceAvailability() {
  let timer;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Chrome did not report model readiness. Try checking again.')), 5000);
    });
    const state = await Promise.race([globalThis.LanguageModel?.availability(), deadline]);
    return ['available', 'downloadable', 'downloading'].includes(state) ? state : 'unavailable';
  } finally {
    clearTimeout(timer);
  }
}
