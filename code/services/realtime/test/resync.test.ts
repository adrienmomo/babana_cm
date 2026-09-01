// Contre un faux serveur Odoo local, comme reconcile.test.ts -- ce module (ws/resync.ts) ne
// connaît d'Odoo que la réponse JSON de /api/internal/session/active-ride (invariant 3, il ne
// décide de rien, il reflète). Le socket est un faux, même patron que nearby.test.ts : ce
// gestionnaire n'a besoin que de `readyState`/`OPEN`/`send`. `ProposalLifecycle` est un faux
// aussi -- resync ne lui demande que `peekActiveProposal` (L7-04).
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { WebSocket } from 'ws';
import type { realtime } from '@babana/contracts';
import { handleSessionResync } from '../src/ws/resync';
import type { ProposalLifecycle } from '../src/proposal/lifecycle';
import { parseConfig, type Config } from '../src/config';
import type { ConnectionContext } from '../src/ws/auth';

let odooServer: http.Server;
let odooRequests: unknown[] = [];
let odooResponse: { rideId: string | null; state: string | null } | 'error' = { rideId: null, state: null };
let config: Config;

before(async () => {
  odooServer = http.createServer((req, res) => {
    if (req.url === '/api/internal/session/active-ride') {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk));
      req.on('end', () => {
        odooRequests.push(JSON.parse(raw || '{}'));
        if (odooResponse === 'error') {
          res.writeHead(500);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(odooResponse));
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
    REDIS_URL: 'redis://localhost:6379',
    ODOO_INTERNAL_URL: `http://127.0.0.1:${address.port}`,
    REALTIME_SHARED_SECRET: 'secret',
    JWT_SECRET: 'secret',
  });
});

beforeEach(() => {
  odooRequests = [];
  odooResponse = { rideId: null, state: null };
});

after(() => {
  odooServer.close();
});

function clientContext(): ConnectionContext {
  return Object.freeze({ userId: 'user-1', role: 'client', driverId: null });
}

function driverContext(): ConnectionContext {
  return Object.freeze({ userId: 'user-2', role: 'driver', driverId: 'driver-1' });
}

/**
 * Faux `ProposalLifecycle` : ne compte que `peekActiveProposal`. `calls` enregistre les driverId
 * demandés, pour vérifier qu'un contexte client ne le consulte jamais.
 */
function fakeProposals(activeProposal: realtime.ActiveProposal | null = null) {
  const calls: string[] = [];
  const proposals = {
    peekActiveProposal: async (driverId: string) => {
      calls.push(driverId);
      return activeProposal;
    },
  } as unknown as ProposalLifecycle;
  return { proposals, calls };
}

function anActiveProposal(overrides: Partial<realtime.ActiveProposal> = {}): realtime.ActiveProposal {
  return {
    rideId: '11111111-1111-4111-8111-111111111111',
    origin: { latitude: 4.05, longitude: 9.7 },
    destination: { latitude: 4.06, longitude: 9.71 },
    amount: 1500,
    distanceMeters: 2200,
    distanceToOriginMeters: 800,
    expiresAt: new Date(Date.now() + 5000).toISOString(),
    emittedAt: new Date(Date.now() - 25000).toISOString(),
    ...overrides,
  };
}

function fakeSocket() {
  const messages: unknown[] = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => messages.push(JSON.parse(data)),
  };
  return { socket: socket as unknown as WebSocket, messages: messages as { type: string; payload: unknown }[] };
}

describe('handleSessionResync (L3-11)', () => {
  test('critère 2 : la resynchronisation renvoie un état complet, une seule fois -- pas un différentiel', async () => {
    odooResponse = { rideId: 'ride-42', state: 'in_progress' };
    const { socket, messages } = fakeSocket();

    await handleSessionResync(config, fakeProposals().proposals, clientContext(), socket, { lastKnownRideId: null });

    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.type, 'session.synced');
    const payload = messages[0]!.payload as {
      activeRideId: string;
      activeRideState: string;
      rideStateKnown: boolean;
      serverTime: string;
    };
    assert.equal(payload.activeRideId, 'ride-42');
    assert.equal(payload.activeRideState, 'in_progress');
    assert.equal(payload.rideStateKnown, true);
    assert.ok(payload.serverTime);
  });

  test("aucune course active : activeRideId et activeRideState sont null, pas une erreur", async () => {
    odooResponse = { rideId: null, state: null };
    const { socket, messages } = fakeSocket();

    await handleSessionResync(config, fakeProposals().proposals, clientContext(), socket, { lastKnownRideId: null });

    const payload = messages[0]!.payload as { activeRideId: null; activeRideState: null };
    assert.equal(payload.activeRideId, null);
    assert.equal(payload.activeRideState, null);
  });

  test("l'identité vient du contexte de connexion, jamais d'un champ du message (même garde-fou que L3-01)", async () => {
    const { socket } = fakeSocket();

    await handleSessionResync(config, fakeProposals().proposals, driverContext(), socket, { lastKnownRideId: 'ride-99' });

    assert.equal(odooRequests.length, 1);
    assert.deepEqual(odooRequests[0], { userId: 'user-2', role: 'driver', lastKnownRideId: 'ride-99' });
  });

  test('lastKnownRideId est transmis à Odoo pour cibler la resynchronisation', async () => {
    const { socket } = fakeSocket();

    await handleSessionResync(config, fakeProposals().proposals, clientContext(), socket, { lastKnownRideId: 'ride-7' });

    assert.equal((odooRequests[0] as { lastKnownRideId: string }).lastKnownRideId, 'ride-7');
  });

  test('un socket déjà fermé pendant l’appel Odoo ne provoque pas d’écriture', async () => {
    odooResponse = { rideId: 'ride-42', state: 'assigned' };
    const { socket, messages } = fakeSocket();
    (socket as unknown as { readyState: number }).readyState = 3; // CLOSED

    await handleSessionResync(config, fakeProposals().proposals, clientContext(), socket, { lastKnownRideId: null });

    assert.equal(messages.length, 0);
  });

  test("Odoo injoignable : la réponse part quand même, rideStateKnown false, l'état de course n'est pas inféré", async () => {
    odooResponse = 'error';
    const { socket, messages } = fakeSocket();

    await assert.doesNotReject(
      handleSessionResync(config, fakeProposals().proposals, clientContext(), socket, { lastKnownRideId: null })
    );

    assert.equal(messages.length, 1);
    const payload = messages[0]!.payload as {
      activeRideId: unknown;
      activeRideState: unknown;
      rideStateKnown: boolean;
    };
    // `null` faute d'information, jamais parce qu'on a confirmé l'absence -- le drapeau le dit.
    assert.equal(payload.rideStateKnown, false);
    assert.equal(payload.activeRideId, null);
    assert.equal(payload.activeRideState, null);
  });

  test('Odoo injoignable : un chauffeur avec une proposition vivante la reçoit malgré tout (troisième voie L7-04)', async () => {
    odooResponse = 'error';
    const proposal = anActiveProposal();
    const { socket, messages } = fakeSocket();

    await handleSessionResync(config, fakeProposals(proposal).proposals, driverContext(), socket, {
      lastKnownRideId: null,
    });

    assert.equal(messages.length, 1);
    const payload = messages[0]!.payload as {
      activeProposal: realtime.ActiveProposal | null;
      rideStateKnown: boolean;
    };
    // Dire ce qu'on sait (la proposition, lue en Redis) ET ce qu'on ignore (l'état de course).
    assert.deepEqual(payload.activeProposal, proposal);
    assert.equal(payload.rideStateKnown, false);
  });

  // --- L7-04 : la proposition active retrouvée par resynchronisation -----------------------

  test('L7-04 : un chauffeur avec une proposition active la retrouve dans session.synced, avec sa véritable échéance', async () => {
    odooResponse = { rideId: null, state: null };
    const proposal = anActiveProposal();
    const { socket, messages } = fakeSocket();

    await handleSessionResync(config, fakeProposals(proposal).proposals, driverContext(), socket, {
      lastKnownRideId: null,
    });

    const payload = messages[0]!.payload as { activeProposal: realtime.ActiveProposal | null };
    assert.deepEqual(payload.activeProposal, proposal);
    // La véritable échéance, pas trente secondes fraîches : moins de dix secondes restantes ici.
    const remainingMs = Date.parse(payload.activeProposal!.expiresAt) - Date.now();
    assert.ok(remainingMs > 0 && remainingMs <= 10_000, `échéance restituée telle quelle (${remainingMs} ms)`);
  });

  test("L7-04 : un chauffeur sans proposition reçoit activeProposal null -- l'absence est dite, pas déduite d'un silence", async () => {
    const { socket, messages } = fakeSocket();

    await handleSessionResync(config, fakeProposals(null).proposals, driverContext(), socket, {
      lastKnownRideId: null,
    });

    const payload = messages[0]!.payload as { activeProposal: unknown };
    assert.equal(payload.activeProposal, null);
  });

  test('L7-04 : un contexte client ne consulte jamais la relecture de proposition et reçoit toujours activeProposal null', async () => {
    const { proposals, calls } = fakeProposals(anActiveProposal());
    const { socket, messages } = fakeSocket();

    await handleSessionResync(config, proposals, clientContext(), socket, { lastKnownRideId: null });

    assert.deepEqual(calls, []);
    const payload = messages[0]!.payload as { activeProposal: unknown };
    assert.equal(payload.activeProposal, null);
  });
});
