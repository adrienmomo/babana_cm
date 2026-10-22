// Sélection automatique du chauffeur le plus proche (le client ne choisit plus, D10 retiré) --
// contre un Redis réel : le choix ET la réservation se font dans le même script Lua
// (`ride/state.lua`, action `reserve-nearest`), une imitation en mémoire ne prouverait rien de leur
// indivisibilité. La concurrence elle-même est prouvée dans test/concurrency/reservation-nearest.test.ts.
//
// Chaque test pose ses chauffeurs autour d'un point qui lui est propre (tiré au hasard dans
// Douala), avec un petit rayon : d'autres fichiers laissent des chauffeurs au point commun de test
// (4.05, 9.70, D73), qu'un « plus proche » trouverait sinon.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { reserveNearestDriver, isReserved } from '../src/reservation/reserve';
import { isInPool, removeFromPool } from '../src/redis/geo-index';
import { addEligibleToPool } from '../src/redis/pool-eligibility';
import { storePosition, positionKey } from '../src/redis/positions';
import { setOnline, setOffline } from '../src/driver/availability';
import { rideStateKey } from '../src/ride/state';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const RUN_ID = randomUUID().slice(0, 8);
const id = (label: string) => `${label}-${RUN_ID}`;

const RADIUS_METERS = 400;
// ~11 m par 0,0001 degré de latitude à Douala.
const METERS_PER_DEGREE = 111_000;

let redis: Redis;
const usedIds = new Set<string>();

before(() => {
  redis = new Redis(REDIS_URL);
});

after(async () => {
  await Promise.all(
    [...usedIds].flatMap((driverId) => [
      removeFromPool(redis, driverId),
      setOffline(redis, driverId),
      redis.del(rideStateKey(driverId)),
      redis.del(positionKey(driverId)),
    ])
  );
  redis.disconnect();
});

// Un point de Douala propre à chaque test, à ~2 km du suivant : plus que le rayon augmenté du
// chauffeur le plus éloigné qu'un test pose -- les chauffeurs d'un test ne sont jamais à portée
// d'un autre (un tirage au hasard l'a été, une fois sur quelques exécutions).
let spotIndex = 0;
function uniqueSpot(): { latitude: number; longitude: number } {
  spotIndex += 1;
  return { latitude: 3.94 + spotIndex * 0.02, longitude: 9.61 };
}

function northOf(spot: { latitude: number; longitude: number }, meters: number) {
  return { latitude: spot.latitude + meters / METERS_PER_DEGREE, longitude: spot.longitude };
}

async function availableDriverAt(label: string, at: { latitude: number; longitude: number }): Promise<string> {
  const driverId = id(label);
  usedIds.add(driverId);
  await setOnline(redis, driverId);
  await storePosition(
    redis,
    driverId,
    { ...at, accuracyMeters: 10, speedMetersPerSecond: 0, headingDegrees: 0, capturedAtMs: Date.now() },
    60
  );
  await addEligibleToPool(redis, driverId, at.latitude, at.longitude);
  return driverId;
}

describe('reserveNearestDriver -- le serveur choisit le chauffeur disponible le plus proche', () => {
  test('réserve le plus proche, et lui seul', async () => {
    const pickup = uniqueSpot();
    const far = await availableDriverAt('nearest-far', northOf(pickup, 300));
    const close = await availableDriverAt('nearest-close', northOf(pickup, 50));
    const middle = await availableDriverAt('nearest-middle', northOf(pickup, 150));

    const chosen = await reserveNearestDriver(redis, { origin: pickup, radiusMeters: RADIUS_METERS, ttlSeconds: 30 });

    assert.equal(chosen, close);
    assert.equal(await isReserved(redis, close), true);
    assert.equal(await isInPool(redis, close), false, 'réservé : retiré du vivier dans le même geste');
    assert.equal(await isInPool(redis, middle), true);
    assert.equal(await isInPool(redis, far), true);
  });

  test('passe les chauffeurs déjà sollicités pour cette course (refus ou expiration)', async () => {
    const pickup = uniqueSpot();
    const close = await availableDriverAt('excluded-close', northOf(pickup, 40));
    const next = await availableDriverAt('excluded-next', northOf(pickup, 120));

    const chosen = await reserveNearestDriver(redis, {
      origin: pickup,
      radiusMeters: RADIUS_METERS,
      ttlSeconds: 30,
      excludeDriverIds: [close],
    });

    assert.equal(chosen, next);
    assert.equal(await isInPool(redis, close), true, 'un chauffeur écarté reste disponible pour les autres courses');
  });

  test('personne dans le rayon : null, rien de réservé', async () => {
    const pickup = uniqueSpot();
    const outside = await availableDriverAt('outside-radius', northOf(pickup, RADIUS_METERS + 300));

    const chosen = await reserveNearestDriver(redis, { origin: pickup, radiusMeters: RADIUS_METERS, ttlSeconds: 30 });

    assert.equal(chosen, null);
    assert.equal(await isInPool(redis, outside), true);
  });

  test('un chauffeur dont la position a expiré (déconnecté) est passé', async () => {
    const pickup = uniqueSpot();
    const stale = await availableDriverAt('stale-close', northOf(pickup, 30));
    const fresh = await availableDriverAt('fresh-farther', northOf(pickup, 200));
    await redis.del(positionKey(stale));

    const chosen = await reserveNearestDriver(redis, { origin: pickup, radiusMeters: RADIUS_METERS, ttlSeconds: 30 });

    assert.equal(chosen, fresh);
  });

  test('un chauffeur déjà réservé par une autre course ne peut pas être choisi une seconde fois', async () => {
    const pickup = uniqueSpot();
    const only = await availableDriverAt('only-one', northOf(pickup, 60));

    const first = await reserveNearestDriver(redis, { origin: pickup, radiusMeters: RADIUS_METERS, ttlSeconds: 30 });
    const second = await reserveNearestDriver(redis, { origin: pickup, radiusMeters: RADIUS_METERS, ttlSeconds: 30 });

    assert.equal(first, only);
    assert.equal(second, null);
  });
});
