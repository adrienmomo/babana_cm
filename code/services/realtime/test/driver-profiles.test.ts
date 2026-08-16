// Cache des profils chauffeur (L3-16), contre un Redis réel et un faux serveur Odoo local (une
// route unique, /api/internal/drivers/profiles) -- même pattern que reconcile.test.ts : ce
// module ne connaît d'Odoo que cette seule réponse JSON (invariant 1, aucun client PostgreSQL).
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import {
  getDriverProfiles,
  setDriverProfile,
  removeDriverProfile,
  type DriverProfile,
} from '../src/redis/driver-profiles';
import { parseConfig, type Config } from '../src/config';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const RUN_ID = randomUUID().slice(0, 8);
const id = (label: string) => `${label}-${RUN_ID}`;

const PROFILE: DriverProfile = {
  firstName: 'Paul',
  photoUrl: 'https://storage.babana.cm/mock/drivers/paul.jpg',
  rating: 4.8,
  motorcycleClass: 'standard',
};

let redis: Redis;
let odooServer: http.Server;
let odooRequestCount = 0;
let odooRequestedIds: string[][] = [];
let odooProfiles: Record<string, DriverProfile> = {};
let odooShouldFail = false;
let config: Config;
const usedIds = new Set<string>();

before(async () => {
  redis = new Redis(REDIS_URL);
  odooServer = http.createServer((req, res) => {
    if (req.url === '/api/internal/drivers/profiles' && req.method === 'POST') {
      if (odooShouldFail) {
        res.writeHead(500);
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        odooRequestCount += 1;
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { driverIds: string[] };
        odooRequestedIds.push(body.driverIds);
        const profiles: Record<string, DriverProfile> = {};
        for (const driverId of body.driverIds) {
          if (odooProfiles[driverId]) profiles[driverId] = odooProfiles[driverId]!;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ profiles }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => odooServer.listen(0, resolve));
  const address = odooServer.address();
  if (address === null || typeof address === 'string') throw new Error('port de test introuvable');
  config = parseConfig({
    REDIS_URL,
    ODOO_INTERNAL_URL: `http://127.0.0.1:${address.port}`,
    REALTIME_SHARED_SECRET: 'secret',
    JWT_SECRET: 'secret',
    DRIVER_PROFILE_CACHE_TTL_SECONDS: '0.2',
  });
});

beforeEach(() => {
  odooRequestCount = 0;
  odooRequestedIds = [];
  odooProfiles = {};
  odooShouldFail = false;
});

after(async () => {
  odooServer.close();
  await Promise.all([...usedIds].map((driverId) => removeDriverProfile(redis, driverId)));
  redis.disconnect();
});

describe('getDriverProfiles (L3-16)', () => {
  test('critère 3 -- un seul appel Odoo pour tout un lot de chauffeurs jamais lus', async () => {
    const driverIds = [id('batch-1'), id('batch-2'), id('batch-3')];
    driverIds.forEach((d) => usedIds.add(d));
    driverIds.forEach((d) => (odooProfiles[d] = PROFILE));

    const result = await getDriverProfiles(config, redis, driverIds);

    assert.equal(odooRequestCount, 1, 'un seul appel Odoo pour tout le lot, jamais un par chauffeur');
    assert.deepEqual(odooRequestedIds[0]!.sort(), [...driverIds].sort());
    for (const driverId of driverIds) {
      assert.deepEqual(result.get(driverId), PROFILE);
    }
  });

  test('un chauffeur jamais lu et inconnu d\'Odoo est absent de la map -- jamais inventé (D30)', async () => {
    const driverId = id('unknown');
    usedIds.add(driverId);
    // odooProfiles reste vide : Odoo ne connaît pas ce chauffeur.

    const result = await getDriverProfiles(config, redis, [driverId]);

    assert.equal(result.has(driverId), false);
  });

  test('critère 2 -- Odoo injoignable : un profil déjà lu continue d\'être servi', async () => {
    const driverId = id('stale-served');
    usedIds.add(driverId);
    await setDriverProfile(redis, driverId, PROFILE);
    await new Promise((resolve) => setTimeout(resolve, 250)); // dépasse le TTL de test (0.2 s)
    odooShouldFail = true;

    const result = await getDriverProfiles(config, redis, [driverId]);

    assert.deepEqual(result.get(driverId), PROFILE, 'la dernière valeur connue reste servie malgré la panne Odoo');
  });

  test('une entrée fraîche (moins vieille que le TTL) ne déclenche aucun appel Odoo', async () => {
    const driverId = id('fresh');
    usedIds.add(driverId);
    await setDriverProfile(redis, driverId, PROFILE);

    const result = await getDriverProfiles(config, redis, [driverId]);

    assert.equal(odooRequestCount, 0, 'une entrée fraîche ne doit déclencher aucun appel');
    assert.deepEqual(result.get(driverId), PROFILE);
  });

  test('une entrée périmée est rafraîchie et reflète la nouvelle valeur Odoo', async () => {
    const driverId = id('refresh');
    usedIds.add(driverId);
    await setDriverProfile(redis, driverId, PROFILE);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const updated: DriverProfile = { ...PROFILE, rating: 3.2 };
    odooProfiles[driverId] = updated;

    const result = await getDriverProfiles(config, redis, [driverId]);

    assert.equal(odooRequestCount, 1);
    assert.deepEqual(result.get(driverId), updated);
  });
});
