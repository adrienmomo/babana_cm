import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import type Redis from 'ioredis';
import { pingRedis } from '../src/redis/client';
import { pingOdoo } from '../src/odoo/client';
import type { Config } from '../src/config';

const config: Config = {
  NODE_ENV: 'test',
  PORT: 3000,
  REDIS_URL: 'redis://unused:6379',
  ODOO_INTERNAL_URL: 'http://odoo.test',
  REALTIME_SHARED_SECRET: 'secret',
  JWT_SECRET: 'secret',
  OPERATIONAL_BOUNDS_MIN_LAT: 3.95,
  OPERATIONAL_BOUNDS_MAX_LAT: 4.15,
  OPERATIONAL_BOUNDS_MIN_LNG: 9.6,
  OPERATIONAL_BOUNDS_MAX_LNG: 9.85,
  POSITION_TTL_SECONDS: 60,
  POSITION_MAX_ACCURACY_METERS: 150,
  POSITION_MAX_TIMESTAMP_FUTURE_MS: 5_000,
  POSITION_MAX_TIMESTAMP_AGE_MS: 30_000,
  POSITION_MAX_IMPLIED_SPEED_MPS: 38.9,
  NEARBY_MAX_RADIUS_METERS: 5_000,
  AVAILABILITY_DISCONNECT_GRACE_SECONDS: 45,
};

describe('critère 1 — /health reflète l\'état de chaque dépendance', () => {
  test('pingRedis renvoie true quand PING répond PONG', async () => {
    const fakeRedis = { ping: async () => 'PONG' } as unknown as Redis;
    assert.equal(await pingRedis(fakeRedis), true);
  });

  test('pingRedis renvoie false si la commande échoue', async () => {
    const fakeRedis = {
      ping: async () => {
        throw new Error('connexion refusée');
      },
    } as unknown as Redis;
    assert.equal(await pingRedis(fakeRedis), false);
  });

  describe('pingOdoo', () => {
    const originalFetch = global.fetch;
    after(() => {
      global.fetch = originalFetch;
    });

    test('renvoie true quand Odoo répond 200', async () => {
      global.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
      assert.equal(await pingOdoo(config), true);
    });

    test('renvoie false quand Odoo répond une erreur', async () => {
      global.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
      assert.equal(await pingOdoo(config), false);
    });

    test('renvoie false si la requête échoue', async () => {
      global.fetch = (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch;
      assert.equal(await pingOdoo(config), false);
    });
  });
});
