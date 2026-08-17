jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest')
);

import { ActionQueue, createAsyncStorageActionQueue, createInMemoryActionQueue } from '../../src/realtime/queue';

describe('ActionQueue (L6-04, critères 2 et 3 ; L3-11)', () => {
  it('conserve les actions dans leur ordre d\'ajout (critère 2, "rejouées dans l\'ordre")', async () => {
    const queue = new ActionQueue(createInMemoryActionQueue());
    await queue.enqueue({ type: 'ride.start', id: 'a1', payload: { rideId: 'r1' }, queuedAt: '2026-01-01T00:00:00Z' });
    await queue.enqueue({ type: 'ride.complete', id: 'a2', payload: { rideId: 'r1' }, queuedAt: '2026-01-01T00:00:01Z' });

    const list = await queue.list();
    expect(list.map((a) => a.id)).toEqual(['a1', 'a2']);
  });

  it('remove() retire une action précise, laisse les autres intactes', async () => {
    const queue = new ActionQueue(createInMemoryActionQueue());
    await queue.enqueue({ type: 'ride.start', id: 'a1', payload: {}, queuedAt: '2026-01-01T00:00:00Z' });
    await queue.enqueue({ type: 'ride.complete', id: 'a2', payload: {}, queuedAt: '2026-01-01T00:00:01Z' });

    await queue.remove('a1');

    expect((await queue.list()).map((a) => a.id)).toEqual(['a2']);
  });

  it('createAsyncStorageActionQueue() survit à une nouvelle instance -- même stockage sous-jacent (critère 3, "survit au redémarrage")', async () => {
    const storage = createAsyncStorageActionQueue();
    const firstSession = new ActionQueue(storage);
    await firstSession.enqueue({ type: 'ride.start', id: 'a1', payload: {}, queuedAt: '2026-01-01T00:00:00Z' });

    // Une "nouvelle session" relit le même stockage persistant plutôt qu'un état en mémoire.
    const secondSession = new ActionQueue(createAsyncStorageActionQueue());
    expect((await secondSession.list()).map((a) => a.id)).toEqual(['a1']);
  });
});
