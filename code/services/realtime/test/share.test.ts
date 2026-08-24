// Partage de trajet (L8-03). Contre un Redis réel (la session/position de suivi vivent là,
// comme test/broadcast.test.ts) et un faux serveur Odoo local qui ne répond qu'à
// /api/internal/share/resolve -- même patron que test/driver-profiles.test.ts : ce module ne
// connaît d'Odoo que cette seule réponse JSON (invariant 1).
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { createServer } from '../src/server';
import { startRideSession, endRideSessionForDriver } from '../src/tracking/session';
import { storePosition } from '../src/redis/positions';
import { parseConfig, type Config } from '../src/config';
import type { ResolvedShare } from '../src/odoo/share';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const RUN_ID = randomUUID().slice(0, 8);
const id = (label: string) => `${label}-${RUN_ID}`;

let redis: Redis;
let odooServer: http.Server;
let odooUrl: string;
let odooResponses: Record<string, ResolvedShare> = {};
let odooRequestCount = 0;
let server: ReturnType<typeof createServer>;
let port: number;
let config: Config;
const usedDriverIds = new Set<string>();

before(async () => {
  redis = new Redis(REDIS_URL);

  odooServer = http.createServer((req, res) => {
    if (req.url === '/api/internal/share/resolve' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        odooRequestCount += 1;
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { token: string };
        const response = odooResponses[body.token] ?? { active: false };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => odooServer.listen(0, resolve));
  const odooAddress = odooServer.address();
  if (odooAddress === null || typeof odooAddress === 'string') throw new Error('port Odoo de test introuvable');
  odooUrl = `http://127.0.0.1:${odooAddress.port}`;

  config = parseConfig({
    REDIS_URL,
    ODOO_INTERNAL_URL: odooUrl,
    REALTIME_SHARED_SECRET: 'shared-secret',
    JWT_SECRET: 'jwt-secret',
    SHARE_RATE_LIMIT_MAX_REQUESTS: '3',
    SHARE_RATE_LIMIT_WINDOW_SECONDS: '60',
    TRACKING_AVERAGE_SPEED_MPS: '10',
  });
  server = createServer(config, redis);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('port de test introuvable');
  port = address.port;
});

beforeEach(() => {
  odooResponses = {};
  odooRequestCount = 0;
});

after(async () => {
  server.close();
  odooServer.close();
  await Promise.all(
    [...usedDriverIds].map((driverId) => Promise.all([endRideSessionForDriver(redis, driverId), redis.del(`babana:driver:position:${driverId}`)]))
  );
  redis.disconnect();
});

async function get(path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function seedActiveSession(driverId: string, rideId: string, origin: { latitude: number; longitude: number }) {
  usedDriverIds.add(driverId);
  await startRideSession(redis, rideId, { clientUserId: id('client'), driverId, origin });
}

describe('GET /s/{token} -- la page publique', () => {
  test('un jeton inconnu répond une page « ce lien n\'est plus valide »', async () => {
    const response = await get(`/s/${id('unknown-token')}`);
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'] ?? '', /text\/html/);
    assert.match(response.body, /Ce trajet est terminé|Chargement/);
  });

  test('une page active se sert en text/html', async () => {
    const token = id('token-html');
    odooResponses[token] = { active: true, rideId: id('ride'), phase: 'approach', destination: { latitude: 4.06, longitude: 9.76 } };
    const response = await get(`/s/${token}`);
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'] ?? '', /text\/html/);
  });
});

describe('GET /s/{token}/status -- critère 2, liste blanche', () => {
  test('jeton inconnu : {active:false}, jamais autre chose', async () => {
    const response = await get(`/s/${id('unknown')}/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { active: false });
  });

  test('pendant l\'approche : la cible est l\'origine (point de rendez-vous), ETA calculée', async () => {
    const driverId = id('driver-approach');
    const rideId = id('ride-approach');
    const token = id('token-approach');
    const origin = { latitude: 4.05, longitude: 9.7 };
    await seedActiveSession(driverId, rideId, origin);
    await storePosition(redis, driverId, {
      latitude: 4.0505,
      longitude: 9.7,
      accuracyMeters: 5,
      speedMetersPerSecond: null,
      headingDegrees: null,
      capturedAtMs: Date.now(),
    }, 60);
    odooResponses[token] = {
      active: true,
      rideId,
      phase: 'approach',
      destination: { latitude: 4.08, longitude: 9.79 },
      driverFirstName: 'Amina',
      motorcycleClass: 'premium',
    };

    const response = await get(`/s/${token}/status`);
    const body = JSON.parse(response.body);

    assert.equal(body.active, true);
    assert.equal(body.phase, 'approach');
    assert.equal(body.driverFirstName, 'Amina');
    assert.equal(body.motorcycleClass, 'premium');
    assert.deepEqual(body.target, origin);
    assert.ok(body.position);
    assert.ok(typeof body.etaSeconds === 'number' && body.etaSeconds > 0);
  });

  test('pendant la course : la cible est la destination, aucune ETA', async () => {
    const driverId = id('driver-course');
    const rideId = id('ride-course');
    const token = id('token-course');
    const origin = { latitude: 4.05, longitude: 9.7 };
    const destination = { latitude: 4.08, longitude: 9.79 };
    await seedActiveSession(driverId, rideId, origin);
    await storePosition(redis, driverId, {
      latitude: 4.06,
      longitude: 9.72,
      accuracyMeters: 5,
      speedMetersPerSecond: null,
      headingDegrees: null,
      capturedAtMs: Date.now(),
    }, 60);
    odooResponses[token] = { active: true, rideId, phase: 'course', destination };

    const response = await get(`/s/${token}/status`);
    const body = JSON.parse(response.body);

    assert.equal(body.phase, 'course');
    assert.deepEqual(body.target, destination);
    assert.equal(body.etaSeconds, null);
  });

  test('aucune position fraîche : position null, jamais une position inventée', async () => {
    const driverId = id('driver-no-position');
    const rideId = id('ride-no-position');
    const token = id('token-no-position');
    await seedActiveSession(driverId, rideId, { latitude: 4.05, longitude: 9.7 });
    odooResponses[token] = { active: true, rideId, phase: 'approach', destination: { latitude: 4.08, longitude: 9.79 } };

    const response = await get(`/s/${token}/status`);
    const body = JSON.parse(response.body);

    assert.equal(body.position, null);
    assert.equal(body.etaSeconds, null);
  });

  test('jamais de nom du client, de montant, ni d\'immatriculation dans la réponse', async () => {
    const driverId = id('driver-whitelist');
    const rideId = id('ride-whitelist');
    const token = id('token-whitelist');
    await seedActiveSession(driverId, rideId, { latitude: 4.05, longitude: 9.7 });
    odooResponses[token] = {
      active: true,
      rideId,
      phase: 'approach',
      destination: { latitude: 4.08, longitude: 9.79 },
      driverFirstName: 'Amina',
    };

    const response = await get(`/s/${token}/status`);

    assert.equal(Object.keys(JSON.parse(response.body)).includes('clientName'), false);
    assert.doesNotMatch(response.body, /amount|licensePlate|clientName/);
  });
});

describe('critère 6 -- limitation de débit par jeton', () => {
  test('un jeton dépassant le seuil configuré reçoit 429 avec Retry-After', async () => {
    const token = id('token-rate-limit');
    odooResponses[token] = { active: false };

    await get(`/s/${token}/status`);
    await get(`/s/${token}/status`);
    await get(`/s/${token}/status`);
    const fourth = await get(`/s/${token}/status`);

    assert.equal(fourth.status, 429);
    assert.ok(fourth.headers['retry-after']);
  });

  test('un autre jeton n\'est pas affecté par la limite du premier', async () => {
    const exhausted = id('token-rate-limit-exhausted');
    const fresh = id('token-rate-limit-fresh');
    odooResponses[exhausted] = { active: false };
    odooResponses[fresh] = { active: false };

    await get(`/s/${exhausted}/status`);
    await get(`/s/${exhausted}/status`);
    await get(`/s/${exhausted}/status`);
    await get(`/s/${exhausted}/status`); // 429

    const response = await get(`/s/${fresh}/status`);
    assert.equal(response.status, 200);
  });
});

describe('routage', () => {
  test('un segment supplémentaire inconnu répond 404', async () => {
    const response = await get(`/s/${id('token')}/something-else`);
    assert.equal(response.status, 404);
  });
});
