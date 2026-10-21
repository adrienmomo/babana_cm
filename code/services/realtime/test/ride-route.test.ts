// Contre un Redis réel (patron de broadcast.test.ts) : le tracé du chauffeur est relayé au client
// de la course, rejoué à un abonné tardif, et « Sur place » prévient le client -- sans jamais
// toucher Odoo (invariant 1) ni se fier à un rideId forgé (L3-01).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { WebSocket } from 'ws';
import { RideRouteRelay, recordDriverArrived } from '../src/tracking/route';
import { TrackingManager } from '../src/tracking/broadcast';
import { startRideSession } from '../src/tracking/session';
import { ConnectionRegistry, type ConnectionContext } from '../src/ws/auth';
import { parseConfig, type Config } from '../src/config';
import { release } from '../src/ride/state';

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
let config: Config;
const usedDrivers = new Set<string>();
const usedRides = new Set<string>();

before(() => {
  redis = new Redis(REDIS_URL);
  config = parseConfig(BASE_ENV);
});

after(async () => {
  await Promise.all([...usedDrivers].map((d) => release(redis, d)));
  await Promise.all([...usedRides].flatMap((r) => [redis.del(`babana:ride:route:${r}`), redis.del(`babana:ride:arrived:${r}`)]));
  redis.disconnect();
});

type Sent = { type: string; payload: Record<string, unknown> };
function fakeSocket() {
  const messages: Sent[] = [];
  const socket = { readyState: 1, OPEN: 1, send: (data: string) => messages.push(JSON.parse(data)) };
  return { socket: socket as unknown as WebSocket, messages };
}

const ORIGIN = { latitude: 4.05, longitude: 9.76 };
const POINTS = [ORIGIN, { latitude: 4.06, longitude: 9.77 }, { latitude: 4.07, longitude: 9.78 }];
const routePayload = (rideId: string, phase: 'approach' | 'transit' = 'approach') => ({
  rideId,
  phase,
  points: POINTS,
  distanceMeters: 2300,
  durationSeconds: 400,
});

/** Une course engagée : le chauffeur et le client sont connectés, la session existe côté Redis. */
async function engagedRide(label: string) {
  const rideId = randomUUID();
  const driverId = id(`${label}-driver`);
  const clientUserId = id(`${label}-client`);
  usedDrivers.add(driverId);
  usedRides.add(rideId);
  await startRideSession(redis, rideId, { clientUserId, driverId, origin: ORIGIN });

  const registry = new ConnectionRegistry();
  const driverContext: ConnectionContext = Object.freeze({ userId: id(`${label}-driver-user`), role: 'driver', driverId });
  const clientContext: ConnectionContext = Object.freeze({ userId: clientUserId, role: 'client', driverId: null });
  const driver = fakeSocket();
  const client = fakeSocket();
  registry.add(driverContext, driver.socket);
  registry.add(clientContext, client.socket);
  const relay = new RideRouteRelay(config, redis, registry);
  return { rideId, driverId, clientUserId, registry, relay, driverContext, clientContext, driver, client };
}

describe('route.share -- le tracé du chauffeur arrive au client, à l’identique', () => {
  test('relayé en ride.route au client de la course, jamais renvoyé au chauffeur', async () => {
    const ride = await engagedRide('relay');
    await ride.relay.share(ride.driverContext, routePayload(ride.rideId));

    assert.equal(ride.client.messages.length, 1);
    const message = ride.client.messages[0]!;
    assert.equal(message.type, 'ride.route');
    assert.deepEqual(message.payload, routePayload(ride.rideId));
    assert.equal(ride.driver.messages.length, 0);
  });

  test('un chauffeur qui n’est pas celui de la course est ignoré (rideId forgé)', async () => {
    const ride = await engagedRide('forged');
    const other: ConnectionContext = Object.freeze({ userId: id('forged-other-user'), role: 'driver', driverId: id('forged-other') });
    await ride.relay.share(other, routePayload(ride.rideId));
    assert.equal(ride.client.messages.length, 0);
    assert.equal(await redis.get(`babana:ride:route:${ride.rideId}`), null);
  });

  test('un client qui forge route.share est ignoré', async () => {
    const ride = await engagedRide('client-forge');
    await ride.relay.share(ride.clientContext, routePayload(ride.rideId));
    assert.equal(ride.client.messages.length, 0);
  });

  test('une course inconnue (aucune session) est ignorée', async () => {
    const ride = await engagedRide('unknown');
    await ride.relay.share(ride.driverContext, routePayload(randomUUID()));
    assert.equal(ride.client.messages.length, 0);
  });
});

describe('rejeu à l’abonnement ride.track', () => {
  test('un client qui s’abonne après le tracé le reçoit, avec le dernier tracé seulement', async () => {
    const ride = await engagedRide('replay');
    await ride.relay.share(ride.driverContext, routePayload(ride.rideId, 'approach'));
    await ride.relay.share(ride.driverContext, routePayload(ride.rideId, 'transit'));

    const late = fakeSocket();
    const tracking = new TrackingManager(config, redis, ride.relay);
    await tracking.subscribe(ride.clientContext, late.socket, { rideId: ride.rideId });
    tracking.unsubscribe(ride.clientContext);

    const routes = late.messages.filter((m) => m.type === 'ride.route');
    assert.equal(routes.length, 1);
    assert.equal(routes[0]!.payload.phase, 'transit');
  });

  test('sans tracé, l’abonnement ne rejoue rien', async () => {
    const ride = await engagedRide('no-replay');
    const late = fakeSocket();
    const tracking = new TrackingManager(config, redis, ride.relay);
    await tracking.subscribe(ride.clientContext, late.socket, { rideId: ride.rideId });
    tracking.unsubscribe(ride.clientContext);
    assert.equal(late.messages.filter((m) => m.type === 'ride.route').length, 0);
  });
});

describe('« Sur place » rejoué à un abonné tardif', () => {
  test('un client qui s’abonne après l’arrivée reçoit driver.arrived avec l’heure et le délai d’Odoo', async () => {
    const ride = await engagedRide('arrived');
    await recordDriverArrived(redis, config, ride.registry, {
      rideId: ride.rideId,
      clientUserId: ride.clientUserId,
      driverId: ride.driverId,
      arrivedAt: '2026-10-21T19:00:00Z',
      noShowGraceSeconds: 300,
    });

    const late = fakeSocket();
    const tracking = new TrackingManager(config, redis, ride.relay);
    await tracking.subscribe(ride.clientContext, late.socket, { rideId: ride.rideId });
    tracking.unsubscribe(ride.clientContext);
    const arrived = late.messages.filter((m) => m.type === 'driver.arrived');
    assert.equal(arrived.length, 1);
    assert.deepEqual(arrived[0]!.payload, { rideId: ride.rideId, arrivedAt: '2026-10-21T19:00:00Z', noShowGraceSeconds: 300 });
  });
});

describe('chat.send -- messages rapides entre les deux participants', () => {
  test('du chauffeur au client, avec son émetteur', async () => {
    const ride = await engagedRide('chat-d2c');
    await ride.relay.chat(ride.driverContext, { rideId: ride.rideId, code: 'driver_outside' });
    assert.deepEqual(ride.client.messages.map((m) => [m.type, m.payload.code, m.payload.from]), [['chat.message', 'driver_outside', 'driver']]);
    assert.equal(ride.driver.messages.length, 0);
  });

  test('du client au chauffeur', async () => {
    const ride = await engagedRide('chat-c2d');
    await ride.relay.chat(ride.clientContext, { rideId: ride.rideId, code: 'client_coming' });
    assert.deepEqual(ride.driver.messages.map((m) => [m.type, m.payload.code, m.payload.from]), [['chat.message', 'client_coming', 'client']]);
    assert.equal(ride.client.messages.length, 0);
  });

  test('un code de l’autre rôle est refusé (un client ne parle pas « au nom » du chauffeur)', async () => {
    const ride = await engagedRide('chat-role');
    await ride.relay.chat(ride.clientContext, { rideId: ride.rideId, code: 'driver_outside' });
    await ride.relay.chat(ride.driverContext, { rideId: ride.rideId, code: 'client_coming' });
    assert.equal(ride.driver.messages.length, 0);
    assert.equal(ride.client.messages.length, 0);
  });

  test('un tiers (ni le chauffeur ni le client de la course) est ignoré', async () => {
    const ride = await engagedRide('chat-third');
    const stranger: ConnectionContext = Object.freeze({ userId: id('chat-stranger'), role: 'client', driverId: null });
    await ride.relay.chat(stranger, { rideId: ride.rideId, code: 'client_coming' });
    const otherDriver: ConnectionContext = Object.freeze({ userId: id('chat-od-user'), role: 'driver', driverId: id('chat-od') });
    await ride.relay.chat(otherDriver, { rideId: ride.rideId, code: 'driver_outside' });
    assert.equal(ride.driver.messages.length, 0);
    assert.equal(ride.client.messages.length, 0);
  });
});
