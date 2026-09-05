import { secureTokenStorage } from '../src/auth/tokenStorage.web';

describe('secureTokenStorage web (D39, L6-18 -- session en mémoire seulement)', () => {
  afterEach(async () => {
    await secureTokenStorage.clear();
  });

  it("ne renvoie rien tant que rien n'a été sauvegardé", async () => {
    await expect(secureTokenStorage.load()).resolves.toBeNull();
  });

  it('conserve exactement ce qui a été sauvegardé, pour la durée du module', async () => {
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

  it("ne persiste nulle part -- réimporter le module (équivalent d'un nouvel onglet) repart vide", async () => {
    await secureTokenStorage.save({ accessToken: 'at', refreshToken: 'rt', expiresAt: 1 });

    let freshModule: typeof import('../src/auth/tokenStorage.web');
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      freshModule = require('../src/auth/tokenStorage.web');
    });

    await expect(freshModule!.secureTokenStorage.load()).resolves.toBeNull();
  });
});
