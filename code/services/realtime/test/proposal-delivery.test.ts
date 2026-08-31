// Mesure du délai d'acheminement d'une proposition (L7-04, critère 4).
//
// Deux niveaux : la classe de compteurs (unité pure), puis le câblage `proposal.seen` ->
// `proposalDeliveryMetrics` dans le dispatcher (contre un Redis réel, comme cash-guard.test.ts --
// le dispatcher construit de vraies dépendances).
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { WebSocket } from 'ws';
import { ProposalDeliveryMetrics, proposalDeliveryMetrics } from '../src/proposal/delivery-metrics';
import { createMessageDispatcher } from '../src/ws/dispatch';
import { NearbyManager } from '../src/nearby/handler';
import { ProposalLifecycle } from '../src/proposal/lifecycle';
import { TrackingManager } from '../src/tracking/broadcast';
import { ConnectionRegistry, type ConnectionContext } from '../src/ws/auth';
import { parseConfig, type Config } from '../src/config';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

describe('ProposalDeliveryMetrics (L7-04, critère 4)', () => {
  let m: ProposalDeliveryMetrics;
  beforeEach(() => {
    m = new ProposalDeliveryMetrics();
  });

  test('retient un délai plausible et le cumule pour une moyenne', () => {
    assert.equal(m.record(4_000, 30_000), true);
    assert.equal(m.record(6_000, 30_000), true);
    const s = m.snapshot();
    assert.equal(s.count, 2);
    assert.equal(s.sumMs, 10_000);
    assert.equal(s.sumMs / s.count, 5_000);
    assert.equal(s.maxMs, 6_000);
    assert.equal(s.discarded, 0);
    assert.equal(s.overAcceptanceBudget, 0);
  });

  test('compte à part les mesures qui dépassent le budget d’acceptation', () => {
    m.record(12_000, 30_000);
    m.record(41_000, 30_000);
    assert.equal(m.snapshot().overAcceptanceBudget, 1);
  });

  test('écarte un délai négatif (horloge, ou emittedAt falsifié) sans le compter', () => {
    assert.equal(m.record(-2_000, 30_000), false);
    const s = m.snapshot();
    assert.equal(s.count, 0);
    assert.equal(s.discarded, 1);
  });

  test('écarte un délai aberrant (> 1 h) plutôt que de tirer la moyenne vers le haut', () => {
    assert.equal(m.record(3 * 60 * 60 * 1000, 30_000), false);
    assert.equal(m.snapshot().discarded, 1);
    assert.equal(m.snapshot().count, 0);
  });

  test('reset remet tous les compteurs à zéro', () => {
    m.record(5_000, 30_000);
    m.record(-1, 30_000);
    m.reset();
    assert.deepEqual(m.snapshot(), { count: 0, discarded: 0, sumMs: 0, maxMs: 0, overAcceptanceBudget: 0 });
  });
});

describe('dispatch: proposal.seen alimente la métrique (L7-04, critère 4)', () => {
  let redis: Redis;
  let config: Config;
  let dispatch: ReturnType<typeof createMessageDispatcher>;

  before(() => {
    redis = new Redis(REDIS_URL);
    config = parseConfig({
      REDIS_URL,
      ODOO_INTERNAL_URL: 'http://odoo.invalid.test:1',
      REALTIME_SHARED_SECRET: 'secret',
      JWT_SECRET: 'secret',
    });
    const registry = new ConnectionRegistry();
    dispatch = createMessageDispatcher(
      config,
      redis,
      new NearbyManager(config, redis),
      new ProposalLifecycle(config, redis, registry),
      new TrackingManager(config, redis)
    );
  });

  after(() => {
    redis.disconnect();
  });

  beforeEach(() => {
    proposalDeliveryMetrics.reset();
  });

  const driverCtx: ConnectionContext = Object.freeze({ userId: 'u-d', role: 'driver', driverId: 'd-1' });
  const clientCtx: ConnectionContext = Object.freeze({ userId: 'u-c', role: 'client', driverId: null });
  const socket = { readyState: 1, OPEN: 1, send: () => {} } as unknown as WebSocket;

  function seen(emittedAt: string) {
    return JSON.stringify({
      type: 'proposal.seen',
      id: randomUUID(),
      emittedAt: new Date().toISOString(),
      payload: { rideId: '11111111-1111-4111-8111-111111111111', emittedAt },
    });
  }

  test("un proposal.seen d'un chauffeur enregistre le délai émission -> affichage", async () => {
    await dispatch(driverCtx, socket, seen(new Date(Date.now() - 8_000).toISOString()));
    const s = proposalDeliveryMetrics.snapshot();
    assert.equal(s.count, 1);
    assert.ok(s.maxMs >= 7_000 && s.maxMs <= 12_000, `délai proche de 8 s (${s.maxMs} ms)`);
  });

  test('un proposal.seen émis par un contexte client est ignoré (garde de rôle, L3-01)', async () => {
    await dispatch(clientCtx, socket, seen(new Date(Date.now() - 8_000).toISOString()));
    assert.equal(proposalDeliveryMetrics.snapshot().count, 0);
  });

  test('un emittedAt non analysable est ignoré sans rien compter', async () => {
    await dispatch(driverCtx, socket, seen('pas-une-date'));
    // Le schéma du contrat rejette d'abord (IsoDateTimeSchema) -> message ignoré au parse.
    assert.equal(proposalDeliveryMetrics.snapshot().count, 0);
    assert.equal(proposalDeliveryMetrics.snapshot().discarded, 0);
  });
});
