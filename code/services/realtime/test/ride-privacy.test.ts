// 14 novembre : « un chauffeur en course n'est visible que du client de cette course ». Contre un
// Redis réel, le vrai chemin : position ingérée, réservation, session de course, puis d'autres
// positions -- aucune ne doit revenir dans nearby.drivers (la carte d'accueil des autres clients),
// et seul le client de la course reçoit driver.position.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { WebSocket } from 'ws';
import type { realtime } from '@babana/contracts';
import { setOnline } from '../src/driver/availability';
import { ingestPosition, plausibilityConfigFrom } from '../src/tracking/ingest';
import { projectNearbyDrivers } from '../src/nearby/projection';
import { reserveDriver } from '../src/reservation/reserve';
import { startRideSession, endRideSessionForDriver } from '../src/tracking/session';
import { TrackingManager } from '../src/tracking/broadcast';
import { removeFromPool } from '../src/redis/geo-index';
import { parseConfig } from '../src/config';
import type { ConnectionContext } from '../src/ws/auth';
import { TEST_REDIS_URL } from './helpers/redis';

const RUN_ID = randomUUID().slice(0, 8);
const config = parseConfig({
  REDIS_URL: TEST_REDIS_URL,
  ODOO_INTERNAL_URL: 'http://odoo:8069',
  REALTIME_SHARED_SECRET: 'shared-secret',
  JWT_SECRET: 'jwt-secret',
  TRACKING_BROADCAST_INTERVAL_SECONDS: '3600',
});
const plausibility = plausibilityConfigFrom(config);
// Un point propre à ce fichier, loin des autres suites qui partagent la base de test.
const SPOT = { latitude: 4.0911, longitude: 9.7311 };

let redis: Redis;
const driverId = `privacy-driver-${RUN_ID}`;

before(() => {
  redis = new Redis(TEST_REDIS_URL);
});

after(async () => {
  await endRideSessionForDriver(redis, driverId);
  await removeFromPool(redis, driverId);
  await redis.del(`babana:driver:position:${driverId}`);
  redis.disconnect();
});

const driverContext: ConnectionContext = Object.freeze({ userId: `privacy-user-${RUN_ID}`, role: 'driver', driverId });

let step = 0;
async function sendPosition(): Promise<void> {
  step += 1;
  const message: realtime.PositionUpdateMessage = {
    type: 'position.update',
    id: randomUUID(),
    emittedAt: new Date().toISOString(),
    payload: {
      latitude: SPOT.latitude + step * 0.000001, // ~0,1 m par pas : sous la vitesse implicite maximale (L3-02)
      longitude: SPOT.longitude,
      accuracyMeters: 10,
      speedMetersPerSecond: 1,
      headingDegrees: 0,
      precedingSamples: [],
    },
  };
  const outcome = await ingestPosition(redis, driverContext, message, plausibility, config.POSITION_TTL_SECONDS);
  assert.ok(outcome.accepted, 'position du chauffeur acceptée');
}

async function visibleOnHomeMaps(): Promise<boolean> {
  const nearby = await projectNearbyDrivers(redis, SPOT, 500, 50);
  return nearby.some((candidate) => candidate.driverId === driverId);
}

function fakeSocket() {
  const messages: Array<{ type: string }> = [];
  const socket = { readyState: 1, OPEN: 1, send: (data: string) => messages.push(JSON.parse(data)) };
  return { socket: socket as unknown as WebSocket, messages };
}

describe('Un chauffeur en course n’est visible que du client de sa course (14 novembre)', () => {
  test('disponible : visible sur la carte des clients ; en course : invisible, même en envoyant ses positions', async () => {
    await setOnline(redis, driverId);
    await sendPosition();
    assert.equal(await visibleOnHomeMaps(), true, 'disponible et positionné : visible');

    const rideId = randomUUID();
    const owner: ConnectionContext = Object.freeze({ userId: `privacy-owner-${RUN_ID}`, role: 'client', driverId: null });
    const stranger: ConnectionContext = Object.freeze({ userId: `privacy-stranger-${RUN_ID}`, role: 'client', driverId: null });
    assert.equal((await reserveDriver(redis, driverId, 30)).reserved, true);
    await startRideSession(redis, rideId, { clientUserId: owner.userId, driverId, origin: SPOT });

    const tracking = new TrackingManager(config, redis);
    const ownerSocket = fakeSocket();
    const strangerSocket = fakeSocket();
    await tracking.subscribe(owner, ownerSocket.socket, { rideId });
    await tracking.subscribe(stranger, strangerSocket.socket, { rideId });

    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- positions successives d'un même chauffeur
      await new Promise((resolve) => setTimeout(resolve, 20));
      // eslint-disable-next-line no-await-in-loop
      await sendPosition();
      // eslint-disable-next-line no-await-in-loop
      await tracking.onDriverPosition(driverId);
      // eslint-disable-next-line no-await-in-loop
      assert.equal(await visibleOnHomeMaps(), false, 'en course : jamais sur la carte des autres clients');
    }
    tracking.unsubscribe(owner);
    tracking.unsubscribe(stranger);

    assert.ok(ownerSocket.messages.filter((m) => m.type === 'driver.position').length >= 3, 'le client de la course suit sa moto');
    assert.equal(strangerSocket.messages.filter((m) => m.type === 'driver.position').length, 0, 'un autre client ne la voit pas');
  });
});
