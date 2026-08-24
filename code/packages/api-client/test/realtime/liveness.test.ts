import { StreamLivenessWatchdog } from '../../src/realtime/liveness';

// Minuteurs fictifs pour tout le fichier : `check()` tourne sur un vrai `setInterval` interne, et
// le réabonnement en cas de silence attend un vrai `setTimeout` (par défaut, non injecté) --
// `jest.advanceTimersByTimeAsync` fait avancer les deux et laisse les micro-tâches se dérouler
// entre chaque avancée, exactement ce qu'il faut pour une classe qui enchaîne des `await` sur des
// minuteurs.
beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// Délai de réabonnement fixe et court, sans gigue -- rend les avancées de temps du test exactes,
// pas approximatives (computeReconnectDelayMs applique une gigue aléatoire par défaut, testée
// pour elle-même dans reconnect.test.ts, pas ce qu'on veut mesurer ici).
const FIXED_RECONNECT_POLICY = { baseDelayMs: 500, maxDelayMs: 500, jitterRatio: 0 };

describe('StreamLivenessWatchdog (L3-20, D47 -- amoa/questions/L3-05-nearby-list-goes-silently-empty.md)', () => {
  it('ne signale rien tant que le flux reste sous le seuil configuré de battements manqués', async () => {
    const onStale = jest.fn();
    const resubscribe = jest.fn();
    const watchdog = new StreamLivenessWatchdog({
      expectedIntervalMs: 1000,
      missedTicksThreshold: 3,
      onStale,
      onRecovered: jest.fn(),
      resubscribe,
      reconnectPolicy: FIXED_RECONNECT_POLICY,
    });
    watchdog.start();

    await jest.advanceTimersByTimeAsync(2900); // juste sous 3 x 1000 ms

    expect(onStale).not.toHaveBeenCalled();
    expect(resubscribe).not.toHaveBeenCalled();
  });

  it('déclare le flux silencieux une fois le seuil franchi, et se réabonne aussitôt (critère 2)', async () => {
    const onStale = jest.fn();
    const resubscribe = jest.fn();
    const watchdog = new StreamLivenessWatchdog({
      expectedIntervalMs: 1000,
      missedTicksThreshold: 3,
      onStale,
      onRecovered: jest.fn(),
      resubscribe,
      reconnectPolicy: FIXED_RECONNECT_POLICY,
    });
    watchdog.start();

    await jest.advanceTimersByTimeAsync(3000);

    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onStale).toHaveBeenCalledWith(expect.any(Number));
    expect(onStale.mock.calls[0]![0]).toBeGreaterThanOrEqual(3000);
    expect(resubscribe).toHaveBeenCalledTimes(1);
  });

  it("réessaie à intervalle croissant tant que le silence persiste, jamais à chaque vérification (critère 3, ne doit pas aggraver la limitation de débit)", async () => {
    const resubscribe = jest.fn();
    const watchdog = new StreamLivenessWatchdog({
      expectedIntervalMs: 1000,
      missedTicksThreshold: 3,
      onStale: jest.fn(),
      onRecovered: jest.fn(),
      resubscribe,
      reconnectPolicy: FIXED_RECONNECT_POLICY,
    });
    watchdog.start();

    await jest.advanceTimersByTimeAsync(3000); // détection + première tentative
    expect(resubscribe).toHaveBeenCalledTimes(1);

    // Le flux reste silencieux (rien n'appelle recordActivity()) : sans le délai croissant, une
    // vérification par seconde (expectedIntervalMs) produirait une tentative par seconde --
    // largement de quoi heurter NEARBY_RATE_LIMIT_MAX_SUBSCRIPTIONS côté service
    // (nearby/handler.ts, 10 par 60 s par défaut). Ici, aucune nouvelle tentative avant le délai
    // de la politique de réabonnement (500 ms), pas à chaque tick de vérification (1000 ms) :
    await jest.advanceTimersByTimeAsync(400);
    expect(resubscribe).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(200);
    expect(resubscribe).toHaveBeenCalledTimes(2);
  });

  it('recordActivity() efface le silence, prévient onRecovered et arrête les tentatives de réabonnement en cours (critère 5)', async () => {
    const onRecovered = jest.fn();
    const resubscribe = jest.fn();
    const watchdog = new StreamLivenessWatchdog({
      expectedIntervalMs: 1000,
      missedTicksThreshold: 3,
      onStale: jest.fn(),
      onRecovered,
      resubscribe,
      reconnectPolicy: FIXED_RECONNECT_POLICY,
    });
    watchdog.start();

    await jest.advanceTimersByTimeAsync(3000);
    expect(resubscribe).toHaveBeenCalledTimes(1);

    watchdog.recordActivity(); // le flux a repris -- un vrai message vient d'arriver
    expect(onRecovered).toHaveBeenCalledTimes(1);

    const callsAtRecovery = resubscribe.mock.calls.length;
    // Sous le seuil (3 x 1000 ms) : si la boucle de réabonnement précédente n'avait pas été
    // arrêtée, elle continuerait de tourner sur son propre délai indépendamment de
    // recordActivity() et rappellerait resubscribe() ici malgré une activité réelle et récente.
    await jest.advanceTimersByTimeAsync(2000);

    expect(resubscribe).toHaveBeenCalledTimes(callsAtRecovery);
    expect(onRecovered).toHaveBeenCalledTimes(1); // pas un second appel sans nouveau silence
  });

  it('recordActivity() régulier avant le seuil ne déclenche jamais onStale, quelle que soit la durée totale', async () => {
    const onStale = jest.fn();
    const watchdog = new StreamLivenessWatchdog({
      expectedIntervalMs: 1000,
      missedTicksThreshold: 3,
      onStale,
      onRecovered: jest.fn(),
      resubscribe: jest.fn(),
      reconnectPolicy: FIXED_RECONNECT_POLICY,
    });
    watchdog.start();

    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- simule des messages réguliers, un par un, dans l'ordre.
      await jest.advanceTimersByTimeAsync(900); // toujours sous le seuil (3 x 1000 ms)
      watchdog.recordActivity();
    }

    expect(onStale).not.toHaveBeenCalled();
  });

  it('stop() arrête toute vérification et toute tentative de réabonnement en cours (démontage d\'écran)', async () => {
    const onStale = jest.fn();
    const resubscribe = jest.fn();
    const watchdog = new StreamLivenessWatchdog({
      expectedIntervalMs: 1000,
      missedTicksThreshold: 3,
      onStale,
      onRecovered: jest.fn(),
      resubscribe,
      reconnectPolicy: FIXED_RECONNECT_POLICY,
    });
    watchdog.start();
    await jest.advanceTimersByTimeAsync(3000);
    expect(resubscribe).toHaveBeenCalledTimes(1);

    watchdog.stop();
    const staleCallsAtStop = onStale.mock.calls.length;
    const resubscribeCallsAtStop = resubscribe.mock.calls.length;

    await jest.advanceTimersByTimeAsync(10_000);

    expect(onStale.mock.calls.length).toBe(staleCallsAtStop);
    expect(resubscribe.mock.calls.length).toBe(resubscribeCallsAtStop);
  });

  it('silentForMs() reflète le temps écoulé depuis la dernière activité, jamais un instantané figé', () => {
    let currentMs = 1_000_000;
    const watchdog = new StreamLivenessWatchdog({
      expectedIntervalMs: 1000,
      missedTicksThreshold: 3,
      onStale: jest.fn(),
      onRecovered: jest.fn(),
      resubscribe: jest.fn(),
      now: () => currentMs,
    });

    watchdog.recordActivity();
    expect(watchdog.silentForMs()).toBe(0);

    currentMs += 4200;
    expect(watchdog.silentForMs()).toBe(4200);
  });
});
