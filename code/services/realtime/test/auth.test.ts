import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import type Redis from 'ioredis';
import { createServer } from '../src/server';
import {
  authenticateConnection,
  matchesConnectionIdentity,
  ConnectionRegistry,
  WS_CLOSE_UNAUTHENTICATED,
  WS_CLOSE_TOKEN_EXPIRED,
  type ConnectionContext,
} from '../src/ws/auth';
import type { Config } from '../src/config';

const config: Config = {
  NODE_ENV: 'test',
  PORT: 0,
  REDIS_URL: 'redis://unused:6379',
  ODOO_INTERNAL_URL: 'http://odoo.invalid.test:1', // délibérément injoignable -- voir critère 4
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
  DRIVER_PROFILE_CACHE_TTL_SECONDS: 30,
};

function sign(claims: Record<string, unknown>, secret = config.JWT_SECRET): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function fakeRequest(url: string): IncomingMessage {
  return { url } as unknown as IncomingMessage;
}

// UUID : AccessTokenClaimsSchema (@babana/contracts, D23) exige sub/driverId/jti en UUID --
// la même forme qu'Odoo émet réellement.
const DRIVER_SUB = crypto.randomUUID();
const DRIVER_PUBLIC_ID = crypto.randomUUID();

const validDriverClaims = {
  sub: DRIVER_SUB,
  role: 'driver' as const,
  driverId: DRIVER_PUBLIC_ID,
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
  jti: crypto.randomUUID(),
};

describe('authenticateConnection (L3-01)', () => {
  // --- Critère 1 : une connexion sans jeton est refusée -------------------------------------

  test('sans jeton : refusée avec WS_CLOSE_UNAUTHENTICATED', () => {
    const result = authenticateConnection(fakeRequest('/rt/ws'), config);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.closeCode, WS_CLOSE_UNAUTHENTICATED);
  });

  test('jeton malformé : refusée avec WS_CLOSE_UNAUTHENTICATED', () => {
    const result = authenticateConnection(fakeRequest('/rt/ws?token=not-a-real-token'), config);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.closeCode, WS_CLOSE_UNAUTHENTICATED);
  });

  // --- Critère 2 : un jeton expiré est refusé avec un code documenté, distinct -------------

  test('jeton expiré : refusée avec WS_CLOSE_TOKEN_EXPIRED, distinct de WS_CLOSE_UNAUTHENTICATED', () => {
    const expired = { ...validDriverClaims, exp: Math.floor(Date.now() / 1000) - 10 };
    const result = authenticateConnection(fakeRequest(`/rt/ws?token=${sign(expired)}`), config);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.closeCode, WS_CLOSE_TOKEN_EXPIRED);
      assert.notEqual(WS_CLOSE_TOKEN_EXPIRED, WS_CLOSE_UNAUTHENTICATED);
    }
  });

  // --- Contexte immuable, avec driverId quand le rôle est 'driver' --------------------------

  test('jeton valide : contexte immuable posé avec userId, role, driverId', () => {
    const result = authenticateConnection(fakeRequest(`/rt/ws?token=${sign(validDriverClaims)}`), config);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.context.userId, DRIVER_SUB);
    assert.equal(result.context.role, 'driver');
    assert.equal(result.context.driverId, DRIVER_PUBLIC_ID);
    assert.notEqual(result.context.driverId, result.context.userId);
    // Object.freeze() rend la valeur elle-même immuable, pas seulement son type -- une
    // affectation silencieusement ignorée en mode non strict plutôt qu'une levée d'exception
    // (dépend du mode d'exécution du module) ; Object.isFrozen() est la façon portable de le
    // prouver, indépendamment de ce détail d'environnement.
    assert.equal(Object.isFrozen(result.context), true);
  });

  test('jeton chauffeur sans driverId : refusé -- driverId est obligatoire sur un jeton chauffeur (D23)', () => {
    // Avant D23, ws/token.ts posait ce cas comme une hypothèse acceptable ("L1-02 pas encore
    // posé"), alors que le vrai jeton d'Odoo, lu depuis controllers/auth.py, avait déjà une
    // forme différente -- exactement le défaut réparé cette nuit
    // (amoa/questions/REPONSES-2026-08-15.md §1). AccessTokenClaimsSchema rend maintenant ce
    // jeton invalide, pas silencieusement dégradé à driverId=null.
    const { driverId: _omitted, ...withoutDriverId } = validDriverClaims;
    const result = authenticateConnection(
      fakeRequest(`/rt/ws?token=${sign(withoutDriverId)}`), config
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.closeCode, WS_CLOSE_UNAUTHENTICATED);
  });

  test('jeton valide, rôle client : driverId est toujours null', () => {
    const claims = {
      sub: crypto.randomUUID(),
      role: 'client' as const,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: crypto.randomUUID(),
    };
    const result = authenticateConnection(fakeRequest(`/rt/ws?token=${sign(claims)}`), config);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.context.driverId, null);
  });

  // --- Critère 4 : aucun appel sortant vers Odoo pendant la validation ----------------------

  test("la validation réussit sans appel sortant, même avec ODOO_INTERNAL_URL injoignable", () => {
    // config.ODOO_INTERNAL_URL pointe vers une adresse invalide dès le haut de ce fichier --
    // si authenticateConnection() y faisait le moindre appel, ce test échouerait par timeout
    // ou par erreur réseau plutôt que de réussir en quelques millisecondes.
    const start = Date.now();
    const result = authenticateConnection(fakeRequest(`/rt/ws?token=${sign(validDriverClaims)}`), config);
    assert.equal(result.ok, true);
    assert.ok(Date.now() - start < 50, 'la validation doit être locale, donc quasi instantanée');
  });
});

describe('matchesConnectionIdentity (L3-01, critère 3)', () => {
  const context: ConnectionContext = Object.freeze({
    userId: 'user-driver-1',
    role: 'driver',
    driverId: 'driver-public-1',
  });

  test("un identifiant absent du message est toujours accepté (rien à contredire)", () => {
    assert.equal(matchesConnectionIdentity(context), true);
    assert.equal(matchesConnectionIdentity(context, undefined), true);
  });

  test("un identifiant qui correspond à la connexion est accepté", () => {
    assert.equal(matchesConnectionIdentity(context, 'user-driver-1'), true);
  });

  test("un identifiant différent de celui de la connexion est rejeté, pas honoré", () => {
    assert.equal(matchesConnectionIdentity(context, 'user-driver-2'), false);
  });
});

describe('ConnectionRegistry (L3-01, émission ciblée)', () => {
  test('indexe par userId et par driverId, retrouve toutes les connexions actives', () => {
    const registry = new ConnectionRegistry();
    const context: ConnectionContext = Object.freeze({
      userId: 'user-driver-1', role: 'driver', driverId: 'driver-public-1',
    });
    const socketA = {} as unknown as WebSocket;
    const socketB = {} as unknown as WebSocket;

    registry.add(context, socketA);
    registry.add(context, socketB);

    assert.equal(registry.getByUserId('user-driver-1').size, 2);
    assert.equal(registry.getByDriverId('driver-public-1').size, 2);
    assert.equal(registry.getByUserId('unknown').size, 0);
  });

  test('une connexion retirée disparaît du registre', () => {
    const registry = new ConnectionRegistry();
    const context: ConnectionContext = Object.freeze({
      userId: 'user-client-1', role: 'client', driverId: null,
    });
    const socket = {} as unknown as WebSocket;

    registry.add(context, socket);
    assert.equal(registry.getByUserId('user-client-1').size, 1);

    registry.remove(context, socket);
    assert.equal(registry.getByUserId('user-client-1').size, 0);
  });
});

// --- Critère 5 : un jeton qui expire en cours de connexion la ferme (intégration, vraie pile) --

describe('critère 5 — un jeton qui expire en cours de connexion la ferme', () => {
  let port: number;
  let server: ReturnType<typeof createServer>;
  const fakeRedis = { ping: async () => 'PONG' } as unknown as Redis;

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

  test('une connexion ouverte avec un jeton sur le point d\'expirer est fermée à expiration, avec WS_CLOSE_TOKEN_EXPIRED', async () => {
    const soonToExpire = { ...validDriverClaims, exp: Math.floor(Date.now() / 1000) + 1 };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rt/ws?token=${sign(soonToExpire)}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('close', (code) => reject(new Error(`fermée prématurément avec le code ${code}`)));
    });

    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
    });
    assert.equal(closeCode, WS_CLOSE_TOKEN_EXPIRED);
  });
});
