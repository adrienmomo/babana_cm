// Contre un Redis réel, comme test/geo-index.test.ts : le script Lua de réservation
// (reserve.lua) s'exécute réellement dans Redis, une imitation en mémoire ne prouverait rien de
// l'indivisibilité qu'il apporte -- c'est précisément l'objet de test/concurrency/
// reservation.test.ts (L3-13), à part de ce fichier, qui couvre le comportement fonctionnel.
//
// Identifiants suffixés par un identifiant de run unique, même raison que geo-index.test.ts.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { reserveDriver, releaseDriver, isReserved, startReservationExpiryWatcher } from '../src/reservation/reserve';
import { addToPool, isInPool, removeFromPool } from '../src/redis/geo-index';
import { storePosition } from '../src/redis/positions';
import { setOnline, setOffline } from '../src/driver/availability';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const RUN_ID = randomUUID().slice(0, 8);
const id = (label: string) => `${label}-${RUN_ID}`;

const SOMEWHERE = { latitude: 4.05, longitude: 9.7 };

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
      redis.del(`babana:driver:reservation:${driverId}`),
      redis.del(`babana:driver:position:${driverId}`),
    ])
  );
  redis.disconnect();
});

async function availableDriver(label: string): Promise<string> {
  const driverId = id(label);
  usedIds.add(driverId);
  await setOnline(redis, driverId);
  await storePosition(
    redis,
    driverId,
    { ...SOMEWHERE, accuracyMeters: 10, speedMetersPerSecond: 0, headingDegrees: 0, capturedAtMs: Date.now() },
    60
  );
  await addToPool(redis, driverId, SOMEWHERE.latitude, SOMEWHERE.longitude);
  return driverId;
}

describe('reserveDriver/releaseDriver (L3-06)', () => {
  test('réserve un chauffeur disponible, et le retire du pool', async () => {
    const driverId = await availableDriver('r1');
    const outcome = await reserveDriver(redis, driverId, 30);
    assert.deepEqual(outcome, { reserved: true });
    assert.equal(await isInPool(redis, driverId), false);
    assert.equal(await isReserved(redis, driverId), true);
  });

  test('échoue sur un chauffeur absent du pool (déjà réservé, hors ligne, ou inconnu)', async () => {
    const driverId = id('r2-never-online');
    usedIds.add(driverId);
    const outcome = await reserveDriver(redis, driverId, 30);
    assert.deepEqual(outcome, { reserved: false });
  });

  test('critère 3 -- un chauffeur réservé ne réapparaît plus dans une requête de proximité', async () => {
    const driverId = await availableDriver('r3');
    assert.equal(await isInPool(redis, driverId), true, 'disponible avant réservation');

    await reserveDriver(redis, driverId, 30);
    assert.equal(await isInPool(redis, driverId), false, 'absent du pool donc absent de nearby.drivers (L3-05)');
  });

  test("critère 4 -- l'échec de l'appel Odoo libère la réservation (chemin explicite)", async () => {
    const driverId = await availableDriver('r4');
    await reserveDriver(redis, driverId, 30);
    assert.equal(await isInPool(redis, driverId), false);

    // Simule l'échec de l'appel à Odoo qui devait suivre la réservation (L3-06, spécification) :
    // le chauffeur doit réintégrer le pool, puisqu'il est toujours en ligne avec une position
    // fraîche.
    await releaseDriver(redis, driverId);
    assert.equal(await isInPool(redis, driverId), true);
    assert.equal(await isReserved(redis, driverId), false);
  });

  test("releaseDriver ne réintègre pas un chauffeur passé hors ligne pendant sa réservation", async () => {
    const driverId = await availableDriver('r4b');
    await reserveDriver(redis, driverId, 30);
    await setOffline(redis, driverId);

    await releaseDriver(redis, driverId);
    assert.equal(await isInPool(redis, driverId), false, 'hors ligne : ne doit jamais être réintégré au pool');
  });

  test('critère 5 -- la réservation expire et libère le chauffeur, sans appel explicite', async () => {
    const stopWatcher = startReservationExpiryWatcher(redis);
    try {
      const driverId = await availableDriver('r5');
      const outcome = await reserveDriver(redis, driverId, 1);
      assert.deepEqual(outcome, { reserved: true });
      assert.equal(await isInPool(redis, driverId), false);

      // TTL de 1 s ci-dessus : laisser largement le temps à Redis d'émettre l'événement
      // d'expiration et au service de le traiter.
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      assert.equal(await isReserved(redis, driverId), false, 'la clé de réservation doit avoir expiré');
      assert.equal(await isInPool(redis, driverId), true, 'le chauffeur doit être réintégré au pool, sans appel explicite');
    } finally {
      stopWatcher();
    }
  });
});
