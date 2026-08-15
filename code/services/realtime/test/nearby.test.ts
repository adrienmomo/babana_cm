// Contre un Redis réel, comme test/geo-index.test.ts -- NearbyManager s'appuie sur findNearby
// (GEOADD/GEOSEARCH), qu'une imitation en mémoire reproduirait mal.
//
// Identifiants suffixés par un identifiant de run unique, même raison que geo-index.test.ts :
// plusieurs fichiers de ce paquet touchent la clé de production partagée
// `babana:drivers:available` en parallèle. Chaque test de ce fichier utilise en plus ses propres
// coordonnées, isolées les unes des autres (>5 km d'écart, largement au-delà de tout rayon
// interrogé ici) : les tests de ce fichier tournent dans le même processus, sans purge entre eux,
// et un chauffeur laissé par un test antérieur ne doit jamais fausser le compte exact attendu par
// un autre (même précaution que geo-index.test.ts, critère 5).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { WebSocket } from 'ws';
import { NearbyManager } from '../src/nearby/handler';
import { projectNearbyDrivers } from '../src/nearby/projection';
import { addToPool, removeFromPool } from '../src/redis/geo-index';
import { storePosition } from '../src/redis/positions';
import { setDriverProfile, removeDriverProfile, type DriverProfile } from '../src/redis/driver-profiles';
import { parseConfig, type Config } from '../src/config';
import type { ConnectionContext } from '../src/ws/auth';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const RUN_ID = randomUUID().slice(0, 8);
const id = (label: string) => `${label}-${RUN_ID}`;

const BASE_ENV = {
  REDIS_URL,
  ODOO_INTERNAL_URL: 'http://odoo:8069',
  REALTIME_SHARED_SECRET: 'shared-secret',
  JWT_SECRET: 'jwt-secret',
};

const PROFILE: DriverProfile = {
  firstName: 'Paul',
  photoUrl: 'https://storage.babana.cm/mock/drivers/paul.jpg',
  rating: 4.8,
  motorcycleClass: 'standard',
};

const NEARBY_DRIVER_WHITELIST = ['driverId', 'firstName', 'photoUrl', 'rating', 'motorcycleClass', 'position', 'distanceMeters'].sort();

let redis: Redis;
const usedIds = new Set<string>();

before(() => {
  redis = new Redis(REDIS_URL);
});

after(async () => {
  await Promise.all(
    [...usedIds].flatMap((driverId) => [
      removeFromPool(redis, driverId),
      removeDriverProfile(redis, driverId),
      redis.del(`babana:driver:position:${driverId}`),
    ])
  );
  redis.disconnect();
});

async function freshDriver(
  label: string,
  position: { latitude: number; longitude: number },
  profile: DriverProfile = PROFILE
): Promise<string> {
  const driverId = id(label);
  usedIds.add(driverId);
  await storePosition(
    redis,
    driverId,
    { ...position, accuracyMeters: 10, speedMetersPerSecond: 5, headingDegrees: 0, capturedAtMs: Date.now() },
    60
  );
  await addToPool(redis, driverId, position.latitude, position.longitude);
  await setDriverProfile(redis, driverId, profile);
  return driverId;
}

function clientContext(label: string): ConnectionContext {
  return Object.freeze({ userId: id(label), role: 'client', driverId: null });
}

/** Faux WebSocket : NearbyManager ne lit que `readyState`/`OPEN` et écrit via `send`, aucune
 * connexion réseau réelle n'est nécessaire pour ces tests. */
function fakeSocket() {
  const messages: { payload: { drivers: { driverId: string }[] } }[] = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => messages.push(JSON.parse(data)),
  };
  return { socket: socket as unknown as WebSocket, messages };
}

function configWith(overrides: Partial<Record<string, string>> = {}): Config {
  return parseConfig({ ...BASE_ENV, ...overrides });
}

describe('projectNearbyDrivers (L3-05)', () => {
  test('critère 3 -- les positions renvoyées sont arrondies', async () => {
    const origin = { latitude: 4.12, longitude: 9.62 };
    const rawPosition = { latitude: 4.120123456, longitude: 9.620123456 };
    const driverId = await freshDriver('c3-driver', rawPosition);

    const results = await projectNearbyDrivers(redis, origin, 3_000, 5);
    const found = results.find((r) => r.driverId === driverId);
    assert.ok(found, 'le chauffeur doit apparaître');
    assert.notEqual(found!.position.latitude, rawPosition.latitude, 'la position brute ne doit jamais être renvoyée telle quelle');
    assert.equal(found!.position.latitude, 4.1201);
    assert.equal(found!.position.longitude, 9.6201);
  });

  test('critère 4 -- la charge utile ne contient aucun champ hors liste blanche (nom complet, téléphone, immatriculation absents)', async () => {
    const origin = { latitude: 4.0, longitude: 9.7 };
    const driverId = await freshDriver('c4-driver', origin);

    const results = await projectNearbyDrivers(redis, origin, 3_000, 5);
    const found = results.find((r) => r.driverId === driverId);
    assert.ok(found);
    assert.deepEqual(Object.keys(found!).sort(), NEARBY_DRIVER_WHITELIST);
    for (const forbidden of ['lastName', 'fullName', 'phone', 'phoneNumber', 'licensePlate', 'email']) {
      assert.equal(Object.prototype.hasOwnProperty.call(found, forbidden), false, `${forbidden} ne doit jamais être présent`);
    }
  });

  test('un chauffeur disponible sans profil en cache est omis, jamais complété par une valeur inventée (amoa/questions/L3-05.md)', async () => {
    const origin = { latitude: 4.06, longitude: 9.7 };
    const driverId = id('c-no-profile');
    usedIds.add(driverId);
    await storePosition(
      redis,
      driverId,
      { ...origin, accuracyMeters: 10, speedMetersPerSecond: 0, headingDegrees: 0, capturedAtMs: Date.now() },
      60
    );
    await addToPool(redis, driverId, origin.latitude, origin.longitude);
    // Pas de setDriverProfile ici, délibérément.

    const results = await projectNearbyDrivers(redis, origin, 3_000, 5);
    assert.equal(results.some((r) => r.driverId === driverId), false);
  });

  test("exactement 5 résultats renvoyés, les plus proches, même avec des positions expirées en masse (critère 2, en dur -- projection = géo-index + profil)", async () => {
    const origin = { latitude: 4.0, longitude: 9.62 };
    const staleIds: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const driverId = id(`c2-stale-${i}`);
      usedIds.add(driverId);
      staleIds.push(driverId);
      await addToPool(redis, driverId, origin.latitude, origin.longitude + i * 0.00005);
      await setDriverProfile(redis, driverId, PROFILE);
    }
    const freshIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      freshIds.push(await freshDriver(`c2-fresh-${i}`, { latitude: origin.latitude, longitude: origin.longitude + 0.01 + i * 0.0002 }));
    }

    const results = await projectNearbyDrivers(redis, origin, 3_000, 5);
    assert.equal(results.length, 5, `attendu 5, obtenu ${results.length}`);
    assert.deepEqual(
      results.map((r) => r.driverId),
      freshIds.slice(0, 5)
    );

    for (const driverId of staleIds) await removeFromPool(redis, driverId);
  });
});

describe('NearbyManager (L3-05, D14)', () => {
  test('critère 1 -- un rayon demandé supérieur au plafond est ramené au plafond, sans erreur', async () => {
    const origin = { latitude: 4.12, longitude: 9.7 };
    const config = configWith({ NEARBY_MAX_RADIUS_METERS: '500' });
    const manager = new NearbyManager(config, redis);
    const context = clientContext('c1-client');
    const { socket, messages } = fakeSocket();

    // ~1.1 km du centre : au-delà du plafond de 500 m, mais dans le rayon demandé (40 km).
    const farDriverId = await freshDriver('c1-far', { latitude: origin.latitude, longitude: origin.longitude + 0.01 });

    await assert.doesNotReject(() => manager.subscribe(context, socket, { position: origin, radiusMeters: 40_000 }));
    manager.unsubscribe(context);

    assert.equal(messages.length, 1);
    assert.equal(
      messages[0]!.payload.drivers.some((d) => d.driverId === farDriverId),
      false,
      'exclu malgré le rayon demandé : au-delà du plafond configuré côté service'
    );
  });

  test('critère 5 -- un second abonnement du même client remplace le premier', async () => {
    const origin = { latitude: 4.12, longitude: 9.78 };
    const otherOrigin = { latitude: 4.06, longitude: 9.78 };
    const config = configWith({ NEARBY_BROADCAST_INTERVAL_SECONDS: '0.05' });
    const manager = new NearbyManager(config, redis);
    const context = clientContext('c5-client');
    const { socket, messages } = fakeSocket();

    const driverNearOrigin = await freshDriver('c5-driver-origin', origin);
    const driverNearOther = await freshDriver('c5-driver-other', otherOrigin);

    await manager.subscribe(context, socket, { position: origin, radiusMeters: 3_000 });
    await manager.subscribe(context, socket, { position: otherOrigin, radiusMeters: 3_000 });

    // Laisse un intervalle de diffusion s'écouler : si le premier abonnement n'avait pas été
    // annulé, deux minuteurs tourneraient et produiraient des messages pour les deux origines.
    await new Promise((resolve) => setTimeout(resolve, 120));
    manager.unsubscribe(context);

    assert.ok(messages.length >= 2, 'au moins la réponse immédiate de chaque abonnement');
    for (const message of messages.slice(1)) {
      assert.equal(
        message.payload.drivers.some((d) => d.driverId === driverNearOrigin),
        false,
        'plus aucun message ne doit porter le résultat du premier abonnement, remplacé par le second'
      );
    }
    assert.ok(messages.at(-1)!.payload.drivers.some((d) => d.driverId === driverNearOther));
  });

  test('critère 6 -- la limitation de débit est appliquée', async () => {
    const origin = { latitude: 4.0, longitude: 9.8 };
    const config = configWith({ NEARBY_RATE_LIMIT_MAX_SUBSCRIPTIONS: '2', NEARBY_RATE_LIMIT_WINDOW_SECONDS: '60' });
    const manager = new NearbyManager(config, redis);
    const context = clientContext('c6-client');

    const attempts: { messages: unknown[] }[] = [];
    for (let i = 0; i < 4; i += 1) {
      const { socket, messages } = fakeSocket();
      // eslint-disable-next-line no-await-in-loop -- les abonnements doivent être séquentiels
      // pour que le compteur de débit les voie un par un, comme des appels WebSocket réels.
      await manager.subscribe(context, socket, { position: origin, radiusMeters: 3_000 });
      attempts.push({ messages });
    }
    manager.unsubscribe(context);

    const responded = attempts.filter((a) => a.messages.length > 0);
    assert.equal(responded.length, 2, `seuls les 2 premiers abonnements (limite) doivent produire une réponse, obtenu ${responded.length}`);
  });
});
