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
import { accumulatePosition, accumulationKey } from '../src/tracking/accumulator';

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
      redis.del(`babana:driver:admin-hold:${driverId}`),
      redis.del(accumulationKey(driverId)),
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

describe('POST /internal/* -- authentification (L3-17)', () => {
  test('un appel sans secret partagé est refusé (401), quelle que soit la route', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/internal/reservations/nearest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nearestBody(SOMEWHERE)),
    });
    assert.equal(response.status, 401);
  });

  test('un chemin hors du préfixe /internal/ reste 404 même avec le secret', async () => {
    const response = await post('/api/v1/rides', {});
    assert.equal(response.status, 404);
  });
});

describe('POST /internal/reservations/release (compensation, critère 4)', () => {
  test('libère une proposition en cours et remet le chauffeur dans le pool', async () => {
    const pickup = nearestSpot();
    const driverId = await availableDriverAt(id('release'), pickup);
    const reserved = await post('/internal/reservations/nearest', nearestBody(pickup));
    assert.equal(reserved.body.outcome, 'PROPOSED');
    assert.equal(reserved.body.driverId, driverId);

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

describe('POST /internal/drivers/unavailable|available (suspension/rejet/réactivation, J33)', () => {
  test('unavailable retire du vivier et pose la non-habilitation', async () => {
    const driverId = await availableDriver('hold');
    assert.equal(await isInPool(redis, driverId), true, 'préalable : dans le pool avant la suspension');

    const { status, body } = await post('/internal/drivers/unavailable', { driverId });
    assert.equal(status, 200);
    assert.equal(body.held, true);
    assert.equal(await isInPool(redis, driverId), false, 'retiré du vivier dans la seconde');
    assert.equal(await redis.exists(`babana:driver:admin-hold:${driverId}`), 1);
  });

  test('available lève la non-habilitation SANS réintégrer au vivier (le chauffeur se redéclare)', async () => {
    const driverId = await availableDriver('release-hold');
    await post('/internal/drivers/unavailable', { driverId });
    assert.equal(await isInPool(redis, driverId), false);

    const { status, body } = await post('/internal/drivers/available', { driverId });
    assert.equal(status, 200);
    assert.equal(body.released, true);
    assert.equal(await redis.exists(`babana:driver:admin-hold:${driverId}`), 0);
    // Contrairement à /internal/drivers/cash-unblocked : pas de reintegrateIfEligible ici.
    assert.equal(await isInPool(redis, driverId), false, 'pas de réintégration automatique (D7, J33)');
  });

  test('un chauffeur non habilité, même en ligne et positionné, n\'est jamais réinséré au vivier', async () => {
    const driverId = await availableDriver('hold-reintegrate');
    await post('/internal/drivers/unavailable', { driverId });

    // Position émise avant que la déconnexion (jetons révoqués) ne se propage : le script
    // d'éligibilité doit refuser la réinsertion.
    const inserted = await addEligibleToPool(redis, driverId, SOMEWHERE.latitude, SOMEWHERE.longitude);
    assert.equal(inserted, false);
    assert.equal(await isInPool(redis, driverId), false);
  });
});

describe('POST /internal/rides/started + /internal/rides/measurement (accumulation, L3-10)', () => {
  test('started démarre l\'accumulation ; measurement la renvoie ; clear l\'efface', async () => {
    const driverId = randomUUID();
    usedDriverIds.add(driverId);

    // Avant ride.start : aucune accumulation.
    const before = await post('/internal/rides/measurement', { driverId });
    assert.equal(before.status, 200);
    assert.equal(before.body.measured, false);
    assert.equal(before.body.distanceMeters, null);

    // ride.start (au commit de action_start côté Odoo, D32) démarre l'accumulation.
    const started = await post('/internal/rides/started', {
      rideId: randomUUID(),
      clientUserId: randomUUID(),
      driverId,
    });
    assert.equal(started.status, 200);

    // J25 (amoa/questions/REPONSES-2026-09-02.md §3) : ride.start pose l'accumulation, mais
    // aucune position n'est encore arrivée -- ce n'est pas une mesure de zéro, c'est une absence
    // de mesure. measured doit rester faux tant qu'aucun point n'a été reçu.
    const empty = await post('/internal/rides/measurement', { driverId });
    assert.equal(empty.body.measured, false);
    assert.equal(empty.body.distanceMeters, null);
    assert.equal(empty.body.polyline, null);

    // Quelques positions accumulées (comme le ferait ingest.ts à chaque position acceptée).
    const config = configWith();
    const accumConfig = {
      minSegmentMeters: config.ACCUMULATION_MIN_SEGMENT_METERS,
      simplifyToleranceMeters: config.ACCUMULATION_SIMPLIFY_TOLERANCE_METERS,
      maxTrackPoints: config.ACCUMULATION_MAX_TRACK_POINTS,
      ttlSeconds: config.ACCUMULATION_TTL_SECONDS,
    };
    for (let i = 0; i <= 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await accumulatePosition(redis, driverId, { latitude: 4.05, longitude: 9.7 + i * 0.001 }, accumConfig);
    }

    const measured = await post('/internal/rides/measurement', { driverId });
    assert.equal(measured.body.measured, true);
    assert.ok((measured.body.distanceMeters as number) > 400, `distance accumulée attendue, obtenu ${measured.body.distanceMeters}`);
    assert.ok((measured.body.polyline as string).length > 0);

    // Fin de course (ou annulation) : l'accumulation disparaît.
    const cleared = await post('/internal/engagement/clear', { driverId });
    assert.equal(cleared.status, 200);
    const after = await post('/internal/rides/measurement', { driverId });
    assert.equal(after.body.measured, false);
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

  test('driver.arrived (« Sur place », écrit par Odoo) part au client et au chauffeur avec l’heure et le délai de grâce', async () => {
    const rideId = randomUUID();
    const clientUserId = randomUUID();
    const driverId = randomUUID();
    const strangerUserId = randomUUID();
    const clientWs = await connectWs(tokenFor('client', clientUserId));
    const driverWs = await connectWs(tokenFor('driver', driverId, driverId));
    const strangerWs = await connectWs(tokenFor('client', strangerUserId));
    const arrivedAt = '2026-10-21T19:00:00Z';

    try {
      const [clientMessage, driverMessage, { status }] = await Promise.all([
        waitForMessage(clientWs, 'driver.arrived'),
        waitForMessage(driverWs, 'driver.arrived'),
        post('/internal/rides/arrived', { rideId, clientUserId, driverId, arrivedAt, noShowGraceSeconds: 300 }),
      ]);
      assert.equal(status, 200);
      assert.deepEqual(clientMessage.payload, { rideId, arrivedAt, noShowGraceSeconds: 300 });
      assert.deepEqual(driverMessage.payload, { rideId, arrivedAt, noShowGraceSeconds: 300 });
      await assertNoMessage(strangerWs, 'driver.arrived');
    } finally {
      clientWs.close();
      driverWs.close();
      strangerWs.close();
    }
  });

  test('/internal/rides/arrived refuse un corps incomplet (400)', async () => {
    const { status } = await post('/internal/rides/arrived', { rideId: randomUUID(), clientUserId: 'c', driverId: 'd' });
    assert.equal(status, 400);
  });

  test('ride.completed porte le détail décomposé transmis par Odoo, aux deux destinataires', async () => {
    const rideId = randomUUID();
    const clientUserId = randomUUID();
    const driverId = randomUUID();
    const breakdown = {
      baseFare: 200,
      approachFare: 0,
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
      approachFare: 0,
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

// --- Sélection automatique : Odoo demande « le plus proche », le service choisit et propose. ---

// Un point par test, à ~2 km du suivant et loin du point commun (SOMEWHERE) -- même raison que
// test/reservation-nearest.test.ts.
let nearestSpotIndex = 0;
function nearestSpot(): { latitude: number; longitude: number } {
  nearestSpotIndex += 1;
  return { latitude: 3.94 + nearestSpotIndex * 0.02, longitude: 9.82 };
}

async function availableDriverAt(driverId: string, at: { latitude: number; longitude: number }): Promise<string> {
  usedDriverIds.add(driverId);
  await setOnline(redis, driverId);
  await storePosition(
    redis,
    driverId,
    { ...at, accuracyMeters: 10, speedMetersPerSecond: 0, headingDegrees: 0, capturedAtMs: Date.now() },
    60
  );
  await addEligibleToPool(redis, driverId, at.latitude, at.longitude);
  return driverId;
}

function nearestBody(origin: { latitude: number; longitude: number }, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    idempotencyKey: randomUUID(),
    rideId: randomUUID(),
    clientUserId: id('nearest-client'),
    origin,
    destination: { latitude: 4.06, longitude: 9.72 },
    amount: 1_200,
    distanceMeters: 3_400,
    clientPhoneNumber: '+237691234567',
    pickupNote: null,
    radiusMeters: 500,
    excludeDriverIds: [],
    ...overrides,
  };
}

const metersNorth = (at: { latitude: number; longitude: number }, meters: number) => ({
  latitude: at.latitude + meters / 111_000,
  longitude: at.longitude,
});

describe('POST /internal/reservations/nearest (le serveur choisit le chauffeur le plus proche)', () => {
  test('propose au plus proche : proposal.new lui parvient, la réponse le nomme', async () => {
    const pickup = nearestSpot();
    const closest = await availableDriverAt(randomUUID(), metersNorth(pickup, 40));
    await availableDriverAt(randomUUID(), metersNorth(pickup, 250));
    const driverWs = await connectWs(tokenFor('driver', randomUUID(), closest));

    try {
      const body = nearestBody(pickup, { pickupNote: 'Devant la pharmacie' });
      const [proposal, { status, body: response }] = await Promise.all([
        waitForMessage(driverWs, 'proposal.new'),
        post('/internal/reservations/nearest', body),
      ]);
      assert.equal(status, 200);
      assert.equal(response.outcome, 'PROPOSED');
      assert.equal(response.driverId, closest);
      assert.ok(typeof response.expiresAt === 'string');
      assert.equal((proposal.payload as { rideId: string }).rideId, body.rideId);
      assert.equal((proposal.payload as { pickupNote: string }).pickupNote, 'Devant la pharmacie');
      assert.equal(await isReserved(redis, closest), true);
    } finally {
      driverWs.close();
    }
  });

  test('les chauffeurs déjà sollicités pour la course sont passés', async () => {
    const pickup = nearestSpot();
    const refused = await availableDriverAt(id('nearest-refused'), metersNorth(pickup, 30));
    const next = await availableDriverAt(id('nearest-next'), metersNorth(pickup, 200));

    const { body } = await post('/internal/reservations/nearest', nearestBody(pickup, { excludeDriverIds: [refused] }));

    assert.equal(body.outcome, 'PROPOSED');
    assert.equal(body.driverId, next);
    assert.equal(await isInPool(redis, refused), true);
  });

  test('le classement routier transmis par Odoo passe avant le vol d’oiseau', async () => {
    const pickup = nearestSpot();
    const beeline = await availableDriverAt(id('nearest-beeline'), metersNorth(pickup, 30));
    const road = await availableDriverAt(id('nearest-road'), metersNorth(pickup, 200));

    const { body } = await post('/internal/reservations/nearest', nearestBody(pickup, { preferredDriverIds: [road, beeline] }));

    assert.equal(body.outcome, 'PROPOSED');
    assert.equal(body.driverId, road);
    assert.equal(await isInPool(redis, beeline), true);
  });

  test('POST /internal/drivers/nearby : les plus proches avec leur position, hors écartés, sans rien réserver', async () => {
    const pickup = nearestSpot();
    const first = await availableDriverAt(id('nearby-first'), metersNorth(pickup, 30));
    const excluded = await availableDriverAt(id('nearby-excluded'), metersNorth(pickup, 60));
    const second = await availableDriverAt(id('nearby-second'), metersNorth(pickup, 90));
    await availableDriverAt(id('nearby-third'), metersNorth(pickup, 120));

    const { status, body } = await post('/internal/drivers/nearby', {
      origin: pickup,
      radiusMeters: 500,
      limit: 2,
      excludeDriverIds: [excluded],
    });

    assert.equal(status, 200);
    const drivers = (body as { drivers: Array<{ driverId: string; latitude: number; longitude: number }> }).drivers;
    assert.deepEqual(drivers.map((driver) => driver.driverId), [first, second]);
    assert.ok(Math.abs((drivers[0]?.latitude ?? 0) - metersNorth(pickup, 30).latitude) < 1e-4);
    assert.equal(await isInPool(redis, first), true, 'une lecture ne réserve personne');
  });

  test('personne dans le rayon : NO_DRIVER_AVAILABLE, rien de réservé', async () => {
    const pickup = nearestSpot();
    const far = await availableDriverAt(id('nearest-far'), metersNorth(pickup, 900));

    const { status, body } = await post('/internal/reservations/nearest', nearestBody(pickup, { radiusMeters: 500 }));

    assert.equal(status, 200);
    assert.deepEqual(body, { outcome: 'NO_DRIVER_AVAILABLE' });
    assert.equal(await isInPool(redis, far), true);
  });

  test("rejouer la même clé d'idempotence renvoie le même chauffeur, sans en réserver un second (D25)", async () => {
    const pickup = nearestSpot();
    await availableDriverAt(id('nearest-replay-a'), metersNorth(pickup, 30));
    const second = await availableDriverAt(id('nearest-replay-b'), metersNorth(pickup, 150));
    const body = nearestBody(pickup);

    const first = await post('/internal/reservations/nearest', body);
    const replayed = await post('/internal/reservations/nearest', body);

    assert.equal(first.body.outcome, 'PROPOSED');
    assert.deepEqual(replayed.body, first.body);
    assert.equal(await isInPool(redis, second), true, 'le rejeu ne doit pas réserver le suivant');
  });

  test("« personne » n'est pas mis en cache : la même clé retrouve un chauffeur arrivé entre-temps", async () => {
    // Rien n'a été réservé au premier appel : le recalcul est sans danger, et répondre « personne »
    // pendant toute la durée du cache à un client qui réessaie serait faux.
    const pickup = nearestSpot();
    const body = nearestBody(pickup);

    const first = await post('/internal/reservations/nearest', body);
    assert.equal(first.body.outcome, 'NO_DRIVER_AVAILABLE');

    const arrived = await availableDriverAt(id('nearest-arrived'), metersNorth(pickup, 50));
    const second = await post('/internal/reservations/nearest', body);
    assert.equal(second.body.outcome, 'PROPOSED');
    assert.equal(second.body.driverId, arrived);
  });

  test('un corps sans rayon est refusé (400) : le rayon est un réglage métier, transmis par Odoo', async () => {
    const { radiusMeters: _omitted, ...withoutRadius } = nearestBody(nearestSpot());
    const { status } = await post('/internal/reservations/nearest', withoutRadius);
    assert.equal(status, 400);
  });
});

describe('POST /internal/rides/unmatched (aucun chauffeur après les tentatives automatiques)', () => {
  test('ride.unmatched part au client de la course, jamais à un tiers', async () => {
    const rideId = randomUUID();
    const clientUserId = randomUUID();
    const clientWs = await connectWs(tokenFor('client', clientUserId));
    const strangerWs = await connectWs(tokenFor('client', randomUUID()));

    try {
      const [message, { status }] = await Promise.all([
        waitForMessage(clientWs, 'ride.unmatched'),
        post('/internal/rides/unmatched', { rideId, clientUserId }),
      ]);
      assert.equal(status, 200);
      assert.deepEqual(message.payload, { rideId });
      await assertNoMessage(strangerWs, 'ride.unmatched');
    } finally {
      clientWs.close();
      strangerWs.close();
    }
  });

  test('un corps incomplet est refusé (400)', async () => {
    const { status } = await post('/internal/rides/unmatched', { rideId: randomUUID() });
    assert.equal(status, 400);
  });
});
