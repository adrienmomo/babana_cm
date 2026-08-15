// Test de concurrence sur la réservation atomique (L3-06, critère 2 ; L3-13). Contre un Redis
// réel -- un double en mémoire ne reproduirait pas la condition de course que ce test existe pour
// détecter (même principe que test/concurrency/ride-transitions.test.ts côté Odoo, L4-11).
//
// N connexions Redis distinctes, pas une seule avec Promise.all : Redis sérialise de toute façon
// l'exécution de ses commandes (mono-thread), mais des connexions séparées collent mieux à ce que
// "N tentatives réellement simultanées" décrit -- plusieurs appelants indépendants, comme
// plusieurs requêtes HTTP concurrentes arrivant sur le service temps réel.
//
// **Piège documenté par la spécification (critère 5)** : un test de concurrence qui passerait
// aussi avec une implémentation naïve (lire, puis écrire, en deux temps) ne teste rien. Vérifié
// une fois pendant l'implémentation, comme pour C2 la nuit dernière côté Odoo (amoa/questions/
// REPONSES-2026-08-16.md) : reserveDriver() a été temporairement remplacée par une version
// naïve (ZSCORE puis, si présent, ZREM+SET en deux appels distincts) et ce fichier échouait
// alors, de façon reproductible, sur le scénario ci-dessous -- plusieurs succès sur la même
// itération. Version atomique restaurée ensuite ; rien de la version naïve ne reste dans le dépôt.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { reserveDriver, releaseDriver, isReserved } from '../../src/reservation/reserve';
import { addToPool, isInPool, removeFromPool } from '../../src/redis/geo-index';
import { storePosition } from '../../src/redis/positions';
import { setOnline, setOffline } from '../../src/driver/availability';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const RUN_ID = randomUUID().slice(0, 8);
const id = (label: string) => `${label}-${RUN_ID}`;

const ITERATIONS = Number(process.env.L3_13_ITERATIONS ?? 30);
const CONCURRENCY = Number(process.env.L3_13_CONCURRENCY ?? 10);

const SOMEWHERE = { latitude: 4.02, longitude: 9.66 };

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
      cleanup.del(`babana:driver:reservation:${driverId}`),
      cleanup.del(`babana:driver:position:${driverId}`),
    ])
  );
  await Promise.all(connections.map((c) => c.quit()));
  await cleanup.quit();
});

async function freshAvailableDriver(label: string): Promise<string> {
  const driverId = id(label);
  usedIds.add(driverId);
  await setOnline(cleanup, driverId);
  await storePosition(
    cleanup,
    driverId,
    { ...SOMEWHERE, accuracyMeters: 10, speedMetersPerSecond: 0, headingDegrees: 0, capturedAtMs: Date.now() },
    60
  );
  await addToPool(cleanup, driverId, SOMEWHERE.latitude, SOMEWHERE.longitude);
  return driverId;
}

describe('réservation concurrente sur le même chauffeur (L3-13)', () => {
  test(
    `${ITERATIONS} itérations x ${CONCURRENCY} tentatives simultanées -- exactement un succès à chaque fois`,
    { timeout: 180_000 },
    async () => {
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const driverId = await freshAvailableDriver(`conc-${iteration}`);

        // eslint-disable-next-line no-await-in-loop -- chaque itération doit être résolue avant
        // la suivante (l'état Redis vérifié en dépend) ; la concurrence testée est DANS chaque
        // itération (les N appels ci-dessous), pas entre itérations.
        const outcomes = await Promise.all(
          connections.map((connection) => reserveDriver(connection, driverId, 30))
        );

        const successes = outcomes.filter((o) => o.reserved);
        const failures = outcomes.filter((o) => !o.reserved);

        assert.equal(
          successes.length,
          1,
          `itération ${iteration} : ${successes.length} succès sur ${CONCURRENCY} tentatives (attendu : exactement 1)`
        );
        assert.equal(failures.length, CONCURRENCY - 1);

        // eslint-disable-next-line no-await-in-loop
        const [inPool, reserved] = await Promise.all([isInPool(cleanup, driverId), isReserved(cleanup, driverId)]);
        assert.equal(inPool, false, `itération ${iteration} : le chauffeur doit être hors du pool après réservation`);
        assert.equal(reserved, true, `itération ${iteration} : la clé de réservation doit exister`);

        // eslint-disable-next-line no-await-in-loop -- referme proprement avant l'itération suivante.
        await releaseDriver(cleanup, driverId);
      }
    }
  );

  test('scénario mixte -- réservations concurrentes pendant que d\'autres chauffeurs entrent et sortent du pool', { timeout: 60_000 }, async () => {
    const driverId = await freshAvailableDriver('mixed-target');

    const churnIds = await Promise.all(Array.from({ length: 5 }, (_, i) => freshAvailableDriver(`mixed-churn-${i}`)));
    let churning = true;
    const churn = (async () => {
      while (churning) {
        // eslint-disable-next-line no-await-in-loop -- un bruit de fond volontairement séquentiel
        // sur les AUTRES chauffeurs, pendant que la réservation ci-dessous s'exécute sur driverId.
        await Promise.all(
          churnIds.map((churnId, i) =>
            i % 2 === 0 ? removeFromPool(cleanup, churnId) : addToPool(cleanup, churnId, SOMEWHERE.latitude, SOMEWHERE.longitude)
          )
        );
      }
    })();

    const outcomes = await Promise.all(connections.map((connection) => reserveDriver(connection, driverId, 30)));
    churning = false;
    await churn;

    assert.equal(
      outcomes.filter((o) => o.reserved).length,
      1,
      "le bruit de fond sur d'autres chauffeurs ne doit jamais changer l'issue de la réservation ciblée"
    );

    await releaseDriver(cleanup, driverId);
    await Promise.all(churnIds.map((churnId) => removeFromPool(cleanup, churnId)));
  });
});
