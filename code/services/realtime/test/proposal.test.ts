// Contre un Redis réel, comme test/reservation.test.ts : propose()/accept()/reject() s'appuient
// sur reserveDriver (L3-06) et sur le script d'éligibilité du pool (L3-06R), tous deux prouvés
// contre Redis réel -- une imitation en mémoire ne prouverait rien de leur composition ici.
//
// Identifiants suffixés par un identifiant de run unique, même raison que reservation.test.ts.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { WebSocket } from 'ws';
import { ProposalLifecycle, type ProposalDetails } from '../src/proposal/lifecycle';
import { ConnectionRegistry, type ConnectionContext } from '../src/ws/auth';
import { isInPool, removeFromPool } from '../src/redis/geo-index';
import { isReserved } from '../src/reservation/reserve';
import { isEngaged, clearEngaged } from '../src/driver/engagement';
import { setOnline, setOffline } from '../src/driver/availability';
import { storePosition } from '../src/redis/positions';
import { addEligibleToPool } from '../src/redis/pool-eligibility';
import { parseConfig, type Config } from '../src/config';
import { setDriverProfile, type DriverProfile } from '../src/redis/driver-profiles';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const RUN_ID = randomUUID().slice(0, 8);
const id = (label: string) => `${label}-${RUN_ID}`;

const SOMEWHERE = { latitude: 4.05, longitude: 9.7 };

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
  await Promise.all(
    [...usedDriverIds].flatMap((driverId) => [
      removeFromPool(redis, driverId),
      setOffline(redis, driverId),
      clearEngaged(redis, driverId), // efface aussi l'état de course unifié (L3-18, ride/state.ts)
      redis.del(`babana:driver:proposal:rideId:${driverId}`),
      redis.del(`babana:driver:proposal:record:${driverId}`),
      redis.del(`babana:driver:position:${driverId}`),
    ])
  );
  redis.disconnect();
});

function configWith(overrides: Partial<Record<string, string>> = {}): Config {
  return parseConfig({ ...BASE_ENV, ...overrides });
}

async function availableDriver(label: string): Promise<string> {
  const driverId = id(label);
  usedDriverIds.add(driverId);
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

function driverContext(driverId: string): ConnectionContext {
  return Object.freeze({ userId: `user-${driverId}`, role: 'driver', driverId });
}

function clientContext(userId: string): ConnectionContext {
  return Object.freeze({ userId, role: 'client', driverId: null });
}

/** Faux WebSocket : ProposalLifecycle ne lit que `readyState`/`OPEN` et écrit via `send`, aucune
 * connexion réseau réelle nécessaire -- même choix que test/nearby.test.ts. */
function fakeSocket() {
  const messages: { type: string; payload: Record<string, unknown> }[] = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => messages.push(JSON.parse(data)),
  };
  return { socket: socket as unknown as WebSocket, messages };
}

function proposalDetails(rideId: string, clientUserId: string): ProposalDetails {
  return {
    rideId,
    clientUserId,
    origin: { latitude: 4.05, longitude: 9.7 },
    destination: { latitude: 4.06, longitude: 9.72 },
    amount: 1_200,
    distanceMeters: 3_400,
  };
}

describe('ProposalLifecycle (L3-07)', () => {
  test('critère 1 -- une acceptation dans le délai pose l\'engagement et notifie le client (ride.assigned)', async () => {
    const config = configWith();
    const registry = new ConnectionRegistry();
    const lifecycle = new ProposalLifecycle(config, redis, registry);

    const driverId = await availableDriver('accept-driver');
    const clientUserId = id('accept-client');
    const rideId = randomUUID();

    // D41 (amoa/questions/REPONSES-2026-08-25.md §2) : ride.assigned porte désormais de quoi
    // reconnaître la moto -- seedé directement dans le cache (setDriverProfile), même patron que
    // nearby.test.ts, pour ne pas dépendre d'un Odoo réellement joignable dans ce test unitaire.
    const profile: DriverProfile = {
      firstName: 'Paul',
      photoUrl: 'https://storage.babana.cm/mock/drivers/paul.jpg',
      rating: 4.8,
      motorcycleClass: 'standard',
      licensePlate: 'LT-1234-BC',
    };
    await setDriverProfile(redis, driverId, profile);

    const driverSocket = fakeSocket();
    const clientSocket = fakeSocket();
    registry.add(driverContext(driverId), driverSocket.socket);
    registry.add(clientContext(clientUserId), clientSocket.socket);

    const outcome = await lifecycle.propose(driverId, proposalDetails(rideId, clientUserId));
    assert.equal(outcome.proposed, true);
    assert.equal(driverSocket.messages.length, 1);
    assert.equal(driverSocket.messages[0]!.type, 'proposal.new');
    assert.equal((driverSocket.messages[0]!.payload as { rideId: string }).rideId, rideId);

    const accepted = await lifecycle.accept(driverId, rideId);
    assert.equal(accepted, true);

    assert.equal(await isReserved(redis, driverId), false, 'la réservation doit avoir été remplacée');
    assert.equal(await isEngaged(redis, driverId), true, 'critère 1 -- engagement posé à l\'acceptation');
    assert.equal(await isInPool(redis, driverId), false, 'un chauffeur engagé ne doit jamais réapparaître dans le pool');

    assert.equal(clientSocket.messages.length, 1);
    assert.equal(clientSocket.messages[0]!.type, 'ride.assigned');
    assert.deepEqual(clientSocket.messages[0]!.payload, {
      rideId,
      driverId,
      firstName: profile.firstName,
      photoUrl: profile.photoUrl,
      motorcycleClass: profile.motorcycleClass,
      licensePlate: profile.licensePlate,
    });
  });

  test('critère 1 bis -- un profil pas encore synchronisé dégrade en null, ne bloque pas ride.assigned (D30/D41)', async () => {
    const config = configWith();
    const registry = new ConnectionRegistry();
    const lifecycle = new ProposalLifecycle(config, redis, registry);

    const driverId = await availableDriver('accept-driver-no-profile');
    const clientUserId = id('accept-client-no-profile');
    const rideId = randomUUID();

    const driverSocket = fakeSocket();
    const clientSocket = fakeSocket();
    registry.add(driverContext(driverId), driverSocket.socket);
    registry.add(clientContext(clientUserId), clientSocket.socket);

    await lifecycle.propose(driverId, proposalDetails(rideId, clientUserId));
    const accepted = await lifecycle.accept(driverId, rideId);
    assert.equal(accepted, true);

    assert.equal(clientSocket.messages.length, 1);
    assert.deepEqual(clientSocket.messages[0]!.payload, {
      rideId,
      driverId,
      firstName: null,
      photoUrl: null,
      motorcycleClass: null,
      licensePlate: null,
    });
  });

  test('critère 2 -- le refus explicite libère le chauffeur et notifie le client (ride.rejected), sans proposal.expired', async () => {
    const config = configWith();
    const registry = new ConnectionRegistry();
    const lifecycle = new ProposalLifecycle(config, redis, registry);

    const driverId = await availableDriver('reject-driver');
    const clientUserId = id('reject-client');
    const rideId = randomUUID();

    const driverSocket = fakeSocket();
    const clientSocket = fakeSocket();
    registry.add(driverContext(driverId), driverSocket.socket);
    registry.add(clientContext(clientUserId), clientSocket.socket);

    await lifecycle.propose(driverId, proposalDetails(rideId, clientUserId));
    const rejected = await lifecycle.reject(driverId, rideId);
    assert.equal(rejected, true);

    assert.equal(await isReserved(redis, driverId), false);
    assert.equal(await isEngaged(redis, driverId), false, 'un refus ne pose jamais l\'engagement');
    assert.equal(await isInPool(redis, driverId), true, 'le chauffeur, toujours en ligne, doit réintégrer le pool');

    const clientMessageTypes = clientSocket.messages.map((m) => m.type);
    assert.deepEqual(clientMessageTypes, ['ride.rejected']);
    // L6-08 a besoin de savoir QUEL chauffeur a refusé (pour l'écarter de la liste actualisée)
    // et POURQUOI (refus explicite vs expiration -- ce ne sont pas la même chose pour le client,
    // spécification L6-08) : les deux champs manquaient à la charge utile avant cette nuit.
    assert.deepEqual(clientSocket.messages[0]!.payload, { rideId, driverId, reason: 'driver_rejected' });

    const driverMessageTypes = driverSocket.messages.map((m) => m.type);
    assert.deepEqual(driverMessageTypes, ['proposal.new'], 'aucun proposal.expired sur un refus explicite -- motif distinct de l\'expiration');
  });

  test('critère 3 -- l\'expiration libère le chauffeur et notifie client (ride.rejected) et chauffeur (proposal.expired)', async () => {
    const config = configWith({ PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS: '1', RESERVATION_TTL_SECONDS: '30' });
    const registry = new ConnectionRegistry();
    const lifecycle = new ProposalLifecycle(config, redis, registry);

    const driverId = await availableDriver('expire-driver');
    const clientUserId = id('expire-client');
    const rideId = randomUUID();

    const driverSocket = fakeSocket();
    const clientSocket = fakeSocket();
    registry.add(driverContext(driverId), driverSocket.socket);
    registry.add(clientContext(clientUserId), clientSocket.socket);

    await lifecycle.propose(driverId, proposalDetails(rideId, clientUserId));

    // Délai configuré à 1 s ci-dessus : laisser largement le temps au minuteur de se déclencher.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    assert.equal(await isReserved(redis, driverId), false);
    assert.equal(await isEngaged(redis, driverId), false);
    assert.equal(await isInPool(redis, driverId), true, 'le chauffeur doit être réintégré au pool, sans appel explicite');

    const clientMessageTypes = clientSocket.messages.map((m) => m.type);
    assert.deepEqual(clientMessageTypes, ['ride.rejected']);
    assert.deepEqual(clientSocket.messages[0]!.payload, { rideId, driverId, reason: 'driver_timeout' });

    const driverMessageTypes = driverSocket.messages.map((m) => m.type);
    assert.deepEqual(driverMessageTypes, ['proposal.new', 'proposal.expired']);
  });

  test("critère 4 -- une acceptation arrivant après l'expiration échoue proprement, sans engagement ni message supplémentaire", async () => {
    const config = configWith({ PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS: '1', RESERVATION_TTL_SECONDS: '30' });
    const registry = new ConnectionRegistry();
    const lifecycle = new ProposalLifecycle(config, redis, registry);

    const driverId = await availableDriver('late-accept-driver');
    const clientUserId = id('late-accept-client');
    const rideId = randomUUID();

    const driverSocket = fakeSocket();
    const clientSocket = fakeSocket();
    registry.add(driverContext(driverId), driverSocket.socket);
    registry.add(clientContext(clientUserId), clientSocket.socket);

    await lifecycle.propose(driverId, proposalDetails(rideId, clientUserId));
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const messagesBeforeLateAccept = clientSocket.messages.length;
    const accepted = await lifecycle.accept(driverId, rideId);

    assert.equal(accepted, false, 'une acceptation tardive ne doit jamais réussir');
    assert.equal(await isEngaged(redis, driverId), false, 'ne doit jamais poser l\'engagement après expiration');
    assert.equal(
      clientSocket.messages.length,
      messagesBeforeLateAccept,
      'aucun message supplémentaire (pas de second ride.assigned après le ride.rejected de l\'expiration)'
    );
  });

  test('critère 5 -- une double acceptation ne produit qu\'une transition', async () => {
    const config = configWith();
    const registry = new ConnectionRegistry();
    const lifecycle = new ProposalLifecycle(config, redis, registry);

    const driverId = await availableDriver('double-accept-driver');
    const clientUserId = id('double-accept-client');
    const rideId = randomUUID();

    const driverSocket = fakeSocket();
    const clientSocket = fakeSocket();
    registry.add(driverContext(driverId), driverSocket.socket);
    registry.add(clientContext(clientUserId), clientSocket.socket);

    await lifecycle.propose(driverId, proposalDetails(rideId, clientUserId));

    const [first, second] = await Promise.all([
      lifecycle.accept(driverId, rideId),
      lifecycle.accept(driverId, rideId),
    ]);

    assert.equal([first, second].filter(Boolean).length, 1, 'exactement une des deux acceptations doit réussir');
    assert.equal(
      clientSocket.messages.filter((m) => m.type === 'ride.assigned').length,
      1,
      'une seule transition, un seul message ride.assigned'
    );
  });

  test('critère 6 -- le délai est lu depuis la configuration, pas codé en dur', async () => {
    const shortConfig = configWith({ PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS: '1', RESERVATION_TTL_SECONDS: '30' });
    const longConfig = configWith({ PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS: '20', RESERVATION_TTL_SECONDS: '30' });
    const registry = new ConnectionRegistry();

    const shortLived = new ProposalLifecycle(shortConfig, redis, registry);
    const driverShort = await availableDriver('config-short-driver');
    await shortLived.propose(driverShort, proposalDetails(randomUUID(), id('config-short-client')));

    const longLived = new ProposalLifecycle(longConfig, redis, registry);
    const driverLong = await availableDriver('config-long-driver');
    await longLived.propose(driverLong, proposalDetails(randomUUID(), id('config-long-client')));

    await new Promise((resolve) => setTimeout(resolve, 1_500));

    assert.equal(await isReserved(redis, driverShort), false, 'expiré : le délai court doit avoir déclenché la libération');
    assert.equal(await isReserved(redis, driverLong), true, 'pas expiré : le délai long ne doit pas encore avoir déclenché');
  });

  test('échoue proprement (aucune réservation) si le chauffeur n\'est pas disponible', async () => {
    const config = configWith();
    const registry = new ConnectionRegistry();
    const lifecycle = new ProposalLifecycle(config, redis, registry);

    const driverId = id('never-online-driver');
    usedDriverIds.add(driverId);

    const outcome = await lifecycle.propose(driverId, proposalDetails(randomUUID(), id('no-driver-client')));
    assert.deepEqual(outcome, { proposed: false });
  });
});
