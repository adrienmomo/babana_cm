import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type Redis from 'ioredis';
import type { realtime } from '@babana/contracts';
import { checkPlausibility, type PlausibilityConfig } from '../src/tracking/validation';
import { ingestPosition, ingestMetrics } from '../src/tracking/ingest';
import { getPosition, hasFreshPosition } from '../src/redis/positions';
import type { ConnectionContext } from '../src/ws/auth';

/**
 * Redis en mémoire, pour ce fichier seulement : `@babana/realtime` teste son propre paquet sans
 * dépendre de `make up` (voir test/auth.test.ts, test/ws.test.ts -- même choix). Implémente
 * uniquement le sous-ensemble utilisé par services/realtime/src/redis/positions.ts, avec une
 * vraie expiration par horodatage (pas un mock d'expiration) : le critère d'acceptation 4 doit
 * observer une expiration réelle, pas un comportement simulé qui pourrait diverger.
 */
class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAtMs: number | null }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, mode?: string, ttlSeconds?: number): Promise<'OK'> {
    const expiresAtMs =
      mode === 'EX' && typeof ttlSeconds === 'number' ? Date.now() + ttlSeconds * 1000 : null;
    this.store.set(key, { value, expiresAtMs });
    return 'OK';
  }

  async exists(key: string): Promise<number> {
    return (await this.get(key)) === null ? 0 : 1;
  }

  // ingestPosition (L3-06R) appelle addEligibleToPool, qui passe par redis.eval -- ce fichier ne
  // teste ni le pool ni l'éligibilité (aucun driver ici n'est marqué en ligne), seulement la
  // validation de plausibilité et le stockage de position ; un simulacre minimal qui ne fait
  // jamais gagner l'éligibilité suffit, il ne fausse aucune assertion de ce fichier.
  async eval(): Promise<number> {
    return 0;
  }
}

function fakeRedis(): Redis {
  return new FakeRedis() as unknown as Redis;
}

const BOUNDS = { minLatitude: 3.95, maxLatitude: 4.15, minLongitude: 9.6, maxLongitude: 9.85 };

const CONFIG: PlausibilityConfig = {
  bounds: BOUNDS,
  maxAccuracyMeters: 150,
  maxTimestampFutureMs: 5_000,
  maxTimestampAgeMs: 30_000,
  maxImpliedSpeedMetersPerSecond: 38.9,
};

const AKWA = { latitude: 4.0483, longitude: 9.6934 };
const NOW = Date.parse('2026-08-15T12:00:00.000Z');

function driverContext(driverId: string): ConnectionContext {
  return Object.freeze({ userId: `user-${driverId}`, role: 'driver', driverId });
}

function positionMessage(overrides: Partial<{
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  speedMetersPerSecond: number | null;
  headingDegrees: number | null;
  emittedAt: string;
}> = {}) {
  return {
    type: 'position.update' as const,
    id: `msg-${Math.random().toString(36).slice(2)}`,
    emittedAt: overrides.emittedAt ?? new Date(NOW).toISOString(),
    payload: {
      latitude: overrides.latitude ?? AKWA.latitude,
      longitude: overrides.longitude ?? AKWA.longitude,
      accuracyMeters: overrides.accuracyMeters ?? 20,
      speedMetersPerSecond: overrides.speedMetersPerSecond ?? 8,
      headingDegrees: overrides.headingDegrees ?? 90,
      // Ces fixtures construisent le message à la main, sans passer par
      // PositionUpdatePayloadSchema.parse() (qui seul applique le défaut Zod) -- L6-05,
      // agrégation avant envoi. Vide ici : un point isolé, même comportement qu'avant L6-05.
      precedingSamples: [] as realtime.PositionSample[],
    },
  };
}

describe('checkPlausibility (L3-02, critère 2 -- chaque règle testée individuellement)', () => {
  test('accepte une position plausible, sans position précédente', () => {
    const result = checkPlausibility(
      { ...AKWA, accuracyMeters: 20, capturedAtMs: NOW },
      null,
      CONFIG,
      NOW
    );
    assert.deepEqual(result, { ok: true });
  });

  test('rejette des coordonnées hors des bornes valides', () => {
    const result = checkPlausibility(
      { latitude: 95, longitude: 9.7, accuracyMeters: 20, capturedAtMs: NOW },
      null,
      CONFIG,
      NOW
    );
    assert.deepEqual(result, { ok: false, reason: 'out_of_bounds' });
  });

  test('rejette des coordonnées valides mais hors de la zone d\'exploitation', () => {
    // Paris -- coordonnées valides au sens WGS84, hors du rectangle englobant de Douala.
    const result = checkPlausibility(
      { latitude: 48.8566, longitude: 2.3522, accuracyMeters: 20, capturedAtMs: NOW },
      null,
      CONFIG,
      NOW
    );
    assert.deepEqual(result, { ok: false, reason: 'out_of_bounds' });
  });

  test('rejette une précision au-delà du seuil configuré', () => {
    const result = checkPlausibility(
      { ...AKWA, accuracyMeters: 501, capturedAtMs: NOW },
      null,
      CONFIG,
      NOW
    );
    assert.deepEqual(result, { ok: false, reason: 'accuracy_too_low' });
  });

  test('rejette un horodatage dans le futur au-delà de la tolérance', () => {
    const result = checkPlausibility(
      { ...AKWA, accuracyMeters: 20, capturedAtMs: NOW + 10_000 },
      null,
      CONFIG,
      NOW
    );
    assert.deepEqual(result, { ok: false, reason: 'timestamp_in_future' });
  });

  test('rejette un horodatage trop ancien', () => {
    const result = checkPlausibility(
      { ...AKWA, accuracyMeters: 20, capturedAtMs: NOW - 60_000 },
      null,
      CONFIG,
      NOW
    );
    assert.deepEqual(result, { ok: false, reason: 'timestamp_too_old' });
  });

  test('rejette une vitesse implicite trop élevée -- cinq kilomètres en dix secondes', () => {
    const previous = { latitude: AKWA.latitude, longitude: AKWA.longitude, capturedAtMs: NOW };
    // ~0.045° de latitude ≈ 5 km à cette latitude -- reste dans les bornes d'exploitation, pour
    // isoler la règle de vitesse de celle des bornes (out_of_bounds serait sinon prioritaire).
    const teleported = {
      latitude: AKWA.latitude + 0.045,
      longitude: AKWA.longitude,
      accuracyMeters: 20,
      capturedAtMs: NOW + 10_000,
    };
    const result = checkPlausibility(teleported, previous, CONFIG, NOW + 10_000);
    assert.deepEqual(result, { ok: false, reason: 'implied_speed_too_high' });
  });

  test('accepte un déplacement plausible entre deux positions successives', () => {
    const previous = { latitude: AKWA.latitude, longitude: AKWA.longitude, capturedAtMs: NOW };
    // ~100 m en 15 secondes ≈ 6.7 m/s, sous le seuil.
    const next = {
      latitude: AKWA.latitude + 0.0009,
      longitude: AKWA.longitude,
      accuracyMeters: 20,
      capturedAtMs: NOW + 15_000,
    };
    const result = checkPlausibility(next, previous, CONFIG, NOW + 15_000);
    assert.deepEqual(result, { ok: true });
  });
});

describe('ingestPosition (L3-02)', () => {
  test('critère 1 -- une position valide est stockée', async () => {
    const redis = fakeRedis();
    const outcome = await ingestPosition(
      redis,
      driverContext('driver-1'),
      positionMessage(),
      CONFIG,
      60,
      NOW
    );
    assert.deepEqual(outcome, { accepted: true });

    const stored = await getPosition(redis, 'driver-1');
    assert.ok(stored);
    assert.equal(stored?.latitude, AKWA.latitude);
    assert.equal(stored?.longitude, AKWA.longitude);
  });

  test('L6-05 -- un message agrégé (precedingSamples) traite chaque point dans l’ordre, la position stockée est la plus récente', async () => {
    const redis = fakeRedis();
    ingestMetrics.reset();
    const message = positionMessage();
    message.payload.precedingSamples = [
      {
        latitude: AKWA.latitude - 0.001,
        longitude: AKWA.longitude - 0.001,
        accuracyMeters: 15,
        speedMetersPerSecond: 4,
        headingDegrees: 90,
        capturedAt: new Date(NOW - 20_000).toISOString(),
      },
      {
        latitude: AKWA.latitude - 0.0005,
        longitude: AKWA.longitude - 0.0005,
        accuracyMeters: 15,
        speedMetersPerSecond: 4,
        headingDegrees: 90,
        capturedAt: new Date(NOW - 10_000).toISOString(),
      },
    ];

    const outcome = await ingestPosition(redis, driverContext('driver-batch'), message, CONFIG, 60, NOW);
    assert.deepEqual(outcome, { accepted: true });

    // La position stockée est celle du point le plus récent (dernier traité), pas la première du
    // lot -- même comportement observable qu'avant L6-05, agrégation ou non.
    const stored = await getPosition(redis, 'driver-batch');
    assert.equal(stored?.latitude, AKWA.latitude);
    assert.equal(stored?.longitude, AKWA.longitude);

    // Les trois points (deux précédents + le plus récent) ont chacun été soumis à la validation
    // de plausibilité -- pas seulement le dernier.
    assert.equal(ingestMetrics.snapshot().accepted, 3);
  });

  test("critère 3 -- une position rejetée n'empêche pas un traitement normal ensuite (pas de fermeture de connexion à ce niveau)", async () => {
    const redis = fakeRedis();
    const rejected = await ingestPosition(
      redis,
      driverContext('driver-2'),
      positionMessage({ accuracyMeters: 999 }),
      CONFIG,
      60,
      NOW
    );
    assert.equal(rejected.accepted, false);

    // Rien n'a été stocké -- et un appel suivant, valide, fonctionne normalement : la fonction ne
    // lève jamais, ws/connection.ts n'a donc jamais à fermer la connexion sur un rejet.
    assert.equal(await getPosition(redis, 'driver-2'), null);
    const accepted = await ingestPosition(
      redis,
      driverContext('driver-2'),
      positionMessage(),
      CONFIG,
      60,
      NOW
    );
    assert.equal(accepted.accepted, true);
  });

  test('critère 4 -- à expiration de la durée de vie, le chauffeur sort du pool (position absente)', async () => {
    const redis = fakeRedis();
    await ingestPosition(redis, driverContext('driver-3'), positionMessage(), CONFIG, 0.05, NOW);
    assert.equal(await hasFreshPosition(redis, 'driver-3'), true);

    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(await hasFreshPosition(redis, 'driver-3'), false);
  });

  test('un message émis par une connexion non-chauffeur est rejeté sans jamais dériver un identifiant du message', async () => {
    const redis = fakeRedis();
    const clientContext: ConnectionContext = Object.freeze({
      userId: 'user-client-1',
      role: 'client',
      driverId: null,
    });
    const outcome = await ingestPosition(redis, clientContext, positionMessage(), CONFIG, 60, NOW);
    assert.deepEqual(outcome, { accepted: false, reason: 'not_a_driver' });
  });

  test('critère 5 -- le taux de rejet est exposé en métrique', async () => {
    ingestMetrics.reset();
    const redis = fakeRedis();

    await ingestPosition(redis, driverContext('driver-4'), positionMessage(), CONFIG, 60, NOW);
    await ingestPosition(
      redis,
      driverContext('driver-4'),
      positionMessage({ accuracyMeters: 999 }),
      CONFIG,
      60,
      NOW
    );
    await ingestPosition(
      redis,
      driverContext('driver-4'),
      positionMessage({ accuracyMeters: 999 }),
      CONFIG,
      60,
      NOW
    );

    const snapshot = ingestMetrics.snapshot();
    assert.equal(snapshot.accepted, 1);
    assert.equal(snapshot.rejected, 2);
    assert.equal(snapshot.rejectedByReason['accuracy_too_low'], 2);
  });
});
