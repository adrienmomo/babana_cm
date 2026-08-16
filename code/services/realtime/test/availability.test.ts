// Contre un Redis réel, comme test/geo-index.test.ts : setOffline() s'appuie sur removeFromPool
// (géo-index), et ces tests vérifient l'intégration réelle avec le pool, pas seulement le
// drapeau en ligne pris isolément.
//
// Identifiants suffixés par un identifiant de run unique -- même raison que geo-index.test.ts :
// Node exécute les fichiers de test en parallèle contre le même Redis, et ce fichier comme
// geo-index.test.ts touchent la clé de production partagée `babana:drivers:available`.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import {
  setOnline,
  setOffline,
  isMarkedOnline,
  DisconnectGraceTimers,
} from '../src/driver/availability';
import { isInPool, removeFromPool } from '../src/redis/geo-index';
import { addEligibleToPool } from '../src/redis/pool-eligibility';
import { ingestPosition } from '../src/tracking/ingest';
import type { PlausibilityConfig } from '../src/tracking/validation';
import type { ConnectionContext } from '../src/ws/auth';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const RUN_ID = randomUUID().slice(0, 8);
const id = (label: string) => `${label}-${RUN_ID}`;

const CONFIG: PlausibilityConfig = {
  bounds: { minLatitude: 3.95, maxLatitude: 4.15, minLongitude: 9.6, maxLongitude: 9.85 },
  maxAccuracyMeters: 150,
  maxTimestampFutureMs: 5_000,
  maxTimestampAgeMs: 30_000,
  maxImpliedSpeedMetersPerSecond: 38.9,
};

function positionMessage() {
  return {
    type: 'position.update' as const,
    id: `msg-${Math.random().toString(36).slice(2)}`,
    emittedAt: new Date().toISOString(),
    payload: {
      latitude: 4.0483,
      longitude: 9.6934,
      accuracyMeters: 20,
      speedMetersPerSecond: 5,
      headingDegrees: 90,
    },
  };
}

function driverContext(driverId: string): ConnectionContext {
  return Object.freeze({ userId: `user-${driverId}`, role: 'driver', driverId });
}

let redis: Redis;
const usedIds = new Set<string>();

before(() => {
  redis = new Redis(REDIS_URL);
});

after(async () => {
  await Promise.all(
    [...usedIds].flatMap((driverId) => [
      setOffline(redis, driverId),
      redis.del(`babana:driver:position:${driverId}`),
    ])
  );
  redis.disconnect();
});

function trackedId(label: string): string {
  const driverId = id(label);
  usedIds.add(driverId);
  return driverId;
}

describe('setOnline/setOffline/isMarkedOnline (L3-04)', () => {
  test('un chauffeur marqué en ligne le reste jusqu\'à un passage hors ligne explicite', async () => {
    const driverId = trackedId('flag-a');
    await setOnline(redis, driverId);
    assert.equal(await isMarkedOnline(redis, driverId), true);

    await setOffline(redis, driverId);
    assert.equal(await isMarkedOnline(redis, driverId), false);
  });

  test('le passage hors ligne est immédiat et inconditionnel : retire aussi du géo-index', async () => {
    const driverId = trackedId('flag-b');
    await setOnline(redis, driverId);
    await addEligibleToPool(redis, driverId, 4.0483, 9.6934);
    assert.equal(await isInPool(redis, driverId), true);

    await setOffline(redis, driverId);
    assert.equal(await isInPool(redis, driverId), false);
  });

  test('rejoint L3-02/L3-03 : un chauffeur marqué en ligne entre dans le géo-index à sa première position acceptée', async () => {
    const driverId = trackedId('join-a');
    await setOnline(redis, driverId);
    assert.equal(await isInPool(redis, driverId), false, 'pas encore de position connue');

    const outcome = await ingestPosition(redis, driverContext(driverId), positionMessage(), CONFIG, 60);
    assert.equal(outcome.accepted, true);
    assert.equal(await isInPool(redis, driverId), true);
  });

  test("un chauffeur jamais marqué en ligne n'entre pas dans le géo-index même avec des positions valides", async () => {
    const driverId = trackedId('join-b');
    await ingestPosition(redis, driverContext(driverId), positionMessage(), CONFIG, 60);
    assert.equal(await isInPool(redis, driverId), false);
  });
});

describe('DisconnectGraceTimers (L3-04, critère 3)', () => {
  test('sans reconnexion, le chauffeur sort du pool à expiration de la période de grâce', async () => {
    const driverId = trackedId('grace-a');
    await setOnline(redis, driverId);
    await addEligibleToPool(redis, driverId, 4.0483, 9.6934);

    const timers = new DisconnectGraceTimers();
    timers.schedule(redis, driverId, 0.05);

    assert.equal(await isInPool(redis, driverId), true, 'encore dans le pool avant expiration');
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(await isInPool(redis, driverId), false);
    assert.equal(await isMarkedOnline(redis, driverId), false);
  });

  test('une reconnexion avant échéance (cancel) annule la sortie du pool', async () => {
    const driverId = trackedId('grace-b');
    await setOnline(redis, driverId);
    await addEligibleToPool(redis, driverId, 4.0483, 9.6934);

    const timers = new DisconnectGraceTimers();
    timers.schedule(redis, driverId, 0.05);
    timers.cancel(driverId);

    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(await isInPool(redis, driverId), true, 'le chauffeur reconnecté reste dans le pool');
    await removeFromPool(redis, driverId);
  });

  test('cancel() est sans effet si aucun minuteur n\'est en attente', () => {
    const timers = new DisconnectGraceTimers();
    assert.doesNotThrow(() => timers.cancel('driver-inconnu'));
    assert.equal(timers.has('driver-inconnu'), false);
  });
});
