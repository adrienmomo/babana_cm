// Non-habilitation du dossier chauffeur (D5, D31, D55, J33) -- suspension ou rejet côté Odoo.
// Contre un Redis réel, comme cash-guard.test.ts dont ce fichier est le jumeau : une imitation en
// mémoire ne prouverait rien de la composition avec le script d'éligibilité ni avec la résolution
// d'acceptation.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { WebSocket } from 'ws';
import { holdDriver, releaseHold, isOnAdminHold } from '../src/driver/admin-hold';
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
      releaseHold(redis, driverId),
      setOffline(redis, driverId),
      removeFromPool(redis, driverId),
      clearEngaged(redis, driverId),
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

async function positioned(driverId: string): Promise<void> {
  await setOnline(redis, driverId);
  await storePosition(
    redis,
    driverId,
    { ...SOMEWHERE, accuracyMeters: 10, speedMetersPerSecond: 0, headingDegrees: 0, capturedAtMs: Date.now() },
    60
  );
}

describe('admin-hold (suspension / rejet, J33)', () => {
  test('holdDriver pose le marqueur et retire immédiatement du vivier', async () => {
    const driverId = id('hold');
    usedDriverIds.add(driverId);
    await positioned(driverId);
    await addEligibleToPool(redis, driverId, SOMEWHERE.latitude, SOMEWHERE.longitude);
    assert.equal(await isInPool(redis, driverId), true, 'préalable : dans le vivier avant la suspension');

    await holdDriver(redis, driverId);

    assert.equal(await isOnAdminHold(redis, driverId), true);
    assert.equal(await isInPool(redis, driverId), false, 'retiré du vivier dans la seconde');
  });

  test('releaseHold efface le marqueur, sans réintégrer au vivier', async () => {
    const driverId = id('release');
    usedDriverIds.add(driverId);
    await positioned(driverId);
    await holdDriver(redis, driverId);

    await releaseHold(redis, driverId);

    assert.equal(await isOnAdminHold(redis, driverId), false);
    // La réactivation ne remet pas dans le vivier : le chauffeur se redéclare en ligne (D7).
    assert.equal(await isInPool(redis, driverId), false);
  });

  test("un chauffeur non habilité, même en ligne et positionné, n'est jamais réintégré au vivier", async () => {
    const driverId = id('reintegrate');
    usedDriverIds.add(driverId);
    await positioned(driverId);
    await holdDriver(redis, driverId);

    // Une dernière position émise avant que la révocation des jetons ne coupe la connexion :
    // chaque position acceptée retente l'éligibilité (tracking/ingest.ts), simulé ici par un
    // appel direct au script.
    const inserted = await addEligibleToPool(redis, driverId, SOMEWHERE.latitude, SOMEWHERE.longitude);

    assert.equal(inserted, false);
    assert.equal(await isInPool(redis, driverId), false);
  });

  test("proposal.accept d'un chauffeur non habilité est traité comme un refus, jamais une acceptation", async () => {
    const driverId = id('accept-held');
    const clientUserId = id('accept-held-client');
    const rideId = randomUUID();
    usedDriverIds.add(driverId);
    await positioned(driverId);
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

    const proposeOutcome = await proposals.propose(driverId, {
      rideId,
      clientUserId,
      origin: SOMEWHERE,
      destination: { latitude: 4.06, longitude: 9.72 },
      amount: 1_200,
      distanceMeters: 3_400,
      clientPhoneNumber: '+237691234567',
    } satisfies ProposalDetails);
    assert.equal(proposeOutcome.proposed, true);

    // La suspension tombe APRÈS l'émission de la proposition -- le cas que le second point de
    // blocage couvre ("une proposition émise juste avant resterait acceptable" sans lui).
    await holdDriver(redis, driverId);

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

    assert.equal(await isEngaged(redis, driverId), false, 'un chauffeur non habilité ne devient jamais engagé');
    assert.equal(await isReserved(redis, driverId), false, 'la réservation est relâchée, comme un vrai refus');
    assert.equal(clientMessages.length, 1);
    assert.equal(clientMessages[0]!.type, 'ride.rejected', 'le client doit voir un refus, jamais ride.assigned');
  });
});
