// 15 novembre : hors ligne imposé par Odoo (selfie refusé ou dû, solde épuisé, pièce expirée). Le
// chauffeur sort du vivier et son app le voit aussitôt (`session.synced`, `driverOnline: false`).
// Contre un Redis réel et de vraies connexions WebSocket.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocket } from 'ws';
import Redis from 'ioredis';
import { realtime } from '@babana/contracts';
import { createServer } from '../src/server';
import { parseConfig } from '../src/config';
import { isMarkedOnline, setOnline } from '../src/driver/availability';
import { TEST_REDIS_URL } from './helpers/redis';

const config = parseConfig({
  REDIS_URL: TEST_REDIS_URL,
  // Courte, pour vérifier qu'elle ne s'applique pas quand un autre téléphone reste connecté.
  AVAILABILITY_DISCONNECT_GRACE_SECONDS: '1',
  ODOO_INTERNAL_URL: 'http://odoo.invalid.test:1',
  REALTIME_SHARED_SECRET: 'shared-secret',
  JWT_SECRET: 'jwt-secret',
});

function sign(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.createHmac('sha256', config.JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function driverToken(driverId: string, sid?: string): string {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub: crypto.randomUUID(), role: 'driver', driverId, iat: now, exp: now + 600, jti: crypto.randomUUID(), ...(sid ? { sid } : {}) });
}

let server: Server;
let port: number;
let redis: Redis;

before(async () => {
  redis = new Redis(TEST_REDIS_URL);
  server = createServer(config, redis);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await redis.quit();
});

interface Connection {
  socket: WebSocket;
  messages: realtime.ServerToClientMessage[];
  closed: Promise<number>;
}

function connect(token: string): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/rt/ws?token=${token}`);
    const messages: realtime.ServerToClientMessage[] = [];
    const closed = new Promise<number>((done) => socket.on('close', (code) => done(code)));
    socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
    socket.on('open', () => resolve({ socket, messages, closed }));
    socket.on('error', reject);
  });
}


describe('hors ligne imposé par le serveur (15 novembre)', () => {
  test('le chauffeur passe hors ligne et sa connexion ouverte reçoit aussitôt l’état à jour', async () => {
    const driverId = crypto.randomUUID();
    await setOnline(redis, driverId);
    const phone = await connect(driverToken(driverId));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/internal/drivers/offline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Realtime-Secret': 'shared-secret' },
        body: JSON.stringify({ driverId }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { offline: true, notified: 1 });
      assert.equal(await isMarkedOnline(redis, driverId), false);
      const synced = phone.messages.find((m) => m.type === 'session.synced');
      assert.ok(synced && synced.type === 'session.synced');
      assert.equal(synced.payload.driverOnline, false);
    } finally {
      phone.socket.close();
    }
  });
});
