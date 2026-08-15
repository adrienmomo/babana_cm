// Contre un Redis réel (nécessite `make up`, ou au moins `docker compose up redis`) : le
// géo-index (GEOADD/GEOSEARCH) s'appuie sur un scoring géospatial interne à Redis qu'une
// imitation en mémoire reproduirait mal (précision, tri par distance) -- même principe que les
// tests de réservation atomique (L3-06/L3-13), qui refusent un double en mémoire pour la même
// raison. REDIS_URL, comme test/concurrency/helpers/odoo-session.ts pour Odoo.
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Redis from 'ioredis';
import {
  addToPool,
  removeFromPool,
  isInPool,
  findNearby,
} from '../src/redis/geo-index';
import { storePosition } from '../src/redis/positions';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const AKWA = { latitude: 4.0483, longitude: 9.6934 };
const BONAPRISO = { latitude: 4.027, longitude: 9.704 }; // ~2.5 km d'Akwa
const BONABERI = { latitude: 4.085, longitude: 9.66 }; // ~7 km d'Akwa

let redis: Redis;

before(() => {
  redis = new Redis(REDIS_URL);
});

after(async () => {
  redis.disconnect();
});

beforeEach(async () => {
  await redis.del('babana:drivers:available');
  await redis.del(
    'babana:driver:position:driver-a',
    'babana:driver:position:driver-b',
    'babana:driver:position:driver-c'
  );
});

async function freshen(driverId: string, position: { latitude: number; longitude: number }) {
  await storePosition(
    redis,
    driverId,
    { ...position, accuracyMeters: 10, speedMetersPerSecond: 5, headingDegrees: 0, capturedAtMs: Date.now() },
    60
  );
}

describe('géo-index des chauffeurs disponibles (L3-03)', () => {
  test('critère 1 -- un chauffeur en ligne apparaît, hors ligne il en sort', async () => {
    await freshen('driver-a', AKWA);
    await addToPool(redis, 'driver-a', AKWA.latitude, AKWA.longitude);
    assert.equal(await isInPool(redis, 'driver-a'), true);

    await removeFromPool(redis, 'driver-a');
    assert.equal(await isInPool(redis, 'driver-a'), false);
  });

  test("critère 2 -- un chauffeur jamais mis en ligne (équivalent : en course) n'apparaît jamais", async () => {
    // Ce module ne connaît aucune notion de "en course" -- c'est L3-04/L3-06/L3-07 (l'appelant)
    // qui décide de ne jamais appeler addToPool, ou d'appeler removeFromPool à l'affectation.
    // Absence de addToPool() est donc la façon correcte de représenter ce cas ici.
    await freshen('driver-a', AKWA);
    const results = await findNearby(redis, AKWA, 5_000, 5);
    assert.deepEqual(results, []);
  });

  test("critère 3 -- un chauffeur au plafond d'encaisse n'apparaît jamais (même raisonnement)", async () => {
    await freshen('driver-a', AKWA);
    // Jamais ajouté -- L3-04 refuserait le passage en ligne pour ce motif.
    assert.equal(await isInPool(redis, 'driver-a'), false);
  });

  test('critère 4 -- les résultats sont triés par distance croissante', async () => {
    await freshen('driver-a', BONABERI);
    await freshen('driver-b', AKWA);
    await freshen('driver-c', BONAPRISO);
    await addToPool(redis, 'driver-a', BONABERI.latitude, BONABERI.longitude);
    await addToPool(redis, 'driver-b', AKWA.latitude, AKWA.longitude);
    await addToPool(redis, 'driver-c', BONAPRISO.latitude, BONAPRISO.longitude);

    const results = await findNearby(redis, AKWA, 10_000, 5);
    assert.deepEqual(
      results.map((r) => r.driverId),
      ['driver-b', 'driver-c', 'driver-a']
    );
    assert.ok(results[0]!.distanceMeters < results[1]!.distanceMeters);
    assert.ok(results[1]!.distanceMeters < results[2]!.distanceMeters);
  });

  test('critère 5 -- un rayon sans chauffeur renvoie une liste vide, pas une erreur', async () => {
    const results = await findNearby(redis, AKWA, 100, 5);
    assert.deepEqual(results, []);
  });

  test('un rayon en dehors de tout chauffeur exclut les candidats trop loin', async () => {
    await freshen('driver-a', BONABERI); // ~7 km
    await addToPool(redis, 'driver-a', BONABERI.latitude, BONABERI.longitude);

    const results = await findNearby(redis, AKWA, 1_000, 5);
    assert.deepEqual(results, []);
  });

  test('un chauffeur dont la position a expiré est exclu, et nettoyé du pool au passage', async () => {
    // Ajouté au géo-index, mais sans position fraîche stockée (L3-02) -- simule une expiration.
    await addToPool(redis, 'driver-a', AKWA.latitude, AKWA.longitude);
    assert.equal(await isInPool(redis, 'driver-a'), true);

    const results = await findNearby(redis, AKWA, 5_000, 5);
    assert.deepEqual(results, []);
    assert.equal(await isInPool(redis, 'driver-a'), false, 'nettoyage paresseux au passage');
  });
});
