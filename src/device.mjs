export async function deviceAvailability() {
  const state = await globalThis.LanguageModel?.availability();
  return ['available', 'downloadable', 'downloading'].includes(state) ? state : 'unavailable';
}
