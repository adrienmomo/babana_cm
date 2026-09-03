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
  NEARBY_EXPAND_RADIUS_STEP_METERS: 2_000,
  NEARBY_EXPAND_MAX_RADIUS_METERS: 15_000,
  AVAILABILITY_DISCONNECT_GRACE_SECONDS: 45,
  RESERVATION_TTL_SECONDS: 45,
  PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS: 30,
  NEARBY_BROADCAST_INTERVAL_SECONDS: 5,
  NEARBY_RATE_LIMIT_MAX_SUBSCRIPTIONS: 10,
  NEARBY_RATE_LIMIT_WINDOW_SECONDS: 60,
  NEARBY_LAST_SENT_TTL_SECONDS: 30,
  RESERVATION_IDEMPOTENCY_TTL_SECONDS: 60,
  ENGAGEMENT_RECONCILE_INTERVAL_SECONDS: 20,
  TRACKING_BROADCAST_INTERVAL_SECONDS: 10,
  TRACKING_AVERAGE_SPEED_MPS: 8.3,
  DRIVER_PROFILE_CACHE_TTL_SECONDS: 30,
  SHARE_RATE_LIMIT_MAX_REQUESTS: 30,
  SHARE_RATE_LIMIT_WINDOW_SECONDS: 60,
  SHARE_POLL_INTERVAL_SECONDS: 10,
  ACCUMULATION_MIN_SEGMENT_METERS: 5,
  ACCUMULATION_SIMPLIFY_TOLERANCE_METERS: 8,
  ACCUMULATION_MAX_TRACK_POINTS: 500,
  ACCUMULATION_TTL_SECONDS: 21600,
  WS_HEARTBEAT_INTERVAL_SECONDS: 3600,
  OUTBOX_POLL_INTERVAL_SECONDS: 5,
  OUTBOX_BASE_DELAY_MS: 1_000,
  OUTBOX_MAX_DELAY_MS: 60_000,
  OUTBOX_ALERT_QUEUE_SIZE_THRESHOLD: 20,
  OUTBOX_ALERT_ATTEMPTS_THRESHOLD: 5,
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
      {
        sub: crypto.randomUUID(),
        role: 'driver',
        driverId: crypto.randomUUID(),
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: crypto.randomUUID(),
      },
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
