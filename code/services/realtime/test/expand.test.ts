// Contre un Redis réel, comme test/nearby.test.ts -- findNearbyWithExpansion s'appuie sur
// projectNearbyDrivers (géo-index + profils), qu'une imitation en mémoire reproduirait mal.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { findNearbyWithExpansion, expansionMetrics } from '../src/nearby/expand';
import { removeFromPool } from '../src/redis/geo-index';
import { storePosition } from '../src/redis/positions';
import { setDriverProfile, removeDriverProfile, type DriverProfile } from '../src/redis/driver-profiles';
import { setOffline } from '../src/driver/availability';
import { parseConfig, type Config } from '../src/config';
import { putInPool } from './helpers/pool';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const RUN_ID = randomUUID().slice(0, 8);
const id = (label: string) => `${label}-${RUN_ID}`;

const BASE_ENV = {
  REDIS_URL,
  ODOO_INTERNAL_URL: 'http://odoo:8069',
  REALTIME_SHARED_SECRET: 'shared-secret',
  JWT_SECRET: 'jwt-secret',
  // Paliers étroits (1 km, jusqu'à 3 km) pour placer des chauffeurs à des distances précises et
  // contrôlées, plutôt que les valeurs de production (2 km / 15 km) qui rendraient les tests
  // lents à isoler correctement. NEARBY_MAX_RADIUS_METERS n'est pas utilisé par cette fonction
  // (le rayon de départ est un paramètre explicite, pas lu de la configuration) -- abaissé ici
  // uniquement pour satisfaire le schéma (`.refine`, EXPAND_MAX doit dépasser ce plafond).
  NEARBY_MAX_RADIUS_METERS: '500',
  NEARBY_EXPAND_RADIUS_STEP_METERS: '1000',
  NEARBY_EXPAND_MAX_RADIUS_METERS: '3000',
};

const PROFILE: DriverProfile = {
  firstName: 'Paul',
  photoUrl: null,
  rating: 4.8,
  motorcycleClass: 'standard',
};

// Coin isolé de la zone d'exploitation (>6 km de tout point déjà utilisé par les autres fichiers
// de ce paquet, même raison que nearby.test.ts/proposal.test.ts pour leurs propres origines) :
// ce fichier a besoin d'un rayon vraiment vide pour ses scénarios NO_DRIVER_AVAILABLE.
const ORIGIN = { latitude: 3.96, longitude: 9.84 };
// Décalage en latitude seule (degrés) pour une distance approximative donnée, en mètres --
// 1° de latitude ~= 111 320 m, indépendant de la longitude, donc pas de correction par cosinus
// à appliquer ici.
const metersNorth = (meters: number) => ({ latitude: ORIGIN.latitude + meters / 111_320, longitude: ORIGIN.longitude });

function config(overrides: Partial<Record<string, string>> = {}): Config {
  return parseConfig({ ...BASE_ENV, ...overrides });
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
      removeFromPool(redis, driverId),
      removeDriverProfile(redis, driverId),
      redis.del(`babana:driver:position:${driverId}`),
    ])
  );
  redis.disconnect();
});

async function driverAt(label: string, meters: number): Promise<string> {
  const driverId = id(label);
  usedIds.add(driverId);
  const position = metersNorth(meters);
  await storePosition(
    redis,
    driverId,
    { ...position, accuracyMeters: 10, speedMetersPerSecond: 0, headingDegrees: 0, capturedAtMs: Date.now() },
    60
  );
  await putInPool(redis, driverId, position.latitude, position.longitude);
  await setDriverProfile(redis, driverId, PROFILE);
  return driverId;
}

describe('findNearbyWithExpansion (L3-08)', () => {
  test('critère 1 -- une nouvelle liste est proposée sans les refusants, sans élargir si le rayon initial suffit déjà', async () => {
    const refused = await driverAt('c1-refused', 500);
    const stillHere = await driverAt('c1-still-here', 800);

    const result = await findNearbyWithExpansion(config(), redis, ORIGIN, 1_500, [refused], 5);

    assert.ok('drivers' in result);
    const ids = result.drivers.map((d) => d.driverId);
    assert.ok(ids.includes(stillHere));
    assert.ok(!ids.includes(refused), 'le refusant ne doit jamais réapparaître');

    // Nettoyage explicite (même raison que nearby.test.ts) : les tests suivants de ce fichier
    // ont besoin d'un rayon vraiment vide autour de la même origine.
    await Promise.all([removeFromPool(redis, refused), removeFromPool(redis, stillHere)]);
  });

  test("critère 2 -- élargit par paliers jusqu'à trouver un candidat, quand le rayon demandé exclu ne laisse plus rien", async () => {
    expansionMetrics.reset();
    // Seul candidat à 2 000 m : hors du rayon demandé (1 500), atteint seulement après un palier
    // d'élargissement (1 500 -> 2 500).
    const farDriver = await driverAt('c2-far', 2_000);

    const result = await findNearbyWithExpansion(config(), redis, ORIGIN, 1_500, ['nobody-refused-yet'], 5);

    assert.ok('drivers' in result);
    assert.deepEqual(
      result.drivers.map((d) => d.driverId),
      [farDriver]
    );
    assert.equal(expansionMetrics.snapshot().expansions, 1, "l'élargissement doit être compté");

    await removeFromPool(redis, farDriver);
  });

  test('critère 3 -- au plafond sans aucun candidat, NO_DRIVER_AVAILABLE (aucun élargissement automatique de la découverte libre)', async () => {
    expansionMetrics.reset();

    const result = await findNearbyWithExpansion(config(), redis, ORIGIN, 1_500, ['some-refused-driver'], 5);

    assert.deepEqual(result, { noDriverAvailable: true });
    assert.equal(expansionMetrics.snapshot().failures, 1, "l'échec au plafond doit être compté");
  });

  test('critère 4 -- élargissements et échecs sont comptés par zone (maille grossière) et par tranche horaire', async () => {
    expansionMetrics.reset();
    const farDriver = await driverAt('c4-far', 2_000);

    await findNearbyWithExpansion(config(), redis, ORIGIN, 1_500, ['refused'], 5, Date.parse('2026-08-24T10:00:00Z'));

    const snapshot = expansionMetrics.snapshot();
    assert.equal(snapshot.expansions, 1);
    const buckets = Object.keys(snapshot.byBucket);
    assert.equal(buckets.length, 1, 'un seul repère zone/heure pour cet appel');
    assert.ok(buckets[0]!.includes('10h'), `l'heure doit apparaître dans la clé (${buckets[0]})`);
    assert.equal(snapshot.byBucket[buckets[0]!]!.expansions, 1);

    await removeFromPool(redis, farDriver); // évite d'influencer un test suivant du même fichier
  });

  test("aucun élargissement pour une découverte libre (excludeDriverIds vide) -- le plafond anti-balayage (C2b) n'est jamais dépassé", async () => {
    expansionMetrics.reset();
    // À 2 000 m, donc hors d'un rayon demandé de 1 500 -- ne doit JAMAIS être trouvé sans
    // refusant à exclure, même si le palier d'élargissement l'atteindrait.
    const beyondCap = await driverAt('c5-beyond-cap', 2_000);

    const result = await findNearbyWithExpansion(config(), redis, ORIGIN, 1_500, [], 5);

    assert.deepEqual(result, { noDriverAvailable: true });
    assert.equal(expansionMetrics.snapshot().expansions, 0, 'une découverte libre ne doit jamais compter comme un élargissement');
    assert.equal(expansionMetrics.snapshot().failures, 0);

    await removeFromPool(redis, beyondCap);
  });
});
