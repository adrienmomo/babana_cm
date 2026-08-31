import { captureIntervalFor, MovementDetector, type AdaptiveCaptureConfig } from '../adaptive';

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

const AKWA = { latitude: 4.0483, longitude: 9.6934 };

describe('captureIntervalFor (L6-05, critère 2 -- la fréquence change selon les quatre états)', () => {
  test('hors ligne -- aucune capture (critère 1)', () => {
    expect(captureIntervalFor('offline', CONFIG)).toBeNull();
  });

  test('en ligne, immobile -- très faible fréquence', () => {
    expect(captureIntervalFor('online_idle', CONFIG)).toBe(90_000);
  });

  test('en ligne, en mouvement -- fréquence modérée', () => {
    expect(captureIntervalFor('online_moving', CONFIG)).toBe(15_000);
  });

  test('en course -- fréquence élevée', () => {
    expect(captureIntervalFor('in_ride', CONFIG)).toBe(5_000);
  });

  test('mode dégradé (repli) -- idle et moving convergent vers la même cadence espacée, in_ride inchangé', () => {
    const degraded: AdaptiveCaptureConfig = { ...CONFIG, degradedMode: true };
    expect(captureIntervalFor('online_idle', degraded)).toBe(300_000);
    expect(captureIntervalFor('online_moving', degraded)).toBe(300_000);
    expect(captureIntervalFor('in_ride', degraded)).toBe(5_000);
  });
});

describe('MovementDetector (L6-05 -- vitesse ET déplacement cumulé, jamais un compteur seul)', () => {
  test('une vitesse instantanée au-dessus du seuil signale un mouvement, même sans historique', () => {
    const detector = new MovementDetector(CONFIG);
    expect(detector.isMoving(5)).toBe(true);
  });

  test('sans vitesse fiable et sans historique suffisant, considéré immobile par défaut', () => {
    const detector = new MovementDetector(CONFIG);
    expect(detector.isMoving(null)).toBe(false);
  });

  test('un bruit GPS à l’arrêt (petites oscillations) ne franchit jamais le seuil de déplacement cumulé', () => {
    const detector = new MovementDetector(CONFIG);
    let atMs = 0;
    // Oscille de quelques mètres autour du même point -- jamais assez pour franchir 40 m cumulés
    // sur toute la fenêtre.
    for (let i = 0; i < 6; i += 1) {
      const jitter = (i % 2 === 0 ? 1 : -1) * 0.00002; // ~2 m
      detector.record({ latitude: AKWA.latitude + jitter, longitude: AKWA.longitude }, atMs);
      atMs += 10_000;
    }
    expect(detector.isMoving(null)).toBe(false);
  });

  test('un déplacement lent mais réel finit par franchir le seuil cumulé', () => {
    const detector = new MovementDetector(CONFIG);
    let atMs = 0;
    let lat = AKWA.latitude;
    for (let i = 0; i < 8; i += 1) {
      detector.record({ latitude: lat, longitude: AKWA.longitude }, atMs);
      lat += 0.0001; // ~11 m par point -> largement au-delà de 40 m cumulés après quelques points
      atMs += 10_000;
    }
    expect(detector.isMoving(null)).toBe(true);
  });

  test('la fenêtre glissante oublie les points trop anciens', () => {
    const detector = new MovementDetector(CONFIG);
    // Un grand déplacement, mais hors fenêtre (au-delà de idleDetectionWindowMs) au moment du test.
    detector.record({ latitude: AKWA.latitude, longitude: AKWA.longitude }, 0);
    detector.record({ latitude: AKWA.latitude + 0.01, longitude: AKWA.longitude }, 200_000); // ~1.1 km, mais...
    // ...un seul point recent reste dans la fenêtre après ce second relevé (le premier est éjecté) :
    // avec un seul point en mémoire, isMoving retombe sur "pas assez d'historique" -> immobile.
    expect(detector.isMoving(null)).toBe(false);
  });

  test('reset() efface l’historique', () => {
    const detector = new MovementDetector(CONFIG);
    detector.record(AKWA, 0);
    detector.record({ latitude: AKWA.latitude + 0.01, longitude: AKWA.longitude }, 1000);
    expect(detector.isMoving(null)).toBe(true);
    detector.reset();
    expect(detector.isMoving(null)).toBe(false);
  });
});
