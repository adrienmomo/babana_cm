import { ZodError } from 'zod';
import { createHttpClient } from '../../src/http/client';
import { ApiError } from '../../src/http/errors';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function apiErrorBody(code: string, message = 'technical') {
  return { error: { code, message, details: null } };
}

describe('createHttpClient -- réessais (L6-03, critère 2)', () => {
  it('réessaie sur une erreur serveur (>= 500), avec temporisation croissante', async () => {
    const wait = jest.fn().mockResolvedValue(undefined);
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, apiErrorBody('ROUTE_UNAVAILABLE')))
      .mockResolvedValueOnce(jsonResponse(503, apiErrorBody('ROUTE_UNAVAILABLE')))
      .mockResolvedValueOnce(jsonResponse(200, { drivers: [] }));
    const client = createHttpClient({ baseUrl: 'https://api.test', fetchImpl, wait, retryBaseDelayMs: 100 });

    const result = await client.request('nearbyDrivers', { query: { latitude: 4, longitude: 9 } });

    expect(result).toEqual({ drivers: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenNthCalledWith(1, 100);
    expect(wait).toHaveBeenNthCalledWith(2, 200);
  });

  it('réessaie sur une erreur réseau (fetch qui lève, aucune réponse)', async () => {
    const fetchImpl = jest.fn().mockRejectedValueOnce(new TypeError('network down')).mockResolvedValueOnce(jsonResponse(200, { drivers: [] }));
    const client = createHttpClient({
      baseUrl: 'https://api.test',
      fetchImpl,
      wait: jest.fn().mockResolvedValue(undefined),
    });

    const result = await client.request('nearbyDrivers', { query: { latitude: 4, longitude: 9 } });

    expect(result).toEqual({ drivers: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("n'insiste pas au-delà de maxRetries -- l'erreur finit par remonter", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(500, apiErrorBody('INTERNAL_ERROR')));
    const client = createHttpClient({
      baseUrl: 'https://api.test',
      fetchImpl,
      wait: jest.fn().mockResolvedValue(undefined),
      maxRetries: 2,
    });

    await expect(client.request('nearbyDrivers', { query: { latitude: 4, longitude: 9 } })).rejects.toBeInstanceOf(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // tentative initiale + 2 réessais
  });

  it("ne réessaie jamais une erreur métier -- un DRIVER_ALREADY_TAKEN rejoué ne réussira jamais (critère 2)", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(409, apiErrorBody('DRIVER_ALREADY_TAKEN')));
    const wait = jest.fn();
    const client = createHttpClient({ baseUrl: 'https://api.test', fetchImpl, wait });

    const error = await client
      .request('selectDriver', {
        pathParams: { id: 'r1' },
        body: { driverId: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b' },
      })
      .catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('DRIVER_ALREADY_TAKEN');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it(
    "ne réessaie jamais un défaut de validation de la réponse -- ce n'est pas une erreur " +
      'réseau (C-01R, amoa/questions/C-01.md) : la requête HTTP a déjà pleinement réussi ' +
      '(response.ok) quand responseSchema.parse échoue, et rejouer réapplique une écriture ' +
      'déjà faite sans le moindre espoir de succès -- le même défaut de schéma se reproduit à ' +
      "l'identique à chaque tentative.",
    async () => {
      // drivers doit être un tableau (NearbyDriversResponseSchema) -- réponse 200 malformée,
      // exactement la forme du défaut réel : Odoo répond, la requête a réussi, c'est la lecture
      // de la réponse qui échoue.
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { drivers: 'not-an-array' }));
      const wait = jest.fn();
      const client = createHttpClient({ baseUrl: 'https://api.test', fetchImpl, wait });

      const error = await client
        .request('nearbyDrivers', { query: { latitude: 4, longitude: 9 } })
        .catch((e) => e);

      expect(error).toBeInstanceOf(ZodError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(wait).not.toHaveBeenCalled();
    }
  );
});

describe('createHttpClient -- idempotence (L6-03, critère 3)', () => {
  it('une écriture (POST) porte un identifiant Idempotency-Key', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { revoked: true }));
    const client = createHttpClient({ baseUrl: 'https://api.test', fetchImpl });

    await client.request('authLogout', { body: { refreshToken: 'rt' } });

    const [, init] = fetchImpl.mock.calls[0] as [unknown, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toEqual(expect.any(String));
    expect(headers['Idempotency-Key'].length).toBeGreaterThan(0);
  });

  it("une lecture (GET) ne porte pas d'identifiant d'idempotence -- elle n'en a pas besoin", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { drivers: [] }));
    const client = createHttpClient({ baseUrl: 'https://api.test', fetchImpl });

    await client.request('nearbyDrivers', { query: { latitude: 4, longitude: 9 } });

    const [, init] = fetchImpl.mock.calls[0] as [unknown, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeUndefined();
  });

  it('la même clé est réutilisée sur les réessais internes -- un rejeu réseau reste identifiable comme la même tentative', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(jsonResponse(200, { revoked: true }));
    const client = createHttpClient({
      baseUrl: 'https://api.test',
      fetchImpl,
      wait: jest.fn().mockResolvedValue(undefined),
    });

    await client.request('authLogout', { body: { refreshToken: 'rt' } });

    const firstHeaders = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    const secondHeaders = (fetchImpl.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(secondHeaders['Idempotency-Key']).toBe(firstHeaders['Idempotency-Key']);
  });
});
