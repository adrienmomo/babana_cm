// Plafond d'encaisse (D8, D28, L5-02), contre un Redis réel -- comme pool-single-writer.test.ts,
// une imitation en mémoire ne prouverait rien de la composition avec le script d'éligibilité.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { WebSocket } from 'ws';
import { blockForCash, unblockForCash, isCashBlocked } from '../src/driver/cash-guard';
import { addEligibleToPool } from '../src/redis/pool-eligibility';
import { isInPool, removeFromPool } from '../src/redis/geo-index';
import { setOnline, setOffline } from '../src/driver/availability';
import { storePosition } from '../src/redis/positions';
import { createMessageDispatcher } from '../src/ws/dispatch';
import { NearbyManager } from '../src/nearby/handler';
import { ProposalLifecycle, type ProposalDetails } from '../src/proposal/lifecycle';
import { TrackingManager } from '../src/tracking/broadcast';
import { ConnectionRegistry, type ConnectionContext } from '../src/ws/auth';
import { isReserved } from '../src/reservation/reserve';
import { isEngaged, clearEngaged } from '../src/driver/engagement';
import { parseConfig, type Config } from '../src/config';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const RUN_ID = randomUUID().slice(0, 8);
const id = (label: string) => `${label}-${RUN_ID}`;
const SOMEWHERE = { latitude: 4.05, longitude: 9.7 };

const BASE_ENV = {
  REDIS_URL,
  ODOO_INTERNAL_URL: 'http://odoo.invalid.test:1',
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
      unblockForCash(redis, driverId),
      setOffline(redis, driverId),
      removeFromPool(redis, driverId),
      clearEngaged(redis, driverId), // efface aussi l'état de course unifié (L3-18, ride/state.ts)
      redis.del(`babana:driver:position:${driverId}`),
      redis.del(`babana:driver:proposal:rideId:${driverId}`),
      redis.del(`babana:driver:proposal:record:${driverId}`),
    ])
  );
  redis.disconnect();
});

function configWith(overrides: Partial<Record<string, string>> = {}): Config {
  return parseConfig({ ...BASE_ENV, ...overrides });
}

describe('cash-guard (L5-02)', () => {
  test('blockForCash pose le marqueur et retire immédiatement du pool', async () => {
    const driverId = id('block');
    usedDriverIds.add(driverId);
    await setOnline(redis, driverId);
    await storePosition(
      redis,
      driverId,
      { ...SOMEWHERE, accuracyMeters: 10, speedMetersPerSecond: 0, headingDegrees: 0, capturedAtMs: Date.now() },
      60
    );
    await addEligibleToPool(redis, driverId, SOMEWHERE.latitude, SOMEWHERE.longitude);
    assert.equal(await isInPool(redis, driverId), true, 'préalable : bien dans le pool avant le blocage');

    await blockForCash(redis, driverId);

    assert.equal(await isCashBlocked(redis, driverId), true);
    assert.equal(await isInPool(redis, driverId), false, "critère 1 : retiré du pool immédiatement");
  });

  test('unblockForCash efface le marqueur', async () => {
    const driverId = id('unblock');
    usedDriverIds.add(driverId);
    await blockForCash(redis, driverId);

    await unblockForCash(redis, driverId);

    assert.equal(await isCashBlocked(redis, driverId), false);
  });

  // --- Critère 1 (intégration avec le script d'éligibilité) --------------------------------

  test("un chauffeur bloqué, même en ligne et positionné, n'est jamais réintégré au pool", async () => {
    const driverId = id('reintegrate');
    usedDriverIds.add(driverId);
    await setOnline(redis, driverId);
    await storePosition(
      redis,
      driverId,
      { ...SOMEWHERE, accuracyMeters: 10, speedMetersPerSecond: 0, headingDegrees: 0, capturedAtMs: Date.now() },
      60
    );
    await blockForCash(redis, driverId);

    // Un chauffeur bloqué continue d'émettre sa position (comme un vrai chauffeur en attente de
    // remise) : chaque position acceptée retente l'éligibilité (tracking/ingest.ts), simulé ici
    // directement par un second appel au script.
    const inserted = await addEligibleToPool(redis, driverId, SOMEWHERE.latitude, SOMEWHERE.longitude);

    assert.equal(inserted, false);
    assert.equal(await isInPool(redis, driverId), false);
  });

  // --- Critère 2 (point de blocage à l'acceptation) -----------------------------------------

  test("proposal.accept d'un chauffeur bloqué est traité comme un refus, jamais une acceptation", async () => {
    const driverId = id('accept-blocked');
    const clientUserId = id('accept-blocked-client');
    const rideId = randomUUID();
    usedDriverIds.add(driverId);
    await setOnline(redis, driverId);
    await storePosition(
      redis,
      driverId,
      { ...SOMEWHERE, accuracyMeters: 10, speedMetersPerSecond: 0, headingDegrees: 0, capturedAtMs: Date.now() },
      60
    );
    await addEligibleToPool(redis, driverId, SOMEWHERE.latitude, SOMEWHERE.longitude);

    const config = configWith();
    const registry = new ConnectionRegistry();
    const nearby = new NearbyManager(config, redis);
    const proposals = new ProposalLifecycle(config, redis, registry);
    const tracking = new TrackingManager(config, redis);
    const dispatch = createMessageDispatcher(config, redis, nearby, proposals, tracking);

    const driverContext: ConnectionContext = Object.freeze({ userId: id('driver-user'), role: 'driver', driverId });
    const clientContext: ConnectionContext = Object.freeze({ userId: clientUserId, role: 'client', driverId: null });
    const driverMessages: { type: string }[] = [];
    const clientMessages: { type: string }[] = [];
    const driverSocket = {
      readyState: 1,
      OPEN: 1,
      send: (data: string) => driverMessages.push(JSON.parse(data)),
    } as unknown as WebSocket;
    const clientSocket = {
      readyState: 1,
      OPEN: 1,
      send: (data: string) => clientMessages.push(JSON.parse(data)),
    } as unknown as WebSocket;
    registry.add(driverContext, driverSocket);
    registry.add(clientContext, clientSocket);

    // Une vraie proposition active (L3-07), pas un simulacre -- pour observer un vrai refus, il
    // faut d'abord une vraie acceptation possible.
    const proposeOutcome = await proposals.propose(driverId, {
      rideId,
      clientUserId,
      origin: SOMEWHERE,
      destination: { latitude: 4.06, longitude: 9.72 },
      amount: 1_200,
      distanceMeters: 3_400,
    } satisfies ProposalDetails);
    assert.equal(proposeOutcome.proposed, true);

    // Le plafond est franchi APRÈS la proposition -- exactement le cas que le critère 2 couvre
    // ("une proposition émise juste avant le franchissement resterait acceptable" sans ce point).
    await blockForCash(redis, driverId);

    await dispatch(
      driverContext,
      driverSocket,
      JSON.stringify({
        type: 'proposal.accept',
        id: randomUUID(),
        emittedAt: new Date().toISOString(),
        payload: { rideId },
      })
    );

    assert.equal(await isEngaged(redis, driverId), false, "un chauffeur bloqué ne doit jamais devenir engagé");
    assert.equal(await isReserved(redis, driverId), false, 'la réservation est relâchée, comme un vrai refus');
    assert.equal(clientMessages.length, 1);
    assert.equal(clientMessages[0]!.type, 'ride.rejected', 'le client doit voir un refus, jamais ride.assigned');
    assert.equal(driverMessages.length, 1, 'seul proposal.new (envoyé par propose() ci-dessus) -- reject() ne notifie pas le chauffeur');
  });
});
