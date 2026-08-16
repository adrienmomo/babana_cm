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
import { isInPool, removeFromPool } from '../src/redis/geo-index';
import { addEligibleToPool } from '../src/redis/pool-eligibility';
import { storePosition } from '../src/redis/positions';
import { setOnline, setOffline } from '../src/driver/availability';
import { setEngaged, clearEngaged, isEngaged } from '../src/driver/engagement';
import { ingestPosition } from '../src/tracking/ingest';
import type { PlausibilityConfig } from '../src/tracking/validation';
import type { ConnectionContext } from '../src/ws/auth';

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
      clearEngaged(redis, driverId),
      redis.del(`babana:driver:reservation:${driverId}`),
      redis.del(`babana:driver:position:${driverId}`),
    ])
  );
  redis.disconnect();
});

const PLAUSIBILITY: PlausibilityConfig = {
  bounds: { minLatitude: 3.95, maxLatitude: 4.15, minLongitude: 9.6, maxLongitude: 9.85 },
  maxAccuracyMeters: 150,
  maxTimestampFutureMs: 5_000,
  maxTimestampAgeMs: 30_000,
  maxImpliedSpeedMetersPerSecond: 38.9,
};

function driverContext(driverId: string): ConnectionContext {
  return Object.freeze({ userId: `user-${driverId}`, role: 'driver', driverId });
}

function positionMessage(latitude: number, longitude: number) {
  return {
    type: 'position.update' as const,
    id: randomUUID(),
    emittedAt: new Date().toISOString(),
    payload: {
      latitude,
      longitude,
      accuracyMeters: 10,
      speedMetersPerSecond: 0,
      headingDegrees: 0,
    },
  };
}

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
  await addEligibleToPool(redis, driverId, SOMEWHERE.latitude, SOMEWHERE.longitude);
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

  test(
    'critère 3 bis (D26) -- un chauffeur réservé qui continue d\'émettre des positions ne revient jamais dans le pool',
    async () => {
      const driverId = await availableDriver('r3bis');
      const outcome = await reserveDriver(redis, driverId, 30);
      assert.deepEqual(outcome, { reserved: true });
      assert.equal(await isInPool(redis, driverId), false, 'hors du pool juste après la réservation');

      // Le défaut relevé le 16 août (amoa/questions/REPONSES-2026-08-16-J7.md §2) : ingestPosition
      // (L3-02) rappelait addToPool à chaque position acceptée, sans rien savoir de la
      // réservation -- quelques positions suffisaient à ramener le chauffeur dans le pool pendant
      // que sa réservation était toujours active.
      const context = driverContext(driverId);
      for (let i = 0; i < 3; i += 1) {
        // Coordonnées inchangées d'une itération à l'autre, volontairement : ce test vérifie
        // l'appartenance au pool, pas la validation de plausibilité (L3-02) -- un déplacement
        // même modeste, sur le délai réel de quelques millisecondes entre deux positions dans
        // cette boucle, produirait une vitesse implicite artificiellement énorme et serait rejeté
        // à bon droit par checkPlausibility, ce qui ne prouverait rien pour ce critère.
        const message = positionMessage(SOMEWHERE.latitude, SOMEWHERE.longitude);
        // eslint-disable-next-line no-await-in-loop -- chaque position doit être traitée avant la
        // suivante pour observer l'état du pool entre deux, pas seulement à la fin.
        const result = await ingestPosition(redis, context, message, PLAUSIBILITY, 60);
        assert.equal(result.accepted, true, `position ${i} doit être acceptée`);
        // eslint-disable-next-line no-await-in-loop
        assert.equal(
          await isInPool(redis, driverId),
          false,
          `après la position ${i} : un chauffeur réservé ne doit jamais réapparaître dans le pool`
        );
      }

      assert.equal(await isReserved(redis, driverId), true, 'la réservation doit rester active pendant tout ce temps');
    }
  );

  test('critère 3 ter (D26) -- un chauffeur engagé sur une course ne revient jamais dans le pool, quoi qu\'il émette', async () => {
    const driverId = await availableDriver('r3ter');
    await reserveDriver(redis, driverId, 30);

    // L'acceptation (L3-07) pose l'engagement en remplacement de la réservation -- simulé ici
    // directement, cette tâche ne couvrant que le pool et l'engagement, pas le cycle de
    // proposition qui les relie (voir test/proposal.test.ts, L3-07).
    await redis.del(`babana:driver:reservation:${driverId}`);
    await setEngaged(redis, driverId);

    const context = driverContext(driverId);
    for (let i = 0; i < 3; i += 1) {
      // Coordonnées inchangées d'une itération à l'autre, volontairement (voir le commentaire du
      // test précédent) : ce test vérifie l'appartenance au pool, pas la validation de
      // plausibilité (L3-02).
      const message = positionMessage(SOMEWHERE.latitude, SOMEWHERE.longitude);
      // eslint-disable-next-line no-await-in-loop
      const result = await ingestPosition(redis, context, message, PLAUSIBILITY, 60);
      assert.equal(result.accepted, true);
      // eslint-disable-next-line no-await-in-loop
      assert.equal(
        await isInPool(redis, driverId),
        false,
        `après la position ${i} : un chauffeur engagé ne doit jamais réapparaître dans le pool`
      );
    }

    assert.equal(await isEngaged(redis, driverId), true, 'engagement toujours actif, aucune expiration automatique');
  });

  test(
    "critère 5 (D26) -- l'engagement, lui, n'expire jamais tout seul : le veilleur de réservation ne le touche pas",
    async () => {
      const stopWatcher = startReservationExpiryWatcher(redis);
      try {
        const driverId = await availableDriver('r5-engaged');
        await reserveDriver(redis, driverId, 1);

        // Le second défaut du même sang (amoa/questions/REPONSES-2026-08-16-J7.md §2) : rien ne
        // supprimait la réservation à l'acceptation, si bien qu'elle expirait en pleine course et
        // le veilleur d'expiration remettait au pool un chauffeur qui transportait un passager.
        // L'acceptation remplace donc la réservation par l'engagement -- simulé ici comme ci-dessus.
        await redis.del(`babana:driver:reservation:${driverId}`);
        await setEngaged(redis, driverId);

        // Largement au-delà du TTL de réservation (1 s) posé ci-dessus : si le veilleur touchait
        // encore ce chauffeur, il réapparaîtrait dans le pool ici.
        await new Promise((resolve) => setTimeout(resolve, 1_500));

        assert.equal(await isEngaged(redis, driverId), true, "l'engagement ne porte aucun TTL, il doit survivre");
        assert.equal(
          await isInPool(redis, driverId),
          false,
          'un chauffeur engagé ne doit jamais être remis au pool par le veilleur de réservation'
        );
      } finally {
        stopWatcher();
      }
    }
  );
});
