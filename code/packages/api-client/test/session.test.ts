import { ApiError, type HttpClient } from '../src/http';
import { AuthClient, withTransparentRefresh } from '../src/auth/session';
import type { StoredSession, TokenStorage } from '../src/auth/tokenStorage';

function fakeStorage(): TokenStorage & { peek(): StoredSession | null } {
  let current: StoredSession | null = null;
  return {
    async save(session) {
      current = session;
    },
    async load() {
      return current;
    },
    async clear() {
      current = null;
    },
    peek() {
      return current;
    },
  };
}

const SESSION_RESPONSE = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresIn: 3600,
  user: { id: 'u1', role: 'driver' as const, displayName: 'Chauffeur', photoUrl: null, phoneVerified: true, driverStatus: 'pending' as const },
};

describe('AuthClient.exchangeGoogleIdToken', () => {
  it('échange un ID token et persiste la session (critère 1)', async () => {
    const request = jest.fn().mockResolvedValue(SESSION_RESPONSE);
    const storage = fakeStorage();
    const client = new AuthClient({ httpClient: { request }, storage });

    const state = await client.exchangeGoogleIdToken('id-token', 'driver');

    expect(request).toHaveBeenCalledWith('authGoogle', { body: { idToken: 'id-token', role: 'driver' } });
    expect(state.accessToken).toBe('access-1');
    expect(client.getAccessToken()).toBe('access-1');
    expect(storage.peek()).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: expect.any(Number),
    });
  });

  it('critère 5 : un chauffeur pending reçoit tout de même une session exploitable', async () => {
    const request = jest.fn().mockResolvedValue(SESSION_RESPONSE);
    const client = new AuthClient({ httpClient: { request }, storage: fakeStorage() });

    const state = await client.exchangeGoogleIdToken('id-token', 'driver');

    expect(state.user.driverStatus).toBe('pending');
  });
});

describe('AuthClient.refresh / logout', () => {
  it('refresh() remplace la session par la nouvelle', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(SESSION_RESPONSE)
      .mockResolvedValueOnce({ ...SESSION_RESPONSE, accessToken: 'access-2' });
    const client = new AuthClient({ httpClient: { request }, storage: fakeStorage() });
    await client.exchangeGoogleIdToken('id-token', 'driver');

    const state = await client.refresh();

    expect(state.accessToken).toBe('access-2');
    expect(request).toHaveBeenLastCalledWith('authRefresh', { body: { refreshToken: 'refresh-1' } });
  });

  it("logout() efface la session locale même si l'appel serveur échoue", async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(SESSION_RESPONSE)
      .mockRejectedValueOnce(new Error('réseau tombé'));
    const storage = fakeStorage();
    const client = new AuthClient({ httpClient: { request }, storage });
    await client.exchangeGoogleIdToken('id-token', 'driver');

    await client.logout();

    expect(client.getAccessToken()).toBeNull();
    expect(storage.peek()).toBeNull();
  });
});

describe('withTransparentRefresh (critères 2 et 3)', () => {
  function tokenExpiredError() {
    return new ApiError('TOKEN_EXPIRED', 'expiré', 401);
  }

  it('renouvelle une fois puis rejoue la requête initiale, sans que l\'appelant ne voie l\'échec (critère 2)', async () => {
    const base: HttpClient = {
      request: jest
        .fn()
        .mockRejectedValueOnce(tokenExpiredError())
        .mockResolvedValueOnce({ ok: true }),
    };
    const auth = new AuthClient({ httpClient: { request: jest.fn().mockResolvedValue(SESSION_RESPONSE) }, storage: fakeStorage() });
    // Une session préexistante -- refresh() a besoin d'un refreshToken déjà en poche, comme ce
    // serait le cas en pratique (l'app a déjà signIn/restore avant qu'une requête n'échoue).
    await auth.exchangeGoogleIdToken('id-token', 'driver');
    const refreshSpy = jest.spyOn(auth, 'refresh');
    const wrapped = withTransparentRefresh(base, auth);

    const result = await wrapped.request('driverCash', {});

    expect(result).toEqual({ ok: true });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(base.request).toHaveBeenCalledTimes(2);
  });

  it('ne réessaie qu\'une seule fois -- un second TOKEN_EXPIRED après renouvellement remonte tel quel', async () => {
    const secondError = tokenExpiredError();
    const base: HttpClient = {
      request: jest.fn().mockRejectedValueOnce(tokenExpiredError()).mockRejectedValueOnce(secondError),
    };
    const auth = new AuthClient({ httpClient: { request: jest.fn().mockResolvedValue(SESSION_RESPONSE) }, storage: fakeStorage() });
    await auth.exchangeGoogleIdToken('id-token', 'driver');
    const wrapped = withTransparentRefresh(base, auth);

    await expect(wrapped.request('driverCash', {})).rejects.toBe(secondError);
    expect(base.request).toHaveBeenCalledTimes(2);
  });

  it('un renouvellement qui échoue déconnecte proprement et relance l\'erreur d\'origine (critère 3)', async () => {
    const originalError = tokenExpiredError();
    const base: HttpClient = { request: jest.fn().mockRejectedValueOnce(originalError) };
    const storage = fakeStorage();
    const refreshHttpClient: HttpClient = {
      request: jest
        .fn()
        .mockResolvedValueOnce(SESSION_RESPONSE) // exchangeGoogleIdToken de préparation
        .mockRejectedValueOnce(new ApiError('TOKEN_REVOKED', 'révoqué', 401)) // refresh() échoue
        .mockResolvedValueOnce({ revoked: true }), // logout() best-effort
    };
    const onSessionLost = jest.fn();
    const auth = new AuthClient({ httpClient: refreshHttpClient, storage, onSessionLost });
    await auth.exchangeGoogleIdToken('id-token', 'driver');
    const wrapped = withTransparentRefresh(base, auth);

    await expect(wrapped.request('driverCash', {})).rejects.toBe(originalError);

    expect(auth.getAccessToken()).toBeNull();
    expect(storage.peek()).toBeNull();
    expect(onSessionLost).toHaveBeenCalledTimes(1);
  });

  it('une erreur qui n\'est pas TOKEN_EXPIRED ne déclenche aucun renouvellement', async () => {
    const otherError = new ApiError('DRIVER_ALREADY_TAKEN', 'déjà pris', 409);
    const base: HttpClient = { request: jest.fn().mockRejectedValueOnce(otherError) };
    const auth = new AuthClient({ httpClient: { request: jest.fn() }, storage: fakeStorage() });
    const refreshSpy = jest.spyOn(auth, 'refresh');
    const wrapped = withTransparentRefresh(base, auth);

    await expect(wrapped.request('driverCash', {})).rejects.toBe(otherError);
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
