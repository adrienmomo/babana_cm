// Concurrence de la sélection automatique (le plus proche, choisi par le serveur) : N demandes
// simultanées autour des mêmes chauffeurs ne doivent jamais obtenir deux fois le même (invariant 4).
// Contre un Redis réel, N connexions distinctes -- même discipline que reservation.test.ts (L3-13).
//
// Vérifié une fois pendant l'implémentation, comme le demande L3-13 : `reserveNearestDriver` a été
// temporairement remplacée par une version naïve (GEOSEARCH en TypeScript, puis `reserveDriver` sur
// le premier candidat, sans repli sur le suivant) et le second scénario échouait -- des demandes
// restaient sans chauffeur alors que d'autres étaient libres, le premier candidat étant pris entre
// la lecture et l'écriture. Version atomique restaurée ; rien de la version naïve ne reste.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { reserveNearestDriver } from '../../src/reservation/reserve';
import { removeFromPool } from '../../src/redis/geo-index';
import { addEligibleToPool } from '../../src/redis/pool-eligibility';
import { storePosition, positionKey } from '../../src/redis/positions';
import { setOnline, setOffline } from '../../src/driver/availability';
import { rideStateKey } from '../../src/ride/state';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const RUN_ID = randomUUID().slice(0, 8);
const id = (label: string) => `${label}-${RUN_ID}`;

const ITERATIONS = Number(process.env.L3_13_ITERATIONS ?? 30);
const CONCURRENCY = Number(process.env.L3_13_CONCURRENCY ?? 10);
const RADIUS_METERS = 300;

let connections: Redis[];
let cleanup: Redis;
const usedIds = new Set<string>();

before(() => {
  connections = Array.from({ length: CONCURRENCY }, () => new Redis(REDIS_URL));
  cleanup = new Redis(REDIS_URL);
});

after(async () => {
  await Promise.all(
    [...usedIds].flatMap((driverId) => [
      removeFromPool(cleanup, driverId),
      setOffline(cleanup, driverId),
      cleanup.del(rideStateKey(driverId)),
      cleanup.del(positionKey(driverId)),
    ])
  );
  await Promise.all(connections.map((c) => c.quit()));
  await cleanup.quit();
});

// Un point par itération, à ~1 km du précédent (rayon 300 m) : jamais deux itérations à portée.
let spotIndex = 0;
function uniqueSpot(): { latitude: number; longitude: number } {
  spotIndex += 1;
  return { latitude: 4.1 + (spotIndex % 10) * 0.01, longitude: 9.74 + Math.floor(spotIndex / 10) * 0.01 };
}

async function availableDriverAt(label: string, at: { latitude: number; longitude: number }): Promise<string> {
  const driverId = id(label);
  usedIds.add(driverId);
  await setOnline(cleanup, driverId);
  await storePosition(
    cleanup,
    driverId,
    { ...at, accuracyMeters: 10, speedMetersPerSecond: 0, headingDegrees: 0, capturedAtMs: Date.now() },
    60
  );
  await addEligibleToPool(cleanup, driverId, at.latitude, at.longitude);
  return driverId;
}

describe('sélection automatique concurrente (invariant 4)', () => {
  test(`un seul chauffeur, ${CONCURRENCY} demandes simultanées : exactement une l'obtient (${ITERATIONS} répétitions)`, async () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const pickup = uniqueSpot();
      // eslint-disable-next-line no-await-in-loop -- une itération après l'autre, chacune isolée.
      const driverId = await availableDriverAt(`lone-${iteration}`, pickup);
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.all(
        connections.map((connection) =>
          reserveNearestDriver(connection, { origin: pickup, radiusMeters: RADIUS_METERS, ttlSeconds: 30 })
        )
      );
      const winners = results.filter((chosen) => chosen !== null);
      assert.deepEqual(winners, [driverId], `itération ${iteration} : ${winners.length} gagnants`);
    }
  });

  test(`trois chauffeurs, ${CONCURRENCY} demandes : trois servies, chacune par un chauffeur différent (${ITERATIONS} répétitions)`, async () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const pickup = uniqueSpot();
      // eslint-disable-next-line no-await-in-loop
      const drivers = await Promise.all(
        [20, 60, 120].map((meters, index) =>
          availableDriverAt(`trio-${iteration}-${index}`, { latitude: pickup.latitude + meters / 111_000, longitude: pickup.longitude })
        )
      );
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.all(
        connections.map((connection) =>
          reserveNearestDriver(connection, { origin: pickup, radiusMeters: RADIUS_METERS, ttlSeconds: 30 })
        )
      );
      const winners = results.filter((chosen): chosen is string => chosen !== null);
      assert.equal(winners.length, 3, `itération ${iteration} : ${winners.length} demandes servies au lieu de 3`);
      assert.deepEqual([...winners].sort(), [...drivers].sort(), 'jamais deux fois le même chauffeur');
    }
  });

  test(`classement routier commun, ${CONCURRENCY} demandes : trois servies, jamais deux fois le même (${ITERATIONS} répétitions)`, async () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const pickup = uniqueSpot();
      // eslint-disable-next-line no-await-in-loop
      const drivers = await Promise.all(
        [20, 60, 120].map((meters, index) =>
          availableDriverAt(`road-${iteration}-${index}`, { latitude: pickup.latitude + meters / 111_000, longitude: pickup.longitude })
        )
      );
      // Toutes les demandes portent le même classement routier (inverse du vol d'oiseau) : la gate
      // du vivier, pas l'ordre, doit garantir l'exclusivité.
      const preferredDriverIds = [...drivers].reverse();
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.all(
        connections.map((connection) =>
          reserveNearestDriver(connection, { origin: pickup, radiusMeters: RADIUS_METERS, ttlSeconds: 30, preferredDriverIds })
        )
      );
      const winners = results.filter((chosen): chosen is string => chosen !== null);
      assert.equal(winners.length, 3, `itération ${iteration} : ${winners.length} demandes servies au lieu de 3`);
      assert.deepEqual([...winners].sort(), [...drivers].sort(), 'jamais deux fois le même chauffeur');
    }
  });
});
