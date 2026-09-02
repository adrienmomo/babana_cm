jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest')
);

import { OfflineActionQueue, createAsyncStorageOfflineQueue, createInMemoryOfflineQueue } from '../../src/offline/queue';

describe('OfflineActionQueue (L6-16, critères 2 et 4)', () => {
  it("conserve les actions dans leur ordre d'ajout", async () => {
    const queue = new OfflineActionQueue(createInMemoryOfflineQueue());
    await queue.enqueue({ id: 'a1', endpoint: 'settleRide', options: { pathParams: { id: 'r1' } }, queuedAt: '2026-01-01T00:00:00Z' });
    await queue.enqueue({ id: 'a2', endpoint: 'completeRide', options: { pathParams: { id: 'r1' } }, queuedAt: '2026-01-01T00:00:01Z' });

    expect((await queue.list()).map((a) => a.id)).toEqual(['a1', 'a2']);
  });

  it('remove() retire une action précise, laisse les autres intactes', async () => {
    const queue = new OfflineActionQueue(createInMemoryOfflineQueue());
    await queue.enqueue({ id: 'a1', endpoint: 'settleRide', options: {}, queuedAt: '2026-01-01T00:00:00Z' });
    await queue.enqueue({ id: 'a2', endpoint: 'completeRide', options: {}, queuedAt: '2026-01-01T00:00:01Z' });

    await queue.remove('a1');

    expect((await queue.list()).map((a) => a.id)).toEqual(['a2']);
  });

  it("createAsyncStorageOfflineQueue() survit à une nouvelle instance -- même stockage sous-jacent (critère 4, \"survit au redémarrage\")", async () => {
    const storage = createAsyncStorageOfflineQueue();
    const firstSession = new OfflineActionQueue(storage);
    await firstSession.enqueue({ id: 'a1', endpoint: 'createRemittance', options: {}, queuedAt: '2026-01-01T00:00:00Z' });

    const secondSession = new OfflineActionQueue(createAsyncStorageOfflineQueue());
    expect((await secondSession.list()).map((a) => a.id)).toEqual(['a1']);
  });

  it('deux enqueue() rapprochés sans attente ne s\'écrasent pas (mutex de sérialisation)', async () => {
    const queue = new OfflineActionQueue(createInMemoryOfflineQueue());
    await Promise.all([
      queue.enqueue({ id: 'a1', endpoint: 'settleRide', options: {}, queuedAt: '2026-01-01T00:00:00Z' }),
      queue.enqueue({ id: 'a2', endpoint: 'completeRide', options: {}, queuedAt: '2026-01-01T00:00:01Z' }),
    ]);

    expect((await queue.list()).map((a) => a.id).sort()).toEqual(['a1', 'a2']);
  });
});
