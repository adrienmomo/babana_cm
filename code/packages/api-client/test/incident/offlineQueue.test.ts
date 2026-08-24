jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest')
);

import {
  PendingIncidentQueue,
  createAsyncStoragePendingIncidentQueue,
  createInMemoryPendingIncidentQueue,
  flushPendingIncidentTriggers,
  type PendingIncidentTrigger,
} from '../../src/incident/offlineQueue';

const TRIGGER = { rideId: 'r1', latitude: 4.05, longitude: 9.7, triggeredAt: '2026-08-24T21:00:00.000Z' };

describe('PendingIncidentQueue (L8-04, critère d\'acceptation 6)', () => {
  it('enqueue() pose un idempotencyKey non vide et le conserve tel quel', async () => {
    const queue = new PendingIncidentQueue(createInMemoryPendingIncidentQueue());

    const enqueued = await queue.enqueue(TRIGGER);

    expect(enqueued.idempotencyKey.length).toBeGreaterThan(0);
    const [stored] = await queue.list();
    expect(stored.idempotencyKey).toBe(enqueued.idempotencyKey);
  });

  it('deux mises en file consécutives obtiennent des clés différentes', async () => {
    const queue = new PendingIncidentQueue(createInMemoryPendingIncidentQueue());

    const first = await queue.enqueue(TRIGGER);
    const second = await queue.enqueue(TRIGGER);

    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });

  it('remove() retire un déclenchement précis, laisse les autres intacts', async () => {
    const queue = new PendingIncidentQueue(createInMemoryPendingIncidentQueue());
    const first = await queue.enqueue(TRIGGER);
    const second = await queue.enqueue({ ...TRIGGER, rideId: 'r2' });

    await queue.remove(first.idempotencyKey);

    const remaining = await queue.list();
    expect(remaining.map((t) => t.idempotencyKey)).toEqual([second.idempotencyKey]);
  });

  it('createAsyncStoragePendingIncidentQueue() survit à une nouvelle instance -- même stockage sous-jacent', async () => {
    const storage = createAsyncStoragePendingIncidentQueue();
    const firstSession = new PendingIncidentQueue(storage);
    const enqueued = await firstSession.enqueue(TRIGGER);

    const secondSession = new PendingIncidentQueue(createAsyncStoragePendingIncidentQueue());
    expect((await secondSession.list()).map((t) => t.idempotencyKey)).toEqual([enqueued.idempotencyKey]);
  });
});

describe('flushPendingIncidentTriggers', () => {
  it('rejoue chaque déclenchement en attente et le retire une fois soumis avec succès', async () => {
    const queue = new PendingIncidentQueue(createInMemoryPendingIncidentQueue());
    await queue.enqueue(TRIGGER);
    await queue.enqueue({ ...TRIGGER, rideId: 'r2' });
    const submitted: PendingIncidentTrigger[] = [];

    await flushPendingIncidentTriggers(queue, async (trigger) => {
      submitted.push(trigger);
      return true;
    });

    expect(submitted.map((t) => t.rideId)).toEqual(['r1', 'r2']);
    expect(await queue.list()).toEqual([]);
  });

  it('arrête le rejeu à la première tentative échouée -- laisse le reste en file plutôt que de le perdre', async () => {
    const queue = new PendingIncidentQueue(createInMemoryPendingIncidentQueue());
    await queue.enqueue(TRIGGER);
    await queue.enqueue({ ...TRIGGER, rideId: 'r2' });

    await flushPendingIncidentTriggers(queue, async () => false);

    expect((await queue.list()).length).toBe(2);
  });

  it('une exception levée par submit compte comme un échec, jamais une perte du déclenchement', async () => {
    const queue = new PendingIncidentQueue(createInMemoryPendingIncidentQueue());
    await queue.enqueue(TRIGGER);

    await flushPendingIncidentTriggers(queue, async () => {
      throw new Error('réseau indisponible');
    });

    expect((await queue.list()).length).toBe(1);
  });
});
