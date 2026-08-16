// Contre un Redis réel (le balayage SCAN des marqueurs d'engagement n'a aucun sens en mémoire) et
// un faux serveur Odoo local (une route unique, /api/internal/drivers/engaged) -- suffisant pour
// prouver l'alignement, sans dépendre d'Odoo réellement démarré : ce module ne connaît d'Odoo que
// cette seule réponse JSON (invariant 3, il ne décide de rien, il reflète).
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { reconcileEngagement } from '../src/driver/reconcile';
import { parseConfig, type Config } from '../src/config';
import { setOnline, setOffline } from '../src/driver/availability';
import { addEligibleToPool } from '../src/redis/pool-eligibility';
import { isInPool, removeFromPool } from '../src/redis/geo-index';
import { isEngaged, setEngaged, clearEngaged } from '../src/driver/engagement';
import { storePosition } from '../src/redis/positions';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const RUN_ID = randomUUID().slice(0, 8);
const id = (label: string) => `${label}-${RUN_ID}`;

const SOMEWHERE = { latitude: 4.05, longitude: 9.7 };

let redis: Redis;
let odooServer: http.Server;
let odooResponse: string[] = [];
let config: Config;
const usedIds = new Set<string>();

before(async () => {
  redis = new Redis(REDIS_URL);
  odooServer = http.createServer((req, res) => {
    if (req.url === '/api/internal/drivers/engaged') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ driverIds: odooResponse }));
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
  });
});

beforeEach(() => {
  odooResponse = [];
});

after(async () => {
  odooServer.close();
  await Promise.all(
    [...usedIds].flatMap((driverId) => [
      setOffline(redis, driverId),
      clearEngaged(redis, driverId),
      redis.del(`babana:driver:position:${driverId}`),
    ])
  );
  redis.disconnect();
});

async function onlineDriver(label: string): Promise<string> {
  const driverId = id(label);
  usedIds.add(driverId);
  await setOnline(redis, driverId);
  await storePosition(
    redis,
    driverId,
    { ...SOMEWHERE, accuracyMeters: 10, speedMetersPerSecond: 0, headingDegrees: 0, capturedAtMs: Date.now() },
    60
  );
  return driverId;
}

describe('reconcileEngagement (L3-17, critère 7)', () => {
  test("un marqueur d'engagement orphelin (absent côté Odoo) est effacé, et le chauffeur redevient disponible", async () => {
    const driverId = await onlineDriver('orphan');
    await removeFromPool(redis, driverId);
    await setEngaged(redis, driverId);
    odooResponse = []; // Odoo ne connaît aucune course active pour ce chauffeur

    const result = await reconcileEngagement(config, redis);

    assert.ok(result.orphansCleared.includes(driverId));
    assert.equal(await isEngaged(redis, driverId), false);
    assert.equal(await isInPool(redis, driverId), true, 'redevient disponible, sa position étant connue');
  });

  test('un marqueur manquant (course active côté Odoo, rien côté Redis) est posé, et le pool retiré', async () => {
    const driverId = await onlineDriver('missing');
    await addEligibleToPool(redis, driverId, SOMEWHERE.latitude, SOMEWHERE.longitude);
    odooResponse = [driverId]; // Odoo affirme ce chauffeur engagé sur une course active

    const result = await reconcileEngagement(config, redis);

    assert.ok(result.markersSet.includes(driverId));
    assert.equal(await isEngaged(redis, driverId), true);
    assert.equal(await isInPool(redis, driverId), false, "un chauffeur qu'Odoo dit engagé ne doit jamais rester dans le pool");
  });

  test("un chauffeur correctement engagé des deux côtés n'est ni touché ni compté comme un écart", async () => {
    const driverId = await onlineDriver('consistent');
    await removeFromPool(redis, driverId);
    await setEngaged(redis, driverId);
    odooResponse = [driverId];

    const result = await reconcileEngagement(config, redis);

    assert.equal(result.orphansCleared.includes(driverId), false);
    assert.equal(result.markersSet.includes(driverId), false);
    assert.equal(await isEngaged(redis, driverId), true);
  });
});
