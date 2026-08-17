// Chargement explicite du double par une factory (test/fakes/keychainFake.ts) plutôt que la
// convention implicite __mocks__/<module> adjacente à node_modules -- constaté en écrivant ce
// test : dans ce monorepo (dépendance hoistée à la racine, hors de
// packages/api-client/node_modules), la convention implicite ne suffit pas toujours à faire
// découvrir le double par Jest, qui retombe alors sur un automock silencieux (chaque export
// devient une fonction qui renvoie undefined) -- indétectable sans lire les résultats un par un,
// ce test l'aurait laissé passer à tort si le double n'avait pas persisté d'un appel à l'autre.
jest.mock('react-native-keychain', () => require('./fakes/keychainFake'));

import { _resetFakeKeychainForTests } from './fakes/keychainFake';
import { secureTokenStorage } from '../src/auth/tokenStorage';

describe('secureTokenStorage (Keychain/Keystore, L6-02 critère d\'acceptation 1)', () => {
  afterEach(() => {
    _resetFakeKeychainForTests();
  });

  it('ne renvoie rien tant que rien n\'a été sauvegardé', async () => {
    await expect(secureTokenStorage.load()).resolves.toBeNull();
  });

  it('conserve exactement ce qui a été sauvegardé', async () => {
    await secureTokenStorage.save({ accessToken: 'at', refreshToken: 'rt', expiresAt: 12345 });

    await expect(secureTokenStorage.load()).resolves.toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 12345,
    });
  });

  it('efface la session sauvegardée', async () => {
    await secureTokenStorage.save({ accessToken: 'at', refreshToken: 'rt', expiresAt: 1 });

    await secureTokenStorage.clear();

    await expect(secureTokenStorage.load()).resolves.toBeNull();
  });
});
