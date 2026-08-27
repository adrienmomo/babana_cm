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
import { randomUUID, createHmac } from 'node:crypto';
import Redis from 'ioredis';
import { WebSocket } from 'ws';
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
      clearEngaged(redis, driverId), // efface aussi l'état de course unifié (L3-18, ride/state.ts)
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

// --- Signature de jetons applicatifs de test (L3-19) -- même construction que ws.test.ts, non
// partagée entre fichiers de test (chacun de ce service pose la sienne, patron déjà établi). ---
function sign(claims: Record<string, unknown>, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

// AccessTokenClaimsSchema (@babana/contracts, D23) exige sub/driverId au format UUID, et
// driverId ABSENT (pas null) hors du rôle chauffeur -- les identifiants "lisibles" (`id(...)`)
// utilisés ailleurs dans ce fichier pour driverId/clientUserId ne conviennent donc pas ici : ce
// sont toujours de vrais UUID (`randomUUID()`) qui signent la connexion ET voyagent dans le
// corps de la requête interne, pour que registry.getByUserId/getByDriverId les retrouvent.
function tokenFor(role: 'client' | 'driver', userId: string, driverId?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    sub: userId,
    role,
    iat: now,
    exp: now + 3600,
    jti: randomUUID(),
  };
  if (role === 'driver') claims.driverId = driverId;
  return sign(claims, BASE_ENV.JWT_SECRET);
}

async function connectWs(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rt/ws?token=${token}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('close', (code) => reject(new Error(`connexion fermée avant ouverture (code ${code})`)));
  });
  return ws;
}

function waitForMessage(ws: WebSocket, type: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
  // Filtre par type, jamais la trame suivante quelle qu'elle soit (C-02, discipline de lecture)
  // -- rien d'autre n'est diffusé sur ce socket ici, mais la règle reste la même partout.
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`"${type}" jamais reçu avant ${timeoutMs}ms`));
    }, timeoutMs);
    function onMessage(data: Buffer) {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === type) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(message);
      }
    }
    ws.on('message', onMessage);
  });
}

function assertNoMessage(ws: WebSocket, type: string, timeoutMs = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      resolve();
    }, timeoutMs);
    function onMessage(data: Buffer) {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === type) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        reject(new Error(`message "${type}" inattendu reçu par un tiers`));
      }
    }
    ws.on('message', onMessage);
  });
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
    await setEngaged(redis, driverId, randomUUID());

    const { status, body } = await post('/internal/engagement/clear', { driverId });
    assert.equal(status, 200);
    assert.equal(body.cleared, true);
    assert.equal(await isEngaged(redis, driverId), false);
    assert.equal(await isInPool(redis, driverId), true, 'redevient disponible immédiatement, sans attendre la position suivante');
  });
});

describe('POST /internal/rides/started|completed (sens Odoo -> temps réel, L3-19)', () => {
  test('un corps invalide est rejeté (400)', async () => {
    const { status } = await post('/internal/rides/started', { rideId: 'x' });
    assert.equal(status, 400);
  });

  test('ride.started est poussé au client suivi ET au chauffeur, jamais à un tiers', async () => {
    const rideId = randomUUID();
    const clientUserId = randomUUID();
    const driverId = randomUUID();
    const strangerUserId = randomUUID();

    const clientWs = await connectWs(tokenFor('client', clientUserId));
    const driverWs = await connectWs(tokenFor('driver', driverId, driverId));
    const strangerWs = await connectWs(tokenFor('client', strangerUserId));

    try {
      const [clientMessage, driverMessage, { status }] = await Promise.all([
        waitForMessage(clientWs, 'ride.started'),
        waitForMessage(driverWs, 'ride.started'),
        post('/internal/rides/started', { rideId, clientUserId, driverId }),
      ]);
      assert.equal(status, 200);
      assert.equal((clientMessage.payload as { rideId: string }).rideId, rideId);
      assert.equal((driverMessage.payload as { rideId: string }).rideId, rideId);
      await assertNoMessage(strangerWs, 'ride.started');
    } finally {
      clientWs.close();
      driverWs.close();
      strangerWs.close();
    }
  });

  test('ride.completed porte le détail décomposé transmis par Odoo, aux deux destinataires', async () => {
    const rideId = randomUUID();
    const clientUserId = randomUUID();
    const driverId = randomUUID();
    const breakdown = {
      baseFare: 200,
      distanceFare: 1000,
      surgeAmount: 0,
      discountAmount: 0,
      floorAmount: 0,
      roundingAmount: 0,
      minimumFareApplied: false,
    };

    const clientWs = await connectWs(tokenFor('client', clientUserId));
    const driverWs = await connectWs(tokenFor('driver', driverId, driverId));

    try {
      const [clientMessage, driverMessage] = await Promise.all([
        waitForMessage(clientWs, 'ride.completed'),
        waitForMessage(driverWs, 'ride.completed'),
        post('/internal/rides/completed', {
          rideId,
          clientUserId,
          driverId,
          measured: true,
          distanceMeters: 4200,
          durationSeconds: 720,
          amount: 1200,
          breakdown,
        }),
      ]);
      for (const message of [clientMessage, driverMessage]) {
        const payload = message.payload as Record<string, unknown>;
        assert.equal(payload.rideId, rideId);
        assert.equal(payload.measured, true);
        assert.equal(payload.distanceMeters, 4200);
        assert.equal(payload.durationSeconds, 720);
        assert.equal(payload.amount, 1200);
        assert.deepEqual(payload.breakdown, breakdown);
      }
    } finally {
      clientWs.close();
      driverWs.close();
    }
  });

  // J24 (amoa/questions/L6-13.md) : course terminée sans accumulation temps réel -- `ride.completed`
  // porte `distanceMeters` / `durationSeconds` à `null` et `measured: false`, jamais un chiffre
  // plausible et faux (D30, D43).
  test('ride.completed non mesurée : distance et durée à null, measured faux', async () => {
    const rideId = randomUUID();
    const clientUserId = randomUUID();
    const driverId = randomUUID();
    const breakdown = {
      baseFare: 200,
      distanceFare: 1000,
      surgeAmount: 0,
      discountAmount: 0,
      floorAmount: 0,
      roundingAmount: 0,
      minimumFareApplied: false,
    };

    const clientWs = await connectWs(tokenFor('client', clientUserId));
    try {
      const [clientMessage] = await Promise.all([
        waitForMessage(clientWs, 'ride.completed'),
        post('/internal/rides/completed', {
          rideId,
          clientUserId,
          driverId,
          measured: false,
          distanceMeters: null,
          durationSeconds: null,
          amount: 1200,
          breakdown,
        }),
      ]);
      const payload = clientMessage.payload as Record<string, unknown>;
      assert.equal(payload.measured, false);
      assert.equal(payload.distanceMeters, null);
      assert.equal(payload.durationSeconds, null);
      assert.equal(payload.amount, 1200);
    } finally {
      clientWs.close();
    }
  });
});

describe('POST /internal/rides/cancelled (sens Odoo -> temps réel, L4-12)', () => {
  test('un corps invalide est rejeté (400)', async () => {
    const { status } = await post('/internal/rides/cancelled', { rideId: 'x' });
    assert.equal(status, 400);
  });

  test("un client qui annule prévient le chauffeur, jamais lui-même", async () => {
    const rideId = randomUUID();
    const clientUserId = randomUUID();
    const driverId = randomUUID();

    const clientWs = await connectWs(tokenFor('client', clientUserId));
    const driverWs = await connectWs(tokenFor('driver', driverId, driverId));

    try {
      const [driverMessage, { status }] = await Promise.all([
        waitForMessage(driverWs, 'ride.cancelled'),
        post('/internal/rides/cancelled', {
          rideId,
          cancelledBy: 'client',
          reason: 'changement de plan',
          notifyDriverId: driverId,
        }),
      ]);
      assert.equal(status, 200);
      const payload = driverMessage.payload as Record<string, unknown>;
      assert.equal(payload.rideId, rideId);
      assert.equal(payload.cancelledBy, 'client');
      assert.equal(payload.reason, 'changement de plan');
      await assertNoMessage(clientWs, 'ride.cancelled');
    } finally {
      clientWs.close();
      driverWs.close();
    }
  });

  test('un chauffeur qui annule prévient le client, jamais lui-même', async () => {
    const rideId = randomUUID();
    const clientUserId = randomUUID();
    const driverId = randomUUID();

    const clientWs = await connectWs(tokenFor('client', clientUserId));
    const driverWs = await connectWs(tokenFor('driver', driverId, driverId));

    try {
      const [clientMessage, { status }] = await Promise.all([
        waitForMessage(clientWs, 'ride.cancelled'),
        post('/internal/rides/cancelled', {
          rideId,
          cancelledBy: 'driver',
          reason: 'panne moto',
          notifyClientUserId: clientUserId,
        }),
      ]);
      assert.equal(status, 200);
      const payload = clientMessage.payload as Record<string, unknown>;
      assert.equal(payload.rideId, rideId);
      assert.equal(payload.cancelledBy, 'driver');
      assert.equal(payload.reason, 'panne moto');
      await assertNoMessage(driverWs, 'ride.cancelled');
    } finally {
      clientWs.close();
      driverWs.close();
    }
  });

  test('un superviseur qui annule prévient les deux', async () => {
    const rideId = randomUUID();
    const clientUserId = randomUUID();
    const driverId = randomUUID();

    const clientWs = await connectWs(tokenFor('client', clientUserId));
    const driverWs = await connectWs(tokenFor('driver', driverId, driverId));

    try {
      const [clientMessage, driverMessage, { status }] = await Promise.all([
        waitForMessage(clientWs, 'ride.cancelled'),
        waitForMessage(driverWs, 'ride.cancelled'),
        post('/internal/rides/cancelled', {
          rideId,
          cancelledBy: 'supervisor',
          notifyClientUserId: clientUserId,
          notifyDriverId: driverId,
        }),
      ]);
      assert.equal(status, 200);
      assert.equal((clientMessage.payload as { cancelledBy: string }).cancelledBy, 'supervisor');
      assert.equal((driverMessage.payload as { cancelledBy: string }).cancelledBy, 'supervisor');
    } finally {
      clientWs.close();
      driverWs.close();
    }
  });
});
