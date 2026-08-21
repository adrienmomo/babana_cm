// Stub provisoire (L6-00R, 21 août) -- react-native-keychain n'a pas d'équivalent web, tout comme
// react-native-maps (voir l'alias dans webpack.config.js). Sans lui, AuthClient.restore() lève au
// montage et le bundle web ne dépasse jamais l'écran de chargement. localStorage n'est PAS
// chiffré : légitime pour faire tourner le bundle ce soir, jamais une solution pour L6-18, qui
// devra trouver une vraie réponse à "une session web n'a pas de trousseau système à qui déléguer".
const STORAGE_KEY = 'babana-dev-keychain-stub';

function readAll() {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

export async function setGenericPassword(username, password, options) {
  const all = readAll();
  all[options?.service || 'default'] = { username, password };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  return true;
}

export async function getGenericPassword(options) {
  const all = readAll();
  const entry = all[options?.service || 'default'];
  if (!entry) return false;
  return { username: entry.username, password: entry.password, service: options?.service || 'default', storage: 'localStorage' };
}

export async function resetGenericPassword(options) {
  const all = readAll();
  delete all[options?.service || 'default'];
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  return true;
}
