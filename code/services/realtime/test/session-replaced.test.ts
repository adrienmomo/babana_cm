// 15 novembre : un compte chauffeur n'est connecté que sur un téléphone à la fois. Odoo annonce la
// nouvelle session après le commit ; la connexion de l'ancien téléphone est prévenue puis fermée,
// et ne peut plus se rouvrir. Contre un Redis réel et de vraies connexions WebSocket.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocket } from 'ws';
import Redis from 'ioredis';
import { realtime } from '@babana/contracts';
import { createServer } from '../src/server';
import { parseConfig } from '../src/config';
import { driverSessionKey } from '../src/driver/session';
import { isMarkedOnline, setOffline, setOnline } from '../src/driver/availability';
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

async function announceSession(driverId: string, sessionId: string) {
  const response = await fetch(`http://127.0.0.1:${port}/internal/drivers/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Realtime-Secret': 'shared-secret' },
    body: JSON.stringify({ driverId, sessionId }),
  });
  return { status: response.status, body: (await response.json()) as { closed: number } };
}

describe('un appareil par chauffeur (15 novembre)', () => {
  test('la nouvelle session ferme la connexion de l’ancien téléphone, après l’avoir prévenue', async () => {
    const driverId = crypto.randomUUID();
    const oldSession = crypto.randomUUID();
    const newSession = crypto.randomUUID();
    const oldPhone = await connect(driverToken(driverId, oldSession));
    const newPhone = await connect(driverToken(driverId, newSession));

    const { status, body } = await announceSession(driverId, newSession);

    assert.equal(status, 200);
    assert.equal(body.closed, 1);
    assert.equal(await oldPhone.closed, realtime.WS_CLOSE_SESSION_REPLACED);
    assert.ok(oldPhone.messages.some((m) => m.type === 'session.replaced'));
    assert.equal(newPhone.socket.readyState, WebSocket.OPEN, 'le nouveau téléphone reste connecté');
    newPhone.socket.close();
    await redis.del(driverSessionKey(driverId));
  });

  test('l’ancien téléphone qui se reconnecte est refusé aussitôt', async () => {
    const driverId = crypto.randomUUID();
    const current = crypto.randomUUID();
    await announceSession(driverId, current);

    const stale = await connect(driverToken(driverId, crypto.randomUUID()));
    assert.equal(await stale.closed, realtime.WS_CLOSE_SESSION_REPLACED);
    assert.ok(stale.messages.some((m) => m.type === 'session.replaced'));

    const legit = await connect(driverToken(driverId, current));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(legit.socket.readyState, WebSocket.OPEN);
    legit.socket.close();
    await redis.del(driverSessionKey(driverId));
  });

  test('aucune session connue (jeton d’avant ce changement) : la connexion est acceptée', async () => {
    const driverId = crypto.randomUUID();
    const legacy = await connect(driverToken(driverId));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(legacy.socket.readyState, WebSocket.OPEN);
    legacy.socket.close();
  });

  test('la fermeture de l’ancien téléphone ne met pas hors ligne le chauffeur, connecté sur le nouveau', async () => {
    const driverId = crypto.randomUUID();
    const newSession = crypto.randomUUID();
    await setOnline(redis, driverId);
    const oldPhone = await connect(driverToken(driverId, crypto.randomUUID()));
    const newPhone = await connect(driverToken(driverId, newSession));

    try {
      await announceSession(driverId, newSession);
      await oldPhone.closed;
      await new Promise((resolve) => setTimeout(resolve, 1_500)); // au-delà du délai de grâce

      assert.equal(await isMarkedOnline(redis, driverId), true);
    } finally {
      newPhone.socket.close();
      await setOffline(redis, driverId);
      await redis.del(driverSessionKey(driverId));
    }
  });

  test('une annonce mal formée est refusée', async () => {
    const { status } = await announceSession('d', 'pas-un-uuid');
    assert.equal(status, 400);
  });
});
