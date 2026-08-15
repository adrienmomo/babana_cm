// Contre un Redis réel (nécessite `make up`, ou au moins `docker compose up redis`) : le
// géo-index (GEOADD/GEOSEARCH) s'appuie sur un scoring géospatial interne à Redis qu'une
// imitation en mémoire reproduirait mal (précision, tri par distance) -- même principe que les
// tests de réservation atomique (L3-06/L3-13), qui refusent un double en mémoire pour la même
// raison. REDIS_URL, comme test/concurrency/helpers/odoo-session.ts pour Odoo.
//
// Identifiants de chauffeur suffixés par un identifiant de run unique (pas un `del` du géo-index
// partagé en beforeEach) : Node exécute les fichiers de test en parallèle, plusieurs fichiers de
// ce paquet touchent la même clé Redis de production (`babana:drivers:available`) -- un `del`
// aveugle en effacerait les membres qu'un autre fichier est en train d'ajouter au même instant
// (constaté : `npm test` complet faisait échouer ce fichier par intermittence).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import {
  addToPool,
  removeFromPool,
  isInPool,
  findNearby,
} from '../src/redis/geo-index';
import { storePosition } from '../src/redis/positions';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const RUN_ID = randomUUID().slice(0, 8);
const id = (label: string) => `${label}-${RUN_ID}`;

const AKWA = { latitude: 4.0483, longitude: 9.6934 };
const BONAPRISO = { latitude: 4.027, longitude: 9.704 }; // ~2.5 km d'Akwa
const BONABERI = { latitude: 4.085, longitude: 9.66 }; // ~7 km d'Akwa

let redis: Redis;
const usedIds = new Set<string>();

before(() => {
  redis = new Redis(REDIS_URL);
});

after(async () => {
  await Promise.all(
    [...usedIds].flatMap((driverId) => [
      removeFromPool(redis, driverId),
      redis.del(`babana:driver:position:${driverId}`),
    ])
  );
  redis.disconnect();
});

async function freshen(label: string, position: { latitude: number; longitude: number }) {
  const driverId = id(label);
  usedIds.add(driverId);
  await storePosition(
    redis,
    driverId,
    { ...position, accuracyMeters: 10, speedMetersPerSecond: 5, headingDegrees: 0, capturedAtMs: Date.now() },
    60
  );
  return driverId;
}

function trackedId(label: string): string {
  const driverId = id(label);
  usedIds.add(driverId);
  return driverId;
}

describe('géo-index des chauffeurs disponibles (L3-03)', () => {
  test('critère 1 -- un chauffeur en ligne apparaît, hors ligne il en sort', async () => {
    const driverId = await freshen('c1-driver-a', AKWA);
    await addToPool(redis, driverId, AKWA.latitude, AKWA.longitude);
    assert.equal(await isInPool(redis, driverId), true);

    await removeFromPool(redis, driverId);
    assert.equal(await isInPool(redis, driverId), false);
  });

  test("critère 2 -- un chauffeur jamais mis en ligne (équivalent : en course) n'apparaît jamais", async () => {
    // Ce module ne connaît aucune notion de "en course" -- c'est L3-04/L3-06/L3-07 (l'appelant)
    // qui décide de ne jamais appeler addToPool, ou d'appeler removeFromPool à l'affectation.
    // Absence de addToPool() est donc la façon correcte de représenter ce cas ici.
    await freshen('c2-driver-a', AKWA);
    const results = await findNearby(redis, AKWA, 5_000, 5);
    assert.deepEqual(
      results.filter((r) => usedIds.has(r.driverId)),
      []
    );
  });

  test("critère 3 -- un chauffeur au plafond d'encaisse n'apparaît jamais (même raisonnement)", async () => {
    const driverId = await freshen('c3-driver-a', AKWA);
    // Jamais ajouté -- L3-04 refuserait le passage en ligne pour ce motif.
    assert.equal(await isInPool(redis, driverId), false);
  });

  test('critère 4 -- les résultats sont triés par distance croissante', async () => {
    const a = await freshen('c4-driver-a', BONABERI);
    const b = await freshen('c4-driver-b', AKWA);
    const c = await freshen('c4-driver-c', BONAPRISO);
    await addToPool(redis, a, BONABERI.latitude, BONABERI.longitude);
    await addToPool(redis, b, AKWA.latitude, AKWA.longitude);
    await addToPool(redis, c, BONAPRISO.latitude, BONAPRISO.longitude);

    const results = (await findNearby(redis, AKWA, 10_000, 20)).filter((r) => usedIds.has(r.driverId));
    assert.deepEqual(
      results.map((r) => r.driverId),
      [b, c, a]
    );
    assert.ok(results[0]!.distanceMeters < results[1]!.distanceMeters);
    assert.ok(results[1]!.distanceMeters < results[2]!.distanceMeters);
  });

  test('critère 5 -- un rayon sans chauffeur renvoie une liste vide, pas une erreur', async () => {
    // Coordonnées isolées, hors de toute autre donnée de ce fichier -- un rayon de 1 m n'y
    // trouvera jamais personne, y compris les chauffeurs des autres tests de ce fichier.
    const results = await findNearby(redis, { latitude: 4.001, longitude: 9.601 }, 1, 5);
    assert.deepEqual(results, []);
  });

  test('un rayon en dehors de tout chauffeur exclut les candidats trop loin', async () => {
    const driverId = await freshen('c6-driver-a', BONABERI); // ~7 km
    await addToPool(redis, driverId, BONABERI.latitude, BONABERI.longitude);

    const results = await findNearby(redis, AKWA, 1_000, 20);
    assert.equal(results.some((r) => r.driverId === driverId), false);
  });

  test('un chauffeur dont la position a expiré est exclu, et nettoyé du pool au passage', async () => {
    // Ajouté au géo-index, mais sans position fraîche stockée (L3-02) -- simule une expiration.
    const driverId = trackedId('c7-driver-a');
    await addToPool(redis, driverId, AKWA.latitude, AKWA.longitude);
    assert.equal(await isInPool(redis, driverId), true);

    const results = await findNearby(redis, AKWA, 5_000, 20);
    assert.equal(results.some((r) => r.driverId === driverId), false);
    assert.equal(await isInPool(redis, driverId), false, 'nettoyage paresseux au passage');
  });
});
