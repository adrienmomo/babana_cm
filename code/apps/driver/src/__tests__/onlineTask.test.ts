import type { realtime } from '@babana/contracts';
import { onlineHeadlessTask, type OnlineTaskDeps } from '../onlineTask';

// Tâche JS du service d'un chauffeur en ligne (décision du 14 novembre) : elle dure tant que le
// chauffeur est en ligne, et c'est le serveur -- jamais elle -- qui dit s'il l'est encore après
// un processus relancé par Android.

function synced(driverOnline: boolean | null): realtime.SessionSyncedMessage {
  return {
    type: 'session.synced',
    id: 'm',
    emittedAt: new Date().toISOString(),
    payload: {
      activeRideId: null,
      activeRideState: null,
      activeProposal: null,
      rideStateKnown: true,
      driverOnline,
      serverTime: new Date().toISOString(),
    },
  } as realtime.SessionSyncedMessage;
}

function fakeDeps(over: Partial<OnlineTaskDeps> & { tracking?: boolean; user?: boolean } = {}) {
  const listeners = new Set<(m: realtime.ServerToClientMessage) => void>();
  let release: () => void = () => undefined;
  const state = { tracking: over.tracking ?? true, stops: 0, connects: 0 };
  const deps: OnlineTaskDeps = {
    bootstrap: jest.fn(),
    hasUser: () => over.user ?? true,
    restoreSession: async () => true,
    connect: () => {
      state.connects += 1;
    },
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isTracking: () => state.tracking,
    stopTracking: () => {
      state.stops += 1;
      release();
    },
    untilTrackingStops: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    ...over,
  };
  return { deps, state, emit: (m: realtime.ServerToClientMessage) => listeners.forEach((l) => l(m)) };
}

async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  promise.then(() => {
    done = true;
  });
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  return done;
}

test('app ouverte, chauffeur en ligne : la tâche dure jusqu’au passage hors ligne', async () => {
  const { deps, state } = fakeDeps();
  const task = onlineHeadlessTask(deps);
  expect(await settled(task)).toBe(false);
  expect(state.connects).toBe(1);

  deps.stopTracking();
  expect(await settled(task)).toBe(true);
});

test('chauffeur déjà repassé hors ligne avant le démarrage de la tâche : le service s’arrête aussitôt', async () => {
  const { deps, state } = fakeDeps({ tracking: false });
  const task = onlineHeadlessTask(deps);
  expect(await settled(task)).toBe(true);
  expect(state.stops).toBe(1);
});

test('processus relancé par Android sans session : rien à garder en ligne', async () => {
  const { deps, state } = fakeDeps({ user: false, tracking: false, restoreSession: async () => false });
  await onlineHeadlessTask(deps);
  expect(state.stops).toBe(1);
  expect(state.connects).toBe(0);
});

test('processus relancé : la session est relue, la connexion rouverte, et le serveur décide', async () => {
  const { deps, state, emit } = fakeDeps({ user: false, tracking: false });
  const task = onlineHeadlessTask(deps);
  expect(await settled(task)).toBe(false);
  expect(state.connects).toBe(1);
  expect(state.stops).toBe(0);

  // Le serveur ne le tient plus en ligne (période de grâce dépassée) : le service s'arrête.
  emit(synced(false));
  expect(await settled(task)).toBe(true);
  expect(state.stops).toBe(1);
});

test('processus relancé, le serveur le tient en ligne : la tâche continue', async () => {
  const { deps, state, emit } = fakeDeps({ user: false, tracking: false });
  const task = onlineHeadlessTask(deps);
  await settled(task);
  state.tracking = true; // la capture a repris sur session.synced (tracker.ts)
  emit(synced(true));
  expect(await settled(task)).toBe(false);
  expect(state.stops).toBe(0);
});
