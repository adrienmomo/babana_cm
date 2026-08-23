// Contre un Redis réel, comme nearby.test.ts -- TrackingManager s'appuie sur
// tracking/session.ts et redis/positions.ts (SET/GET), qu'une imitation en mémoire reproduirait
// mal pour peu de bénéfice.
//
// Identifiants suffixés par un identifiant de run unique, même raison que nearby.test.ts.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { WebSocket } from 'ws';
import { TrackingManager } from '../src/tracking/broadcast';
import { startRideSession, endRideSessionForDriver } from '../src/tracking/session';
import { storePosition } from '../src/redis/positions';
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

let redis: Redis;
const usedDriverIds = new Set<string>();

before(() => {
  redis = new Redis(REDIS_URL);
});

after(async () => {
  await Promise.all([...usedDriverIds].map((driverId) => redis.del(`babana:driver:position:${driverId}`)));
  redis.disconnect();
});

function configWith(overrides: Partial<Record<string, string>> = {}): Config {
  return parseConfig({ ...BASE_ENV, ...overrides });
}

function clientContext(label: string): ConnectionContext {
  return Object.freeze({ userId: id(label), role: 'client', driverId: null });
}

type FakeMessage = { type: 'driver.position'; payload: { rideId: string; position: { latitude: number; longitude: number }; etaSeconds: number } };

/** Faux WebSocket : TrackingManager ne lit que `readyState`/`OPEN` et écrit via `send`, même
 * patron que nearby.test.ts -- aucune connexion réseau réelle nécessaire. */
function fakeSocket() {
  const messages: FakeMessage[] = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => messages.push(JSON.parse(data)),
  };
  return { socket: socket as unknown as WebSocket, messages };
}

async function positionedDriver(label: string, position: { latitude: number; longitude: number }): Promise<string> {
  const driverId = id(label);
  usedDriverIds.add(driverId);
  await storePosition(
    redis,
    driverId,
    { ...position, accuracyMeters: 10, speedMetersPerSecond: 5, headingDegrees: 0, capturedAtMs: Date.now() },
    60
  );
  return driverId;
}

describe('TrackingManager (L3-09)', () => {
  test('critère 1 -- le client affecté reçoit driver.position, à la fréquence configurée', async () => {
    const config = configWith({ TRACKING_BROADCAST_INTERVAL_SECONDS: '0.05' });
    const manager = new TrackingManager(config, redis);
    const rideId = randomUUID();
    const clientCtx = clientContext('c1-client');
    const origin = { latitude: 4.05, longitude: 9.7 };
    const driverPosition = { latitude: 4.0503, longitude: 9.7002 };
    const driverId = await positionedDriver('c1-driver', driverPosition);
    await startRideSession(redis, rideId, { clientUserId: clientCtx.userId, driverId, origin });

    const { socket, messages } = fakeSocket();
    await manager.subscribe(clientCtx, socket, { rideId });
    await new Promise((resolve) => setTimeout(resolve, 160));
    manager.unsubscribe(clientCtx);

    assert.ok(messages.length >= 2, 'au moins la diffusion immédiate plus une périodique');
    for (const message of messages) {
      assert.equal(message.type, 'driver.position');
      assert.equal(message.payload.rideId, rideId);
    }
  });

  test("critère 2 -- un client non affecté à cette course ne reçoit rien", async () => {
    const config = configWith({ TRACKING_BROADCAST_INTERVAL_SECONDS: '0.05' });
    const manager = new TrackingManager(config, redis);
    const rideId = randomUUID();
    const ownerCtx = clientContext('c2-owner');
    const strangerCtx = clientContext('c2-stranger');
    const origin = { latitude: 4.05, longitude: 9.7 };
    const driverId = await positionedDriver('c2-driver', { latitude: 4.0501, longitude: 9.7001 });
    await startRideSession(redis, rideId, { clientUserId: ownerCtx.userId, driverId, origin });

    const { socket, messages } = fakeSocket();
    // Le rideId existe réellement, mais pas pour CE client -- c'est précisément ce que le
    // critère 2 exige de vérifier, pas seulement un rideId inconnu.
    await manager.subscribe(strangerCtx, socket, { rideId });
    await new Promise((resolve) => setTimeout(resolve, 160));
    manager.unsubscribe(strangerCtx);

    assert.equal(messages.length, 0, "aucun message, même l'immédiat, pour un client qui n'est pas le sien");
  });

  test('critère 3 -- la position diffusée est en précision réelle, contrairement à nearby.drivers (L3-05)', async () => {
    const config = configWith();
    const manager = new TrackingManager(config, redis);
    const rideId = randomUUID();
    const clientCtx = clientContext('c3-client');
    const origin = { latitude: 4.05, longitude: 9.7 };
    // Précision au-delà de NEARBY_POSITION_PRECISION_DECIMALS (4 décimales, C-01/C-02) --
    // l'arrondi de L3-05 la tronquerait, le suivi ne doit pas.
    const exactPosition = { latitude: 4.051234567, longitude: 9.700123456 };
    const driverId = await positionedDriver('c3-driver', exactPosition);
    await startRideSession(redis, rideId, { clientUserId: clientCtx.userId, driverId, origin });

    const { socket, messages } = fakeSocket();
    await manager.subscribe(clientCtx, socket, { rideId });
    manager.unsubscribe(clientCtx);

    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0]!.payload.position, exactPosition);
  });

  test('critère 4 -- le suivi cesse à la fin de la course, vérifié à chaque diffusion (pas seulement à l\'abonnement)', async () => {
    const config = configWith({ TRACKING_BROADCAST_INTERVAL_SECONDS: '0.05' });
    const manager = new TrackingManager(config, redis);
    const rideId = randomUUID();
    const clientCtx = clientContext('c4-client');
    const origin = { latitude: 4.05, longitude: 9.7 };
    const driverId = await positionedDriver('c4-driver', { latitude: 4.0501, longitude: 9.7001 });
    await startRideSession(redis, rideId, { clientUserId: clientCtx.userId, driverId, origin });

    const { socket, messages } = fakeSocket();
    await manager.subscribe(clientCtx, socket, { rideId });
    assert.equal(messages.length, 1, 'la diffusion immédiate a eu lieu pendant que la course était active');

    // Fin de course : même geste que handleClearEngagement (http/internal.ts), appelé par Odoo
    // au complete/cancel réel -- pas un raccourci de test qui contournerait le mécanisme.
    await endRideSessionForDriver(redis, driverId);

    const countAtEnd = messages.length;
    await new Promise((resolve) => setTimeout(resolve, 160));
    manager.unsubscribe(clientCtx);

    assert.equal(messages.length, countAtEnd, 'aucune diffusion après la fin de la session de course, sans que le client ne fasse rien');
  });

  test('critère 5 -- la fréquence de diffusion est indépendante de la fréquence d\'ingestion', async () => {
    // La configuration porte deux minuteurs distincts (TRACKING_BROADCAST_INTERVAL_SECONDS ici,
    // aucun équivalent d'ingestion consulté par TrackingManager) -- vérifié en configurant un
    // intervalle de diffusion très large : une seule diffusion doit avoir lieu (l'immédiate),
    // quel que soit le rythme auquel storePosition serait par ailleurs appelé côté ingestion.
    const config = configWith({ TRACKING_BROADCAST_INTERVAL_SECONDS: '3600' });
    const manager = new TrackingManager(config, redis);
    const rideId = randomUUID();
    const clientCtx = clientContext('c5-client');
    const origin = { latitude: 4.05, longitude: 9.7 };
    const driverId = await positionedDriver('c5-driver', { latitude: 4.0501, longitude: 9.7001 });
    await startRideSession(redis, rideId, { clientUserId: clientCtx.userId, driverId, origin });

    const { socket, messages } = fakeSocket();
    await manager.subscribe(clientCtx, socket, { rideId });
    await new Promise((resolve) => setTimeout(resolve, 120));
    manager.unsubscribe(clientCtx);

    assert.equal(messages.length, 1, "un seul message (l'immédiat) sur un intervalle de diffusion d'une heure");
  });

  test('un second abonnement du même client remplace le premier (même patron que nearby.drivers, L3-05)', async () => {
    const config = configWith({ TRACKING_BROADCAST_INTERVAL_SECONDS: '0.05' });
    const manager = new TrackingManager(config, redis);
    const clientCtx = clientContext('c6-client');
    const origin = { latitude: 4.05, longitude: 9.7 };

    const rideIdA = randomUUID();
    const driverA = await positionedDriver('c6-driver-a', { latitude: 4.0501, longitude: 9.7001 });
    await startRideSession(redis, rideIdA, { clientUserId: clientCtx.userId, driverId: driverA, origin });

    const rideIdB = randomUUID();
    const driverB = await positionedDriver('c6-driver-b', { latitude: 4.06, longitude: 9.71 });
    await startRideSession(redis, rideIdB, { clientUserId: clientCtx.userId, driverId: driverB, origin });

    const { socket, messages } = fakeSocket();
    await manager.subscribe(clientCtx, socket, { rideId: rideIdA });
    const countAfterFirstImmediate = messages.length;
    await manager.subscribe(clientCtx, socket, { rideId: rideIdB });
    await new Promise((resolve) => setTimeout(resolve, 120));
    manager.unsubscribe(clientCtx);

    // Seule la réponse immédiate du premier abonnement porte rideIdA (nearby.test.ts, même
    // patron) -- tout ce qui suit le second subscribe() doit porter rideIdB, jamais un minuteur
    // orphelin du premier abonnement encore actif.
    for (const message of messages.slice(countAfterFirstImmediate)) {
      assert.equal(message.payload.rideId, rideIdB, 'plus aucun message pour la première course, remplacée par la seconde');
    }
    assert.ok(messages.length > countAfterFirstImmediate, 'le second abonnement a bien produit sa propre diffusion');
  });

  test('etaSeconds décroît avec la distance au point de prise en charge', async () => {
    const config = configWith({ TRACKING_AVERAGE_SPEED_MPS: '10' });
    const manager = new TrackingManager(config, redis);
    const rideId = randomUUID();
    const clientCtx = clientContext('c7-client');
    const origin = { latitude: 4.05, longitude: 9.7 };
    // ~1.57 km au nord de origin (0.01414 deg de latitude) -- assez loin pour un ETA net non nul.
    const driverId = await positionedDriver('c7-driver', { latitude: 4.06414, longitude: 9.7 });
    await startRideSession(redis, rideId, { clientUserId: clientCtx.userId, driverId, origin });

    const { socket, messages } = fakeSocket();
    await manager.subscribe(clientCtx, socket, { rideId });
    manager.unsubscribe(clientCtx);

    assert.equal(messages.length, 1);
    assert.ok(messages[0]!.payload.etaSeconds > 0, 'un chauffeur loin du point de départ a un ETA strictement positif');
  });
});
