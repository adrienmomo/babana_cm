jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest')
);

import { ZodError } from 'zod';
import { createOfflineActionRunner } from '../../src/offline/manager';
import { createInMemoryOfflineQueue } from '../../src/offline/queue';
import { ApiError } from '../../src/http/errors';
import type { HttpClient } from '../../src/http/client';

function fakeHttpClient(request: jest.Mock): HttpClient {
  return { request } as unknown as HttpClient;
}

describe('createOfflineActionRunner (L6-16, critères 2, 4 et 6)', () => {
  it('en ligne : attempt() renvoie la réponse directement, rien en file', async () => {
    const request = jest.fn().mockResolvedValue({ ok: true });
    const runner = createOfflineActionRunner({ httpClient: fakeHttpClient(request), queueStorage: createInMemoryOfflineQueue() });

    const result = await runner.attempt('settleRide', { pathParams: { id: 'r1' }, body: { amountCollected: 1000 } });

    expect(result).toEqual({ ok: true });
    expect(await runner.pendingCount()).toBe(0);
  });

  it('une erreur métier (ApiError) ne se met jamais en file -- rejouer ne peut pas réussir (spécification L6-03)', async () => {
    const apiError = new ApiError('SETTLEMENT_AMOUNT_MISMATCH', 'technical', 422);
    const request = jest.fn().mockRejectedValue(apiError);
    const runner = createOfflineActionRunner({ httpClient: fakeHttpClient(request), queueStorage: createInMemoryOfflineQueue() });

    await expect(runner.attempt('settleRide', { pathParams: { id: 'r1' } })).rejects.toBe(apiError);
    expect(await runner.pendingCount()).toBe(0);
  });

  it('une réponse mal formée (ZodError) ne se met pas non plus en file -- le même défaut se reproduirait à chaque rejeu', async () => {
    const zodError = new ZodError([]);
    const request = jest.fn().mockRejectedValue(zodError);
    const runner = createOfflineActionRunner({ httpClient: fakeHttpClient(request), queueStorage: createInMemoryOfflineQueue() });

    await expect(runner.attempt('settleRide', { pathParams: { id: 'r1' } })).rejects.toBe(zodError);
    expect(await runner.pendingCount()).toBe(0);
  });

  it('une erreur réseau met en file (critère 2), appelle onQueued avant que la promesse ne se résolve', async () => {
    const request = jest.fn().mockRejectedValue(new TypeError('network down'));
    const runner = createOfflineActionRunner({ httpClient: fakeHttpClient(request), queueStorage: createInMemoryOfflineQueue() });

    let queuedCalled = false;
    const pending = runner.attempt('completeRide', { pathParams: { id: 'r1' }, onQueued: () => (queuedCalled = true) });

    // Laisse le microtask de mise en file se dérouler avant d'inspecter -- attempt() n'a pas
    // encore résolu (offline), mais onQueued() doit déjà avoir été appelé (synchrone à la mise
    // en file, avant la promesse en attente de flush()).
    await Promise.resolve();
    await Promise.resolve();
    expect(queuedCalled).toBe(true);
    expect(await runner.pendingCount()).toBe(1);

    // La promesse reste en attente tant qu'aucun flush() ne réussit -- ne doit jamais se
    // résoudre toute seule.
    let settled = false;
    pending.then(() => (settled = true), () => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('flush() rejoue avec la MÊME clé d\'idempotence que la tentative initiale (critère 6)', async () => {
    const request = jest.fn().mockRejectedValueOnce(new TypeError('network down')).mockResolvedValueOnce({ settled: true });
    const runner = createOfflineActionRunner({ httpClient: fakeHttpClient(request), queueStorage: createInMemoryOfflineQueue() });

    const pending = runner.attempt('settleRide', { pathParams: { id: 'r1' }, body: { amountCollected: 1000 } });
    await Promise.resolve();
    await Promise.resolve();

    await runner.flush();
    const result = await pending;

    expect(result).toEqual({ settled: true });
    expect(await runner.pendingCount()).toBe(0);
    const firstKey = request.mock.calls[0][1].idempotencyKey;
    const secondKey = request.mock.calls[1][1].idempotencyKey;
    expect(secondKey).toBe(firstKey);
  });

  it('flush() rejoue dans l\'ordre, s\'arrête à la première toujours hors connexion (le reste attend la prochaine reconnexion)', async () => {
    const request = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('offline')) // attempt() 1er appel -- mis en file
      .mockRejectedValueOnce(new TypeError('offline')) // attempt() 2e appel -- mis en file
      .mockResolvedValueOnce({ ok: 'first' }) // flush() : 1er élément réussit
      .mockRejectedValueOnce(new TypeError('still offline')); // flush() : 2e élément échoue encore
    const runner = createOfflineActionRunner({ httpClient: fakeHttpClient(request), queueStorage: createInMemoryOfflineQueue() });

    runner.attempt('settleRide', { pathParams: { id: 'r1' } }).catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    runner.attempt('completeRide', { pathParams: { id: 'r2' } }).catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(await runner.pendingCount()).toBe(2);

    await runner.flush();

    // Le premier a réussi et a été retiré ; le second, toujours en échec réseau, reste en file.
    expect(await runner.pendingCount()).toBe(1);
  });

  it('une erreur métier découverte seulement au rejeu retire l\'action et rejette le demandeur d\'origine', async () => {
    const apiError = new ApiError('RIDE_INVALID_TRANSITION', 'technical', 409);
    const request = jest.fn().mockRejectedValueOnce(new TypeError('offline')).mockRejectedValueOnce(apiError);
    const runner = createOfflineActionRunner({ httpClient: fakeHttpClient(request), queueStorage: createInMemoryOfflineQueue() });

    const pending = runner.attempt('completeRide', { pathParams: { id: 'r1' } });
    pending.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    await runner.flush();

    await expect(pending).rejects.toBe(apiError);
    expect(await runner.pendingCount()).toBe(0);
  });
});
