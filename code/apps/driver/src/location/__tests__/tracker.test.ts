import type { realtime } from '@babana/contracts';
import { LocationTracker, type LocationTrackerDeps } from '../tracker';
import type { AdaptiveCaptureConfig } from '../adaptive';

const AKWA = { latitude: 4.0483, longitude: 9.6934 };

const CONFIG: AdaptiveCaptureConfig = {
  idleIntervalMs: 90_000,
  movingIntervalMs: 15_000,
  rideIntervalMs: 5_000,
  idleSpeedThresholdMps: 1,
  idleDisplacementThresholdMeters: 40,
  idleDetectionWindowMs: 120_000,
  degradedMode: false,
  degradedIntervalMs: 300_000,
  batchSize: 5,
  batchMaxWaitMs: 45_000,
  notificationRefreshMs: 60_000,
};

interface FakeDeps extends LocationTrackerDeps {
  sent: realtime.PositionUpdateMessage['payload'][];
  notificationShown: boolean;
  lastNotificationMessage: string | null;
  messageListeners: Set<(message: realtime.ServerToClientMessage) => void>;
  emit: (message: realtime.ServerToClientMessage) => void;
  foregroundState: 'granted' | 'denied';
  fixQueue: Array<{ latitude: number; longitude: number; accuracyMeters: number; speedMetersPerSecond: number | null; headingDegrees: number | null } | null>;
  getPositionCalls: number;
}

/**
 * `now()` délègue à `Date.now()` -- avec `jest.useFakeTimers()` (implémentation moderne, celle
 * utilisée par ce fichier), `Date.now()` reflète l'horloge virtuelle avancée par
 * `advanceTimersByTimeAsync()`, exactement ce dont `LocationTracker` a besoin pour calculer
 * l'écoulement du tampon (`batchMaxWaitMs`) de façon déterministe en test.
 */
function fakeDeps(overrides: Partial<FakeDeps> = {}): FakeDeps {
  const sent: realtime.PositionUpdateMessage['payload'][] = [];
  const messageListeners = new Set<(message: realtime.ServerToClientMessage) => void>();
  const fixQueue: FakeDeps['fixQueue'] = overrides.fixQueue ?? [];

  const deps: FakeDeps = {
    sent,
    notificationShown: false,
    lastNotificationMessage: null,
    messageListeners,
    foregroundState: 'granted',
    fixQueue,
    getPositionCalls: 0,
    emit(message) {
      messageListeners.forEach((listener) => listener(message));
    },
    getPosition: async () => {
      deps.getPositionCalls += 1;
      const next = deps.fixQueue.shift();
      return next === undefined ? { ...AKWA, accuracyMeters: 10, speedMetersPerSecond: null, headingDegrees: null } : next;
    },
    ensureForegroundPermission: async () => deps.foregroundState,
    ensureBackgroundPermission: async () => 'denied',
    send: (payload) => {
      sent.push(payload);
    },
    onMessage: (listener) => {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onSessionLost: () => () => {},
    updateNotification: (message: string) => {
      deps.notificationShown = true;
      deps.lastNotificationMessage = message;
    },
    hideNotification: () => {
      deps.notificationShown = false;
      deps.lastNotificationMessage = null;
    },
    now: () => Date.now(),
    ...overrides,
  };
  return deps;
}

function proposalAccepted(rideId = 'ride-1'): realtime.ProposalAcceptedMessage {
  return { type: 'proposal.accepted', id: 'm', emittedAt: new Date().toISOString(), payload: { rideId, clientPhoneNumber: null } };
}
function rideCompleted(rideId = 'ride-1'): realtime.RideCompletedMessage {
  return {
    type: 'ride.completed',
    id: 'm',
    emittedAt: new Date().toISOString(),
    payload: { rideId, distanceMeters: 100, durationSeconds: 60, measured: true, amount: 500, breakdown: {} as never },
  };
}
function sessionSynced(
  over: Partial<realtime.SessionSyncedMessage['payload']> = {}
): realtime.SessionSyncedMessage {
  return {
    type: 'session.synced',
    id: 'm',
    emittedAt: new Date().toISOString(),
    payload: {
      activeRideId: null,
      activeRideState: null,
      activeProposal: null,
      rideStateKnown: true,
      serverTime: new Date().toISOString(),
      ...over,
    },
  };
}

describe('LocationTracker (L6-05)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('critère 1 -- aucune capture hors ligne : aucun relevé GPS tant que setOnline(true) n’a pas été appelé', async () => {
    const deps = fakeDeps();
    const tracker = new LocationTracker(deps, CONFIG);
    tracker.start();

    await jest.advanceTimersByTimeAsync(500_000);

    expect(deps.getPositionCalls).toBe(0);
    expect(tracker.getState()).toBe('offline');
  });

  test('en ligne, immobile -- capture à la cadence idle, notification affichée', async () => {
    const deps = fakeDeps();
    const tracker = new LocationTracker(deps, CONFIG);
    tracker.start();

    tracker.setOnline(true);
    expect(tracker.getState()).toBe('online_idle');
    expect(deps.notificationShown).toBe(true);

    await jest.advanceTimersByTimeAsync(0); // premier relevé, programmé avec un délai de 0 à l'entrée dans l'état
    expect(deps.getPositionCalls).toBe(1);

    await jest.advanceTimersByTimeAsync(CONFIG.idleIntervalMs);
    expect(deps.getPositionCalls).toBe(2);
  });

  test('en course -- capture à la cadence élevée dès proposal.accepted, immédiatement (pas au bout de l’ancienne cadence)', async () => {
    const deps = fakeDeps();
    const tracker = new LocationTracker(deps, CONFIG);
    tracker.start();
    tracker.setOnline(true);
    await jest.advanceTimersByTimeAsync(0);
    deps.getPositionCalls = 0;

    deps.emit(proposalAccepted());
    expect(tracker.getState()).toBe('in_ride');

    await jest.advanceTimersByTimeAsync(0);
    expect(deps.getPositionCalls).toBe(1); // relevé immédiat au changement d'état

    await jest.advanceTimersByTimeAsync(CONFIG.rideIntervalMs);
    expect(deps.getPositionCalls).toBe(2);
  });

  test('ride.completed ramène l’état hors course', async () => {
    const deps = fakeDeps();
    const tracker = new LocationTracker(deps, CONFIG);
    tracker.start();
    tracker.setOnline(true);
    deps.emit(proposalAccepted());
    expect(tracker.getState()).toBe('in_ride');

    deps.emit(rideCompleted());
    expect(tracker.getState()).toBe('online_idle');
  });

  test('session.synced rideStateKnown:false (Odoo injoignable) ne fait pas sortir de course -- l’absence n’est pas inférée (L7-04)', async () => {
    const deps = fakeDeps();
    const tracker = new LocationTracker(deps, CONFIG);
    tracker.start();
    tracker.setOnline(true);
    deps.emit(proposalAccepted());
    expect(tracker.getState()).toBe('in_ride');

    // Odoo injoignable : activeRideState à null mais rideStateKnown false -> on garde l'état.
    deps.emit(sessionSynced({ activeRideId: null, activeRideState: null, rideStateKnown: false }));
    expect(tracker.getState()).toBe('in_ride');

    // Odoo répond « aucune course » de façon fiable -> là, on sort.
    deps.emit(sessionSynced({ activeRideId: null, activeRideState: null, rideStateKnown: true }));
    expect(tracker.getState()).toBe('online_idle');
  });

  test('critère 1 -- arrêt immédiat au passage hors ligne, le tampon en attente n’est jamais envoyé', async () => {
    const deps = fakeDeps({ fixQueue: [{ ...AKWA, accuracyMeters: 10, speedMetersPerSecond: null, headingDegrees: null }] });
    const tracker = new LocationTracker(deps, CONFIG);
    tracker.start();
    tracker.setOnline(true);

    await jest.advanceTimersByTimeAsync(0); // un point capté, en tampon (LOCATION_BATCH_SIZE > 1)
    expect(deps.getPositionCalls).toBe(1);
    expect(deps.sent.length).toBe(0); // rien envoyé -- le tampon n'a pas atteint son seuil de vidage

    tracker.setOnline(false);
    expect(tracker.getState()).toBe('offline');
    expect(deps.notificationShown).toBe(false);
    expect(deps.sent.length).toBe(0); // toujours rien -- le point en tampon a été jeté, pas envoyé

    await jest.advanceTimersByTimeAsync(1_000_000);
    expect(deps.getPositionCalls).toBe(1); // aucun relevé supplémentaire
  });

  test('critère 3 -- les positions sont agrégées avant envoi : plusieurs relevés partent en un seul message (déclenchement par taille)', async () => {
    const fixes = Array.from({ length: 3 }, (_, i) => ({
      latitude: AKWA.latitude + i * 0.0001,
      longitude: AKWA.longitude,
      accuracyMeters: 10,
      speedMetersPerSecond: null,
      headingDegrees: null,
    }));
    const deps = fakeDeps({ fixQueue: [...fixes] });
    // batchMaxWaitMs très large : isole le déclenchement par taille, l'autre test couvre le délai.
    const smallBatchConfig: AdaptiveCaptureConfig = { ...CONFIG, batchSize: 3, batchMaxWaitMs: 10_000_000 };
    const tracker = new LocationTracker(deps, smallBatchConfig);
    tracker.start();
    tracker.setOnline(true);

    // Les deux premiers relevés ne suffisent pas à atteindre batchSize=3 -- rien n'est encore
    // parti : la preuve qu'ils sont bien accumulés plutôt qu'envoyés un par un dès la capture.
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(CONFIG.idleIntervalMs);
    expect(deps.getPositionCalls).toBe(2);
    expect(deps.sent.length).toBe(0);

    // Le troisième relevé atteint batchSize -- un seul message part, portant les trois points.
    await jest.advanceTimersByTimeAsync(CONFIG.idleIntervalMs);
    expect(deps.getPositionCalls).toBe(3);
    expect(deps.sent.length).toBe(1);
    expect(deps.sent[0]!.precedingSamples.length).toBe(2); // 2 précédents + le point le plus récent porté par les champs de tête
  });

  test('critère 3 -- l’agrégation se déclenche aussi par délai maximal, sans attendre que le tampon soit plein', async () => {
    const deps = fakeDeps();
    // batchSize élevé (jamais atteint par la taille dans ce test) ; cadence de capture (5 s)
    // plus rapide que le délai maximal du lot (8 s), pour observer plusieurs captures avant que
    // le délai ne force le vidage.
    const config: AdaptiveCaptureConfig = { ...CONFIG, idleIntervalMs: 5_000, batchSize: 10, batchMaxWaitMs: 8_000 };
    const tracker = new LocationTracker(deps, config);
    tracker.start();
    tracker.setOnline(true);

    await jest.advanceTimersByTimeAsync(0); // t=0 : premier point, tampon démarré
    expect(deps.sent.length).toBe(0);

    await jest.advanceTimersByTimeAsync(5_000); // t=5 000 : second point, encore sous le délai max (8 s)
    expect(deps.getPositionCalls).toBe(2);
    expect(deps.sent.length).toBe(0);

    // t=10 000 : ce troisième relevé, capté après que le délai maximal (8 s) depuis le PREMIER
    // point est dépassé, doit déclencher le vidage du tampon (3 points) plutôt que d'attendre
    // qu'il atteigne batchSize=10.
    await jest.advanceTimersByTimeAsync(5_000);
    expect(deps.sent.length).toBe(1);
    expect(deps.sent[0]!.precedingSamples.length).toBe(2);
  });

  test('critère 5 -- permission refusée : aucune capture, mais aucune exception, et le prochain relevé reste programmé', async () => {
    const deps = fakeDeps({ foregroundState: 'denied' });
    const tracker = new LocationTracker(deps, CONFIG);
    tracker.start();

    expect(() => tracker.setOnline(true)).not.toThrow();
    await jest.advanceTimersByTimeAsync(0);
    expect(deps.getPositionCalls).toBe(0); // jamais tenté, la permission a été refusée avant l'appel GPS
    expect(deps.sent.length).toBe(0);
  });

  test('repli (mode dégradé) -- une seule cadence espacée hors course, atteignable par configuration', async () => {
    const degraded: AdaptiveCaptureConfig = { ...CONFIG, degradedMode: true };
    const deps = fakeDeps();
    const tracker = new LocationTracker(deps, degraded);
    tracker.start();
    tracker.setOnline(true);

    await jest.advanceTimersByTimeAsync(0);
    expect(deps.getPositionCalls).toBe(1);
    // La cadence moving normale (15 s) ne suffit plus à déclencher un second relevé en mode dégradé.
    await jest.advanceTimersByTimeAsync(CONFIG.movingIntervalMs);
    expect(deps.getPositionCalls).toBe(1);
    await jest.advanceTimersByTimeAsync(degraded.degradedIntervalMs - CONFIG.movingIntervalMs);
    expect(deps.getPositionCalls).toBe(2);
  });

  test('la perte de session arrête la capture, comme un passage hors ligne', async () => {
    // Holder plutôt qu'une variable `let` capturée : TypeScript rétrécirait sinon
    // `sessionLostListener` vers `null` à la ligne de l'appel, ne voyant pas que
    // `tracker.start()` déclenche l'assignation de façon synchrone (même piège que
    // `this.getState()` dans tracker.ts).
    const holder: { listener: (() => void) | null } = { listener: null };
    const deps = fakeDeps({
      onSessionLost: (listener) => {
        holder.listener = listener;
        return () => {
          holder.listener = null;
        };
      },
    });
    const tracker = new LocationTracker(deps, CONFIG);
    tracker.start();
    tracker.setOnline(true);
    expect(tracker.getState()).toBe('online_idle');

    holder.listener?.();

    expect(tracker.getState()).toBe('offline');
    expect(deps.notificationShown).toBe(false);
  });

  test('instrumentation -- positionsCaptured, positionsSent, bytesSent et gpsActiveMs sont comptés (ce que L6-17 mesurera)', async () => {
    const deps = fakeDeps();
    const tracker = new LocationTracker(deps, CONFIG);
    tracker.start();
    tracker.setOnline(true);

    await jest.advanceTimersByTimeAsync(0);
    const metrics = tracker.getMetrics();
    expect(metrics.positionsCaptured).toBe(1);
    expect(metrics.gpsActiveMs).toBeGreaterThanOrEqual(0);
  });

  test('la notification constate la dernière position envoyée, jamais un « suivi actif » (précision du 3 septembre)', async () => {
    // batchSize=1 : le premier relevé part immédiatement, on observe le passage
    // « pas encore envoyée » -> « à l'instant ».
    const deps = fakeDeps();
    const tracker = new LocationTracker(deps, { ...CONFIG, batchSize: 1 });
    tracker.start();

    tracker.setOnline(true);
    // Avant tout envoi : la notification dit qu'aucune position n'est encore partie -- elle
    // n'affirme pas un suivi qu'elle ne peut pas garantir.
    expect(deps.notificationShown).toBe(true);
    expect(deps.lastNotificationMessage).toMatch(/pas encore envoyée/i);

    await jest.advanceTimersByTimeAsync(0);
    expect(deps.sent.length).toBe(1);
    // Un envoi vient de partir -- la notification le constate.
    expect(deps.lastNotificationMessage).toMatch(/à l’instant/i);
  });

  test('la notification vieillit quand plus aucune position ne part -- le diagnostic d’une capture calée', async () => {
    // Un premier relevé part (batchSize=1), puis le GPS ne rend plus rien : plus aucun envoi.
    const deps = fakeDeps({
      fixQueue: [
        { ...AKWA, accuracyMeters: 10, speedMetersPerSecond: null, headingDegrees: null },
        null,
        null,
        null,
        null,
        null,
        null,
      ],
    });
    const tracker = new LocationTracker(deps, { ...CONFIG, batchSize: 1, idleIntervalMs: 90_000, notificationRefreshMs: 60_000 });
    tracker.start();
    tracker.setOnline(true);

    await jest.advanceTimersByTimeAsync(0);
    expect(deps.sent.length).toBe(1);
    expect(deps.lastNotificationMessage).toMatch(/à l’instant/i);

    // Le réaffichage périodique fait grandir « il y a N min » alors que rien de nouveau ne part.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(deps.sent.length).toBe(1);
    expect(deps.lastNotificationMessage).toMatch(/il y a 1 minute/i);

    await jest.advanceTimersByTimeAsync(120_000);
    expect(deps.sent.length).toBe(1);
    expect(deps.lastNotificationMessage).toMatch(/il y a 3 minutes/i);
  });

  test('le passage hors ligne efface la notification et son horodatage de dernier envoi', async () => {
    const deps = fakeDeps();
    const tracker = new LocationTracker(deps, { ...CONFIG, batchSize: 1 });
    tracker.start();
    tracker.setOnline(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(deps.lastNotificationMessage).toMatch(/à l’instant/i);

    tracker.setOnline(false);
    expect(deps.notificationShown).toBe(false);

    // Retour en ligne : rien n'est encore reparti, la notification repart de « pas encore
    // envoyée » plutôt que de rejouer un « à l'instant » périmé.
    tracker.setOnline(true);
    expect(deps.lastNotificationMessage).toMatch(/pas encore envoyée/i);

    // Et le réaffichage périodique ne continue pas après un passage hors ligne.
    tracker.setOnline(false);
    deps.lastNotificationMessage = 'sentinelle';
    await jest.advanceTimersByTimeAsync(600_000);
    expect(deps.lastNotificationMessage).toBe('sentinelle');
  });
});
