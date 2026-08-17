/**
 * Double de test pour `react-native-keychain` (L6-02, critère d'acceptation 4 -- même discipline
 * que `packages/maps/__mocks__/react-native-maps.tsx`, L6-01). Chargé via une factory explicite
 * (`jest.mock('react-native-keychain', () => require('./fakes/keychainFake'))`), pas la
 * convention implicite `__mocks__/<module>` adjacente à node_modules -- ce nom de fichier
 * l'évite délibérément : la placer sous `__mocks__/react-native-keychain.ts` fait boucler Jest
 * indéfiniment sur lui-même dès que la factory la `require()` explicitement (le nom seul suffit
 * à l'interception automatique, avant même que la factory n'ait fini de s'exécuter). Stockage en
 * mémoire, un « service » par entrée, comme le ferait un vrai trousseau isolé par appli.
 */
const store = new Map<string, { username: string; password: string }>();

interface BaseOptions {
  service?: string;
}

const DEFAULT_SERVICE = 'default';

export async function setGenericPassword(
  username: string,
  password: string,
  options?: BaseOptions
): Promise<{ service: string; storage: string } | false> {
  const service = options?.service ?? DEFAULT_SERVICE;
  store.set(service, { username, password });
  return { service, storage: 'mock' };
}

export async function getGenericPassword(
  options?: BaseOptions
): Promise<{ service: string; username: string; password: string; storage: string } | false> {
  const service = options?.service ?? DEFAULT_SERVICE;
  const entry = store.get(service);
  if (!entry) return false;
  return { service, username: entry.username, password: entry.password, storage: 'mock' };
}

export async function resetGenericPassword(options?: BaseOptions): Promise<boolean> {
  const service = options?.service ?? DEFAULT_SERVICE;
  return store.delete(service);
}

export function _resetFakeKeychainForTests(): void {
  store.clear();
}
