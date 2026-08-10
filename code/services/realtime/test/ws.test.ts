import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import type Redis from 'ioredis';
import { createServer } from '../src/server';
import { WS_CLOSE_UNAUTHENTICATED } from '../src/ws/connection';
import type { Config } from '../src/config';

const config: Config = {
  NODE_ENV: 'test',
  PORT: 0,
  REDIS_URL: 'redis://unused:6379',
  ODOO_INTERNAL_URL: 'http://odoo.test',
  REALTIME_SHARED_SECRET: 'secret',
  JWT_SECRET: 'test-jwt-secret',
};

function sign(claims: Record<string, unknown>, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

const fakeRedis = { ping: async () => 'PONG' } as unknown as Redis;

let port: number;
let server: ReturnType<typeof createServer>;

describe('critère 2 — une connexion WebSocket sans jeton valide est refusée', () => {
  before(async () => {
    server = createServer(config, fakeRedis);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('port de test introuvable');
    port = address.port;
  });

  after(() => {
    server.close();
  });

  test('sans jeton du tout : fermeture avec le code documenté', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rt/ws`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
    });
    assert.equal(closeCode, WS_CLOSE_UNAUTHENTICATED);
  });

  test('avec un jeton invalide : fermeture avec le code documenté', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rt/ws?token=not-a-real-token`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
    });
    assert.equal(closeCode, WS_CLOSE_UNAUTHENTICATED);
  });

  test('avec un jeton valide : la connexion reste ouverte', async () => {
    const token = sign(
      { sub: 'driver-1', role: 'driver', exp: Math.floor(Date.now() / 1000) + 3600 },
      config.JWT_SECRET
    );
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rt/ws?token=${token}`);
    const opened = await new Promise<boolean>((resolve) => {
      ws.on('open', () => resolve(true));
      ws.on('close', () => resolve(false));
    });
    assert.equal(opened, true);
    ws.close();
  });
});
