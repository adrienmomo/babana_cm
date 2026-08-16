// Contre un Redis réel, comme test/reservation.test.ts et test/proposal.test.ts : l'endpoint
// interne (L3-17) compose reserve.lua, pool-eligibility.lua et resolve.lua, tous trois prouvés
// contre Redis réel -- une imitation en mémoire ne prouverait rien de leur composition ici.
//
// Ne teste PAS le rejeu Odoo réellement provoqué (critère 3) : ce module n'a aucune notion
// d'Odoo ni de transaction PostgreSQL rejouable. Cette preuve-là vit dans
// test/concurrency/select-driver-replay.test.ts (racine du monorepo, contre la pile réelle), qui
// exerce CET endpoint depuis un vrai rejeu Odoo. Ici : que le mécanisme d'idempotence lui-même
// -- rejouer la réponse d'une clé déjà vue plutôt que de recalculer -- fonctionne bien, isolé de
// tout ce qui pourrait le déclencher en production.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { createServer } from '../src/server';
import { parseConfig, type Config } from '../src/config';
import { setOnline, setOffline } from '../src/driver/availability';
import { addEligibleToPool } from '../src/redis/pool-eligibility';
import { isInPool, removeFromPool } from '../src/redis/geo-index';
import { isReserved } from '../src/reservation/reserve';
import { isEngaged, setEngaged, clearEngaged } from '../src/driver/engagement';
import { storePosition } from '../src/redis/positions';
import { recordLastSent } from '../src/nearby/last-sent';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const RUN_ID = randomUUID().slice(0, 8);
const id = (label: string) => `${label}-${RUN_ID}`;

const SOMEWHERE = { latitude: 4.05, longitude: 9.7 };
const SECRET = 'internal-test-secret';

const BASE_ENV = {
  REDIS_URL,
  ODOO_INTERNAL_URL: 'http://odoo.invalid.test:1',
  REALTIME_SHARED_SECRET: SECRET,
  JWT_SECRET: 'jwt-secret',
};

function configWith(overrides: Partial<Record<string, string>> = {}): Config {
  return parseConfig({ ...BASE_ENV, ...overrides });
}

let redis: Redis;
let server: ReturnType<typeof createServer>;
let port: number;
const usedDriverIds = new Set<string>();

before(async () => {
  redis = new Redis(REDIS_URL);
  server = createServer(configWith(), redis);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('port de test introuvable');
  port = address.port;
});

after(async () => {
  server.close();
  await Promise.all(
    [...usedDriverIds].flatMap((driverId) => [
      setOffline(redis, driverId),
      clearEngaged(redis, driverId),
      redis.del(`babana:driver:reservation:${driverId}`),
      redis.del(`babana:driver:proposal:rideId:${driverId}`),
      redis.del(`babana:driver:proposal:record:${driverId}`),
      redis.del(`babana:driver:position:${driverId}`),
    ])
  );
  redis.disconnect();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Realtime-Secret': SECRET, ...headers },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, body: json as Record<string, unknown> };
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

function reservationBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    idempotencyKey: randomUUID(),
    rideId: randomUUID(),
    driverId: 'placeholder',
    clientUserId: id('client'),
    origin: SOMEWHERE,
    destination: { latitude: 4.06, longitude: 9.72 },
    amount: 1_200,
    distanceMeters: 3_400,
    ...overrides,
  };
}

describe('POST /internal/* -- authentification (L3-17)', () => {
  test('un appel sans secret partagé est refusé (401), quelle que soit la route', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/internal/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reservationBody()),
    });
    assert.equal(response.status, 401);
  });

  test('un chemin hors du préfixe /internal/ reste 404 même avec le secret', async () => {
    const response = await post('/api/v1/rides', {});
    assert.equal(response.status, 404);
  });
});

describe('POST /internal/reservations (sens Odoo -> temps réel, L3-17)', () => {
  test('réserve et propose un chauffeur disponible et récemment montré au client', async () => {
    const driverId = await availableDriver('reserve-ok');
    const clientUserId = id('reserve-ok-client');
    await recordLastSent(redis, clientUserId, [driverId], 30);

    const { status, body } = await post('/internal/reservations', reservationBody({ driverId, clientUserId }));

    assert.equal(status, 200);
    assert.equal(body.outcome, 'PROPOSED');
    assert.ok(typeof body.expiresAt === 'string');
    assert.equal(await isInPool(redis, driverId), false);
    assert.equal(await isReserved(redis, driverId), true);
  });

  test('critère 8 -- un chauffeur absent de la dernière liste des 5 ne peut pas être sélectionné', async () => {
    const driverId = await availableDriver('reserve-not-shown');
    const clientUserId = id('reserve-not-shown-client');
    // Délibérément aucun recordLastSent pour ce client -- le chauffeur n'a jamais été montré.

    const { status, body } = await post('/internal/reservations', reservationBody({ driverId, clientUserId }));

    assert.equal(status, 200);
    assert.equal(body.outcome, 'DRIVER_NOT_IN_LAST_LIST');
    assert.equal(await isInPool(redis, driverId), true, 'aucune réservation ne doit avoir été tentée');
  });

  test('un chauffeur déjà réservé renvoie DRIVER_ALREADY_TAKEN, sans doublon d\'écriture', async () => {
    const driverId = await availableDriver('reserve-taken');
    const clientA = id('reserve-taken-client-a');
    const clientB = id('reserve-taken-client-b');
    await recordLastSent(redis, clientA, [driverId], 30);
    await recordLastSent(redis, clientB, [driverId], 30);

    const first = await post('/internal/reservations', reservationBody({ driverId, clientUserId: clientA }));
    assert.equal(first.body.outcome, 'PROPOSED');

    const second = await post('/internal/reservations', reservationBody({ driverId, clientUserId: clientB }));
    assert.equal(second.body.outcome, 'DRIVER_ALREADY_TAKEN');
  });

  test(
    "critère 3 -- rejouer le MÊME identifiant d'idempotence renvoie le résultat déjà obtenu, sans réserver une seconde fois",
    async () => {
      const driverId = await availableDriver('reserve-idempotent');
      const clientUserId = id('reserve-idempotent-client');
      await recordLastSent(redis, clientUserId, [driverId], 30);

      const body = reservationBody({ driverId, clientUserId });

      const first = await post('/internal/reservations', body);
      assert.equal(first.body.outcome, 'PROPOSED');

      // Même clé d'idempotence, même corps -- simule le rejeu de la requête HTTP entière par
      // Odoo (D25) : si l'endpoint recalculait, il retenterait reserve.lua sur un chauffeur déjà
      // retiré du pool par le premier appel, et renverrait DRIVER_ALREADY_TAKEN à une requête qui
      // avait pourtant déjà réussi -- exactement le piège décrit par la spécification.
      const replayed = await post('/internal/reservations', body);
      assert.equal(replayed.status, 200);
      assert.deepEqual(replayed.body, first.body, 'la réponse rejouée doit être identique à la première, pas recalculée');
    }
  );
});

describe('POST /internal/reservations/release (compensation, critère 4)', () => {
  test('libère une proposition en cours et remet le chauffeur dans le pool', async () => {
    const driverId = await availableDriver('release');
    const clientUserId = id('release-client');
    await recordLastSent(redis, clientUserId, [driverId], 30);
    const reserved = await post('/internal/reservations', reservationBody({ driverId, clientUserId }));
    assert.equal(reserved.body.outcome, 'PROPOSED');

    const { status, body } = await post('/internal/reservations/release', { driverId });
    assert.equal(status, 200);
    assert.equal(body.released, true);
    assert.equal(await isReserved(redis, driverId), false);
    assert.equal(await isInPool(redis, driverId), true);
  });

  test('est idempotent : relâcher un chauffeur déjà libre ne fait rien de plus', async () => {
    const driverId = await availableDriver('release-noop');
    const { status, body } = await post('/internal/reservations/release', { driverId });
    assert.equal(status, 200);
    assert.equal(body.released, true);
    assert.equal(await isInPool(redis, driverId), true);
  });
});

describe('POST /internal/engagement/clear (fin de course, critère 6)', () => {
  test('efface le marqueur d\'engagement et réintègre le chauffeur dans le pool', async () => {
    const driverId = await availableDriver('clear-engagement');
    await removeFromPool(redis, driverId); // simule le retrait par l'engagement (D26)
    await setEngaged(redis, driverId);

    const { status, body } = await post('/internal/engagement/clear', { driverId });
    assert.equal(status, 200);
    assert.equal(body.cleared, true);
    assert.equal(await isEngaged(redis, driverId), false);
    assert.equal(await isInPool(redis, driverId), true, 'redevient disponible immédiatement, sans attendre la position suivante');
  });
});
