// Contre un Redis réel (la file doit survivre à un "redémarrage" du service -- donc à un accès
// qui ne partage aucun état en mémoire avec celui qui a posé l'entrée) et un faux serveur Odoo
// local, même patron que test/reconcile.test.ts.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import {
  enqueueOutboxEntry,
  attemptOutboxEntry,
  drainDueEntries,
  getOutboxStats,
  reportOutboxWrite,
  OUTBOX_ENTRY_TYPES,
  type OutboxEntry,
} from '../src/odoo/outbox';
import { parseConfig, type Config } from '../src/config';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const RUN_ID = randomUUID().slice(0, 8);
const id = (label: string) => `${label}-${RUN_ID}`;

let redis: Redis;
let odooServer: http.Server;
let odooPort: number;
let config: Config;

// Contrôlé par chaque test : chaque requête reçue par le faux serveur y est journalisée, et sa
// réponse peut être scriptée (par défaut, 500 -- "Odoo indisponible", le cas nominal du critère
// d'acceptation 2).
let requestLog: Array<{ path: string; idempotencyKey: string | null; body: unknown }>;
let respond: (req: http.IncomingMessage) => { status: number; body: unknown };
// D71 : distinct de `respond` -- un Odoo qui SE TAIT n'a ni statut ni corps à renvoyer, c'est
// précisément la différence avec `defaultRespond` (500, immédiat) qui couvrait déjà "Odoo
// refuse". Les réponses jamais terminées sont gardées pour un nettoyage explicite en `after`.
let silent = false;
const silentResponses: http.ServerResponse[] = [];

function defaultRespond(): { status: number; body: unknown } {
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'boom', details: null } } };
}

before(async () => {
  redis = new Redis(REDIS_URL);
  odooServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      requestLog.push({
        path: req.url ?? '',
        idempotencyKey: (req.headers['idempotency-key'] as string) ?? null,
        body,
      });
      if (silent) {
        silentResponses.push(res);
        return;
      }
      const { status, body: responseBody } = respond(req);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>((resolve) => odooServer.listen(0, resolve));
  const address = odooServer.address();
  if (address === null || typeof address === 'string') throw new Error('port de test introuvable');
  odooPort = address.port;
  config = parseConfig({
    REDIS_URL,
    ODOO_INTERNAL_URL: `http://127.0.0.1:${odooPort}`,
    REALTIME_SHARED_SECRET: 'secret',
    JWT_SECRET: 'secret',
    // Assez grand pour dominer la variance d'un aller-retour HTTP localhost (quelques ms à
    // quelques dizaines de ms) dans le test de croissance du délai ci-dessous -- un pas trop
    // court rendrait ce test instable, pas la mécanique qu'il vérifie.
    OUTBOX_BASE_DELAY_MS: '500',
    OUTBOX_MAX_DELAY_MS: '5000',
    OUTBOX_ALERT_ATTEMPTS_THRESHOLD: '3',
    OUTBOX_ALERT_QUEUE_SIZE_THRESHOLD: '2',
    // D71 : même raisonnement que OUTBOX_BASE_DELAY_MS ci-dessus -- assez grand pour ne jamais
    // couper une réponse localhost normale (quelques ms), assez court pour que le test du silence
    // n'attende pas des secondes pour rien.
    ODOO_CALL_TIMEOUT_MS: '300',
  });
});

beforeEach(async () => {
  requestLog = [];
  respond = defaultRespond;
  silent = false;
  // La file est une clé Redis globale (babana:outbox:queue), pas partitionnée par test comme le
  // reste (id()/RUN_ID) : sans ce nettoyage, les entrées laissées en échec par un test
  // (délibérément, pour prouver le rejeu) fausseraient getOutboxStats() du suivant.
  const entryKeys = await redis.keys('babana:outbox:entry:*');
  await Promise.all([
    redis.del('babana:outbox:queue'),
    ...(entryKeys.length ? [redis.del(...entryKeys)] : []),
  ]);
});

after(async () => {
  for (const res of silentResponses.splice(0)) {
    res.destroy();
  }
  odooServer.close();
  const entryKeys = await redis.keys('babana:outbox:entry:*');
  await Promise.all([
    redis.del('babana:outbox:queue'),
    ...(entryKeys.length ? [redis.del(...entryKeys)] : []),
  ]);
  redis.disconnect();
});

async function makeEntry(type: 'driver-accepted' | 'driver-rejected', suffix: string): Promise<OutboxEntry> {
  return enqueueOutboxEntry(redis, type, `/api/internal/rides/${id(suffix)}/${type}`, {
    driverId: id(`driver-${suffix}`),
  });
}

describe('OUTBOX_ENTRY_TYPES (L3-12, critère 1 corrigé -- amoa/questions/L3-12.md)', () => {
  test('porte exactement les deux écritures réellement sorties du service temps réel', () => {
    assert.deepEqual([...OUTBOX_ENTRY_TYPES].sort(), ['driver-accepted', 'driver-rejected']);
  });

  test('enqueueOutboxEntry refuse un type inconnu plutôt que de le mettre en file en silence', async () => {
    await assert.rejects(() =>
      enqueueOutboxEntry(redis, 'ride-completed' as never, '/api/internal/rides/x/whatever', {})
    );
  });
});

describe('enqueueOutboxEntry + attemptOutboxEntry (persistance et rejeu)', () => {
  test('une entrée persiste dans Redis avant toute tentative HTTP', async () => {
    const entry = await enqueueOutboxEntry(redis, 'driver-accepted', '/never/attempted', {});
    const raw = await redis.get(`babana:outbox:entry:${entry.id}`);
    assert.ok(raw, "l'entrée doit exister en Redis, indépendamment de toute tentative");
    assert.equal(requestLog.length, 0, 'enqueue seul ne doit déclencher aucun appel HTTP');
  });

  test('Odoo indisponible (500) : l’entrée reste en file avec un délai de rejeu croissant', async () => {
    const entry = await makeEntry('driver-accepted', 'retry-growth');

    // Mesuré depuis l'instant de CHAQUE appel, pas depuis enqueuedAt ni depuis le nextAttemptAt
    // précédent : la durée du seul aller-retour HTTP (variable, localhost) s'ajoute sinon au
    // délai mesuré et peut dominer la différence qu'on cherche à observer (500 vs 1000 ms).
    const beforeFirst = Date.now();
    const first = await attemptOutboxEntry(config, redis, entry);
    assert.equal(first, 'retry');
    const afterFirst = JSON.parse((await redis.get(`babana:outbox:entry:${entry.id}`)) ?? 'null');
    assert.equal(afterFirst.attempts, 1);
    const delay1 = afterFirst.nextAttemptAt - beforeFirst;

    const beforeSecond = Date.now();
    const second = await attemptOutboxEntry(config, redis, afterFirst);
    assert.equal(second, 'retry');
    const afterSecond = JSON.parse((await redis.get(`babana:outbox:entry:${entry.id}`)) ?? 'null');
    assert.equal(afterSecond.attempts, 2);
    const delay2 = afterSecond.nextAttemptAt - beforeSecond;

    assert.ok(delay2 > delay1, `le délai doit croître (${delay1} -> ${delay2})`);
  });

  test('chaque tentative porte la même Idempotency-Key -- id de l’entrée, stable à travers le rejeu', async () => {
    const entry = await makeEntry('driver-rejected', 'stable-key');
    await attemptOutboxEntry(config, redis, entry);
    const updated = JSON.parse((await redis.get(`babana:outbox:entry:${entry.id}`)) ?? 'null');
    await attemptOutboxEntry(config, redis, updated);

    assert.equal(requestLog.length, 2);
    assert.equal(requestLog[0]?.idempotencyKey, entry.id);
    assert.equal(requestLog[1]?.idempotencyKey, entry.id);
  });

  test('Odoo redevient joignable : le passage suivant vide la file', async () => {
    const entry = await makeEntry('driver-accepted', 'recovers');
    respond = defaultRespond;
    await attemptOutboxEntry(config, redis, entry);
    const afterFailure = JSON.parse(
      (await redis.get(`babana:outbox:entry:${entry.id}`)) ?? 'null'
    );
    assert.ok(afterFailure, 'encore en file après un échec');

    respond = () => ({ status: 200, body: { ok: true } });
    // L'échec ci-dessus a reprogrammé l'entrée à sa propre échéance (nextAttemptAt, lue plutôt
    // que devinée depuis la config -- nextDelayMs dépend du nombre de tentatives) : un passage
    // immédiat ne la trouverait pas encore due, ce n'est pas ce que ce test vérifie.
    const waitMs = Math.max(0, afterFailure.nextAttemptAt - Date.now()) + 100;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const { processed } = await drainDueEntries(config, redis);

    assert.ok(processed >= 1);
    assert.equal(await redis.get(`babana:outbox:entry:${entry.id}`), null, "l'entrée doit avoir disparu");
  });

  test('409 RIDE_INVALID_TRANSITION (rejeu déjà appliqué) vide la file sans jamais réussir "normalement"', async () => {
    const entry = await makeEntry('driver-accepted', 'already-applied');
    respond = () => ({
      status: 409,
      body: { error: { code: 'RIDE_INVALID_TRANSITION', message: 'déjà accepté', details: null } },
    });

    const outcome = await attemptOutboxEntry(config, redis, entry);

    assert.equal(outcome, 'applied');
    assert.equal(await redis.get(`babana:outbox:entry:${entry.id}`), null);
  });

  test('une entrée dont l’appel réussit du premier coup ne reste jamais en file (chemin nominal)', async () => {
    respond = () => ({ status: 200, body: { ok: true } });
    const entry = await makeEntry('driver-accepted', 'happy-path');

    const outcome = await attemptOutboxEntry(config, redis, entry);

    assert.equal(outcome, 'applied');
    assert.equal(await redis.get(`babana:outbox:entry:${entry.id}`), null);
  });
});

describe('drainDueEntries survit à un "redémarrage" du service (critère 3)', () => {
  test('une entrée posée par un appelant qui a depuis disparu est reprise depuis le seul état Redis', async () => {
    // Aucune référence à l'entrée n'est conservée après enqueue -- exactement ce qu'un
    // redémarrage du service laisserait derrière lui : plus rien en mémoire, tout dans Redis.
    await enqueueOutboxEntry(redis, 'driver-rejected', `/api/internal/rides/${id('restart')}/driver-rejected`, {
      driverId: id('driver-restart'),
    });
    respond = () => ({ status: 200, body: { ok: true } });

    const { processed } = await drainDueEntries(config, redis);

    assert.ok(processed >= 1);
    assert.ok(requestLog.some((r) => r.path.includes(id('restart'))));
  });
});

describe('Alertes (critère 5)', () => {
  test("une entrée qui échoue au-delà du seuil de tentatives déclenche une alerte journalisée", async () => {
    const entry = await makeEntry('driver-accepted', 'alert-attempts');
    const originalError = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => calls.push(args);
    try {
      let current: OutboxEntry = entry;
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await attemptOutboxEntry(config, redis, current);
        // eslint-disable-next-line no-await-in-loop
        current = JSON.parse((await redis.get(`babana:outbox:entry:${current.id}`)) ?? 'null');
      }
    } finally {
      console.error = originalError;
    }

    assert.ok(
      calls.some((args) => String(args[0]).includes('[L3-12]') && String(args[0]).includes('échec répété')),
      'le seuil de tentatives (3, config de test) doit avoir déclenché une alerte'
    );
  });

  test('une file au-dessus du seuil de taille déclenche une alerte lors du passage périodique', async () => {
    await makeEntry('driver-accepted', 'alert-queue-1');
    await makeEntry('driver-rejected', 'alert-queue-2');
    await makeEntry('driver-accepted', 'alert-queue-3');
    // Toutes échouent (respond par défaut = 500) : le seuil de taille (2, config de test) est
    // donc dépassé au moment du passage.

    const originalError = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => calls.push(args);
    try {
      await drainDueEntries(config, redis);
    } finally {
      console.error = originalError;
    }

    assert.ok(
      calls.some((args) => String(args[0]).includes('[L3-12]') && String(args[0]).includes('seuil')),
      "le passage doit avoir alerté sur la taille de la file"
    );

    const stats = await getOutboxStats(redis);
    assert.ok(stats.pending >= 2);
    assert.ok(stats.oldestAgeMs !== null && stats.oldestAgeMs >= 0);
  });
});

describe('reportOutboxWrite (point d’entrée non bloquant, odoo/rides.ts)', () => {
  test('ne bloque jamais son appelant, même quand Odoo échoue', () => {
    const before2 = Date.now();
    reportOutboxWrite(config, redis, 'driver-accepted', `/api/internal/rides/${id('nonblocking')}/driver-accepted`, {
      driverId: id('driver-nonblocking'),
    });
    assert.ok(Date.now() - before2 < 50, "reportOutboxWrite doit revenir immédiatement, jamais attendre l'appel HTTP");
  });

  test('persiste puis tente un envoi immédiat : Odoo joignable, la file reste vide (latence du cas courant)', async () => {
    respond = () => ({ status: 200, body: { ok: true } });
    reportOutboxWrite(config, redis, 'driver-rejected', `/api/internal/rides/${id('immediate')}/driver-rejected`, {
      driverId: id('driver-immediate'),
      reason: null,
      expired: false,
    });

    // Best-effort : reportOutboxWrite ne fournit aucune poignée à attendre (c'est son contrat,
    // voir le test précédent) -- on sonde plutôt qu'une attente fixe, pour rester robuste à la
    // charge de la machine de test sans pour autant traîner sur un aller-retour localhost.
    //
    // Filtré sur CETTE entrée (par chemin, id('immediate')), pas sur `getOutboxStats().pending`
    // dans l'absolu : le test précédent a lui aussi posé une entrée par un appel non bloquant
    // (c'est justement ce qu'il prouve), et rien ne garantit qu'elle ait fini son propre passage
    // avant que celui-ci ne s'exécute -- ce serait tester une fuite entre deux tests, pas le
    // comportement de reportOutboxWrite lui-même.
    const stillPending = async () => {
      const entryKeys = await redis.keys('babana:outbox:entry:*');
      const raws = await Promise.all(entryKeys.map((key) => redis.get(key)));
      return raws.some((raw) => raw && (JSON.parse(raw) as OutboxEntry).path.includes(id('immediate')));
    };
    const deadline = Date.now() + 2_000;
    while ((await stillPending()) && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.ok(requestLog.some((r) => r.path.includes(id('immediate'))));
    assert.equal(
      await stillPending(),
      false,
      "l'envoi immédiat ayant réussi, cette entrée ne doit plus être en file"
    );
  });
});

describe('D71 (amoa/01-architecture.md §9 terdecies) -- Odoo silencieux, pas seulement Odoo qui refuse', () => {
  // Toute la suite ci-dessus (500 immédiat, 409 immédiat) prouve la file contre un Odoo qui
  // RÉPOND vite, même par une erreur. Aucun de ces tests n'aurait échoué avant D71 : callOdooOnce
  // sans délai lève déjà sur une réponse d'erreur, exactement comme avec un délai. Le défaut de
  // D71 ne se voit que quand Odoo ne répond pas DU TOUT -- c'est la seule condition que `silent`
  // reproduit ici, jamais exercée avant cette nuit.
  test(
    "une course acceptée pendant qu'Odoo se tait est mise en échec, reste en file, puis rejouée " +
      'avec succès quand Odoo répond de nouveau -- sans intervention après reportOutboxWrite',
    async () => {
      silent = true;
      const path = `/api/internal/rides/${id('silent-then-recovers')}/driver-accepted`;

      // Exactement l'appel que odoo/rides.ts::reportDriverAccepted fait pour une acceptation
      // (voir la même fonction, `driverId` seul dans le corps) -- non attendu, comme dans
      // proposal/lifecycle.ts::accept(), pour ne jamais retarder ce que le chauffeur voit déjà
      // via la résolution atomique Redis.
      const before2 = Date.now();
      reportOutboxWrite(config, redis, 'driver-accepted', path, { driverId: id('driver-silent') });
      assert.ok(
        Date.now() - before2 < 50,
        "reportOutboxWrite doit revenir immédiatement même si Odoo va se taire -- il ne le sait pas encore"
      );

      // L'échec : la tentative immédiate atteint Odoo (le corps est déjà journalisé avant que le
      // faux serveur ne se taise) mais n'obtient jamais de réponse -- sans le délai de D71, ceci
      // attendrait indéfiniment et le reste du test ne se produirait jamais.
      const entryAppeared = async () => {
        const entryKeys = await redis.keys('babana:outbox:entry:*');
        const raws = await Promise.all(entryKeys.map((key) => redis.get(key)));
        return raws
          .map((raw) => (raw ? (JSON.parse(raw) as OutboxEntry) : null))
          .find((entry) => entry?.path === path);
      };
      const deadlineFailure = Date.now() + 2_000;
      let entry = await entryAppeared();
      while ((!entry || entry.attempts < 1) && Date.now() < deadlineFailure) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 20));
        // eslint-disable-next-line no-await-in-loop
        entry = await entryAppeared();
      }

      assert.ok(requestLog.some((r) => r.path === path), 'Odoo doit avoir reçu la requête avant de se taire');
      assert.ok(entry, "l'entrée doit rester en file après l'échec -- c'est le sens de la file");
      assert.equal(entry.attempts, 1, "un échec, pas un succès escamoté");
      assert.ok(
        entry.nextAttemptAt > Date.now() - 50,
        "l'entrée doit être reprogrammée (remise en file) plutôt que retirée"
      );
      assert.ok(
        entry.lastError !== null && !entry.lastError.includes('409') && !entry.lastError.includes('500'),
        `l'échec doit venir du réseau (silence), pas d'une réponse HTTP : ${entry.lastError}`
      );

      // Odoo revient : le prochain passage périodique doit prendre le relais tout seul --
      // personne ne rappelle reportOutboxWrite, exactement le scénario "aboutit toute seule".
      silent = false;
      respond = () => ({ status: 200, body: { ok: true, rideId: id('silent-then-recovers') } });
      const waitMs = Math.max(0, entry.nextAttemptAt - Date.now()) + 100;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      const { processed } = await drainDueEntries(config, redis);

      assert.ok(processed >= 1, 'le passage périodique doit avoir traité au moins une entrée due');
      assert.equal(
        await entryAppeared(),
        undefined,
        "le rejeu doit avoir abouti : l'entrée ne doit plus être en file"
      );
      assert.ok(
        requestLog.filter((r) => r.path === path).length >= 2,
        'Odoo doit avoir reçu la tentative silencieuse ET la tentative rejouée qui a abouti'
      );
    }
  );
});
