// L3-14 -- test de résilience (amoa/specs/L3-temps-reel.md). La SEULE vérification de
// l'invariant 1 : le service temps réel ne possède aucune donnée durable, tout se reconstruit
// depuis Odoo (D27) -- et, pour ce qui n'est pas un état MÉTIER (l'accumulation en cours, la
// file de rejeu sortante), depuis Redis, qui n'est pas le service qu'on tue ici.
//
// Contre la pile RÉELLE démarrée par `make up` : ce fichier tue et redémarre le VRAI conteneur
// `realtime` (`docker compose kill`, SIGKILL -- jamais un arrêt propre) puis le VRAI conteneur
// `redis`. Rejouer les mêmes assertions sans jamais tuer le processus ne prouverait que la
// logique métier, pas la survie au redémarrage -- même distinction que D62 pour les scripts
// d'exploitation (CLAUDE.md : « un script n'est vérifié que lancé comme script, un mécanisme
// n'est vérifié que déclenché pour de vrai »).
//
// **Isolé du reste de la suite.** Ce fichier est le seul de ce dépôt qui interrompt un service
// partagé -- le faire tourner concurremment avec `concurrency/*`, `auth/*` ou `http-contract/*`
// casserait des tests qui supposent `realtime` et `redis` continûment sains. D'où un script npm
// séparé (`test:resilience`, test/package.json) plutôt qu'un ajout au glob principal, et une
// étape dédiée dans `make test` (Makefile), APRÈS le reste -- même précédent que
// `test/config/build-web-bundle.test.sh`.
//
// **Écart signalé** (`amoa/questions/L3-14.md`, sur master) : la spécification décrit une
// variante « tuer le service entre la fin de course et l'écriture Odoo, l'événement doit être en
// file et rejoué (L3-12) ». Mais L3-12, corrigé le 13 septembre (amoa/specs/L3-temps-reel.md),
// établit que la fin de course n'est PAS portée par la file : Odoo LIT le relevé de trajet
// (`realtime_client.fetch_ride_measurement`) avant sa propre transition -- il n'y a rien à
// mettre en file pour cet événement précis, et `OUTBOX_ENTRY_TYPES` (services/realtime/src/odoo/
// outbox.ts) ne porte que `driver-accepted`/`driver-rejected`. La variante ci-dessous exerce
// donc CET événement -- le seul que la file porte réellement -- plutôt que la fin de course que
// la spécification nommait.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Redis from 'ioredis';

import {
  approveDriver,
  callRideEndpoint,
  createRideRequest,
  execute,
  readRideState,
  signIn,
} from '../concurrency/helpers/odoo-session';
import {
  acceptProposalOverWs,
  bringDriverOnline,
  makeDriverSelectable,
  resync,
  sendPosition,
  takeDriverOffline,
} from '../concurrency/helpers/realtime';
// Fonction RÉELLE de production (services/realtime/src/odoo/outbox.ts), jamais une
// réimplémentation à la main du format d'entrée -- voir la variante 2 plus bas pour le motif :
// c'est exactement ce que le processus tué aurait exécuté juste avant de disparaître.
import { enqueueOutboxEntry } from '../../services/realtime/src/odoo/outbox';

const RIDE_ORIGIN = { latitude: 4.05, longitude: 9.7 };
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const REALTIME_HTTP_ROOT = process.env.REALTIME_HTTP_ROOT ?? 'http://localhost:3000';

// Résolus depuis __dirname, jamais depuis le répertoire courant du processus (odoo-session.ts,
// même motif) : `npm run test:resilience -w @babana/concurrency-tests` exécute ce fichier avec
// `test/` comme répertoire courant, pas `code/`.
const COMPOSE_FILE = path.resolve(__dirname, '../../infra/compose.yaml');
const COMPOSE_DEV_FILE = path.resolve(__dirname, '../../infra/compose.dev.yaml');
const ENV_FILE = path.resolve(__dirname, '../../infra/env/.env');

function dockerCompose(...args: string[]): void {
  execFileSync(
    'docker',
    ['compose', '-f', COMPOSE_FILE, '-f', COMPOSE_DEV_FILE, '--env-file', ENV_FILE, ...args],
    { stdio: 'pipe' }
  );
}

/** SIGKILL (`docker compose kill`, jamais `stop`) : c'est le scénario que la spécification
 * décrit -- « coupure du service temps réel en pleine course » -- pas un arrêt propre que le
 * code aurait pu anticiper avec un gestionnaire de SIGTERM. */
function killService(name: string): void {
  dockerCompose('kill', name);
}

function startService(name: string): void {
  dockerCompose('start', name);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() >= deadline) throw new Error(`délai dépassé en attendant : ${label}`);
    await sleep(500);
  }
}

async function waitForRealtimeUnreachable(timeoutMs = 10_000): Promise<void> {
  await waitUntil(
    async () => {
      try {
        await fetch(`${REALTIME_HTTP_ROOT}/health`, { signal: AbortSignal.timeout(1000) });
        return false;
      } catch {
        return true;
      }
    },
    timeoutMs,
    'le service temps réel devient injoignable après le SIGKILL'
  );
}

async function waitForRealtimeHealthy(timeoutMs = 30_000): Promise<void> {
  await waitUntil(
    async () => {
      const response = await fetch(`${REALTIME_HTTP_ROOT}/health`, { signal: AbortSignal.timeout(2000) });
      return response.ok;
    },
    timeoutMs,
    'le service temps réel redevient sain (GET /health)'
  );
}

async function waitForRedisHealthy(timeoutMs = 30_000): Promise<void> {
  await waitUntil(
    async () => {
      const redis = new Redis(REDIS_URL, { lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 1 });
      try {
        await redis.connect();
        return (await redis.ping()) === 'PONG';
      } finally {
        redis.disconnect();
      }
    },
    timeoutMs,
    'Redis redevient sain (PING)'
  );
}

async function rideFields<T extends string[]>(
  ridePublicId: string,
  fields: T
): Promise<Record<T[number], unknown>> {
  const rideIds = await execute<number[]>('babana.ride', 'search', [[['public_id', '=', ridePublicId]]]);
  const [record] = await execute<Record<string, unknown>[]>('babana.ride', 'read', [rideIds, fields]);
  return record as Record<T[number], unknown>;
}

// Filet de sécurité en fin de fichier : si une assertion échoue en cours de route, un service
// laissé éteint casserait silencieusement tout le reste de `make test` qui suit cette étape.
// `start` sur un conteneur déjà démarré ne fait rien (idempotent) -- sûr à appeler dans tous les
// cas.
after(async () => {
  try {
    startService('realtime');
    startService('redis');
    await Promise.all([waitForRealtimeHealthy(), waitForRedisHealthy()]);
  } catch (err) {
    console.error('[L3-14] filet de sécurité après tests : impossible de rétablir la pile :', err);
  }
});

describe('L3-14 -- redémarrage brutal du service temps réel en pleine course', () => {
  test(
    'une course démarrée, coupée par un SIGKILL, redémarrée, se retrouve et se termine correctement (critères 1 et 2)',
    { timeout: 120_000 },
    async () => {
      const clientSession = await signIn(`sub-l314-client-${randomUUID()}`, 'client');
      const driverSession = await signIn(`sub-l314-driver-${randomUUID()}`, 'driver');
      const { driverPublicId } = await approveDriver(driverSession, 'l314');

      const { driverSocket: firstDriverSocket, clientSockets } = await makeDriverSelectable(
        driverSession.accessToken,
        driverPublicId,
        RIDE_ORIGIN,
        [clientSession.accessToken]
      );

      const { ridePublicId } = await createRideRequest(clientSession);
      const select = await callRideEndpoint(`/rides/${ridePublicId}/select-driver`, clientSession, {
        driverId: driverPublicId,
      });
      assert.equal(select.status, 200, `select-driver a échoué en préparation : ${JSON.stringify(select.body)}`);

      await acceptProposalOverWs(firstDriverSocket, ridePublicId);
      assert.equal(await readRideState(ridePublicId), 'assigned');

      const start = await callRideEndpoint(`/rides/${ridePublicId}/start`, driverSession);
      assert.equal(start.status, 200, `start a échoué en préparation : ${JSON.stringify(start.body)}`);
      assert.equal(await readRideState(ridePublicId), 'in_progress');

      // Quelques positions AVANT la coupure -- chaque segment fait environ 12 m (au-dessus
      // d'ACCUMULATION_MIN_SEGMENT_METERS, 5 m par défaut) envoyé à ~1 seconde d'écart, donc une
      // vitesse implicite d'environ 12 m/s, largement sous POSITION_MAX_IMPLIED_SPEED_MPS (38,9
      // m/s par défaut, config.ts) -- un premier essai avec de plus grands sauts envoyés toutes
      // les 300 ms impliquait environ 290 m/s et se faisait rejeter par L3-02 (silencieusement :
      // measured restait vrai sur le seul premier point, mais la distance à zéro).
      const POSITION_INTERVAL_MS = 1000;
      const beforeCut = [
        { latitude: 4.0505, longitude: 9.7006 },
        { latitude: 4.05057, longitude: 9.70068 },
        { latitude: 4.05064, longitude: 9.70076 },
      ];
      for (const point of beforeCut) {
        sendPosition(firstDriverSocket, point);
        await sleep(POSITION_INTERVAL_MS);
      }

      // --- La coupure : SIGKILL, pas un arrêt propre --------------------------------------
      killService('realtime');
      await waitForRealtimeUnreachable();

      startService('realtime');
      await waitForRealtimeHealthy();

      // --- Reconnexion (L3-11) : nouvelle connexion, l'ancienne est morte avec le processus -
      const driverSocket = await bringDriverOnline(driverSession.accessToken, beforeCut[beforeCut.length - 1]!);

      // C'est ce message qui prouve la reconstruction depuis Odoo (D27), pas un état en mémoire
      // qui n'aurait pas dû survivre au redémarrage (invariant 1) : rien de local ne pourrait
      // répondre correctement ici, le processus qui tenait la connexion précédente n'existe
      // plus.
      const synced = await resync(driverSocket, ridePublicId);
      assert.equal(
        synced.activeRideId,
        ridePublicId,
        'la resynchronisation doit retrouver la course en cours, reconstruite depuis Odoo'
      );
      assert.equal(synced.activeRideState, 'in_progress');
      assert.equal(synced.rideStateKnown, true);

      // Encore quelques positions APRÈS le redémarrage -- même cadence que ci-dessus (~12 m par
      // segment, ~1 s d'écart). L'accumulation doit REPRENDRE, pas repartir de zéro
      // (tracking/accumulator.ts, section « Restart-safe (L3-14) » : tout l'état vit dans un
      // seul HASH Redis, jamais en mémoire du processus).
      const afterRestart = [
        { latitude: 4.05071, longitude: 9.70084 },
        { latitude: 4.05078, longitude: 9.70092 },
        { latitude: 4.05085, longitude: 9.701 },
      ];
      for (const point of afterRestart) {
        sendPosition(driverSocket, point);
        await sleep(POSITION_INTERVAL_MS);
      }
      // Laisse le temps au dernier point d'être intégré avant la lecture de fin de course.
      await sleep(500);

      const complete = await callRideEndpoint(`/rides/${ridePublicId}/complete`, driverSession, {});
      assert.equal(complete.status, 200, `complete a échoué : ${JSON.stringify(complete.body)}`);
      assert.equal(await readRideState(ridePublicId), 'completed');

      // La preuve, côté Odoo (source de vérité, D27) : la course a été mesurée, et la distance
      // accumulée dépasse ce qu'AUCUNE des deux moitiés (avant/après coupure) n'aurait pu
      // produire seule (2 segments × ~12 m ≈ 24 m chacune, en dessous du seuil ci-dessous) --
      // la franchir exige que les deux moitiés se soient RÉELLEMENT additionnées, la preuve que
      // l'accumulation d'avant la coupure n'a pas été perdue et que celle d'après a bien repris
      // dessus plutôt que de repartir de zéro.
      const measured = await rideFields(ridePublicId, ['trip_measured', 'actual_distance_km']);
      assert.equal(measured.trip_measured, true, "la course doit être mesurée -- l'accumulation ne doit pas s'être perdue dans le redémarrage");
      const distanceMeters = (measured.actual_distance_km as number) * 1000;
      assert.ok(
        distanceMeters > 30,
        `distance mesurée attendue > 30 m (preuve que les deux moitiés se sont additionnées), obtenu ${distanceMeters} m`
      );

      const settle = await callRideEndpoint(`/rides/${ridePublicId}/settle`, driverSession, {
        amountCollected: 1500,
      });
      assert.equal(settle.status, 200, `settle a échoué : ${JSON.stringify(settle.body)}`);
      assert.equal(await readRideState(ridePublicId), 'settled', 'aucune course confirmée ne doit être perdue (critère 2)');

      await takeDriverOffline(driverSocket);
      for (const socket of clientSockets) socket.close();
    }
  );
});

describe('L3-14 -- variante : événement en file au moment de la coupure (L3-12)', () => {
  test(
    "une entrée de file posée juste avant que le service ne tombe est rejouée au redémarrage, sans intervention (critère 3, appliqué à driver-accepted -- seul type réellement porté par la file, voir l'écart en tête de fichier)",
    { timeout: 60_000 },
    async () => {
      const clientSession = await signIn(`sub-l314-outbox-client-${randomUUID()}`, 'client');
      const driverSession = await signIn(`sub-l314-outbox-driver-${randomUUID()}`, 'driver');
      const { driverPublicId } = await approveDriver(driverSession, 'l314-outbox');

      const { driverSocket, clientSockets } = await makeDriverSelectable(
        driverSession.accessToken,
        driverPublicId,
        RIDE_ORIGIN,
        [clientSession.accessToken]
      );

      const { ridePublicId } = await createRideRequest(clientSession);
      const select = await callRideEndpoint(`/rides/${ridePublicId}/select-driver`, clientSession, {
        driverId: driverPublicId,
      });
      assert.equal(select.status, 200, `select-driver a échoué en préparation : ${JSON.stringify(select.body)}`);
      assert.equal(await readRideState(ridePublicId), 'proposed');

      // --- La coupure : le processus qui aurait dû tenter l'appel Odoo n'existe plus --------
      killService('realtime');
      await waitForRealtimeUnreachable();

      // Ce que le processus tué aurait fait juste avant de disparaître (odoo/rides.ts::
      // reportDriverAccepted -> odoo/outbox.ts::enqueueOutboxEntry) : persister l'INTENTION
      // d'écriture dans Redis avant toute tentative HTTP (odoo/outbox.ts, docstring : « chaque
      // intention d'écriture est posée dans Redis AVANT la première tentative »). Un vrai crash
      // survenu entre les deux laisse exactement cet état -- l'entrée posée, aucune tentative
      // encore faite -- ce que cet appel reconstitue fidèlement, avec la fonction RÉELLE plutôt
      // qu'une main réimplémentation de son format.
      const redis = new Redis(REDIS_URL);
      try {
        await enqueueOutboxEntry(
          redis,
          'driver-accepted',
          `/api/internal/rides/${encodeURIComponent(ridePublicId)}/driver-accepted`,
          { driverId: driverPublicId }
        );
      } finally {
        redis.disconnect();
      }

      // Toujours 'proposed' : seule l'INTENTION est posée, l'écriture elle-même n'a pas encore
      // eu lieu -- exactement la distinction que L3-12 protège (« ce n'est pas un état de
      // course, c'est une intention d'écriture en attente »).
      assert.equal(await readRideState(ridePublicId), 'proposed');

      startService('realtime');
      await waitForRealtimeHealthy();

      // Rejouée par le PROPRE passage périodique du processus fraîchement redémarré
      // (`startOutboxWorker`, index.ts, OUTBOX_POLL_INTERVAL_SECONDS = 5 s par défaut) --
      // aucune action supplémentaire n'est prise ici : c'est le mécanisme, pas ce test, qui doit
      // faire le travail.
      await waitUntil(
        async () => (await readRideState(ridePublicId)) === 'assigned',
        30_000,
        `l'entrée de file posée avant la coupure est rejouée après redémarrage (course ${ridePublicId} -> assigned)`
      );

      await takeDriverOffline(driverSocket);
      for (const socket of clientSockets) socket.close();
    }
  );
});

describe('L3-14 -- variante : perte de Redis pendant une course déjà affectée', () => {
  test(
    "la perte de Redis ne fait perdre aucune course déjà affectée dans Odoo (critère 4 -- la perte des positions de l'instant est acceptable, la perte de la course ne l'est pas)",
    { timeout: 60_000 },
    async () => {
      const clientSession = await signIn(`sub-l314-redis-client-${randomUUID()}`, 'client');
      const driverSession = await signIn(`sub-l314-redis-driver-${randomUUID()}`, 'driver');
      const { driverPublicId } = await approveDriver(driverSession, 'l314-redis');

      const { driverSocket, clientSockets } = await makeDriverSelectable(
        driverSession.accessToken,
        driverPublicId,
        RIDE_ORIGIN,
        [clientSession.accessToken]
      );

      const { ridePublicId } = await createRideRequest(clientSession);
      const select = await callRideEndpoint(`/rides/${ridePublicId}/select-driver`, clientSession, {
        driverId: driverPublicId,
      });
      assert.equal(select.status, 200, `select-driver a échoué en préparation : ${JSON.stringify(select.body)}`);
      await acceptProposalOverWs(driverSocket, ridePublicId);
      assert.equal(await readRideState(ridePublicId), 'assigned', 'précondition : course affectée avant de couper Redis');

      // --- Redis perd tout (infra/compose.yaml : --appendonly no, aucune persistance) --------
      killService('redis');
      startService('redis');
      await waitForRedisHealthy();
      // `realtime` lui-même n'a jamais été coupé ici -- seule sa dépendance Redis l'a été.
      // ioredis (le client réel du service, pas celui de ce test) reconnecte de lui-même ; on
      // attend juste que /health le reflète avant de continuer.
      await waitForRealtimeHealthy();

      // La preuve : la course déjà affectée n'a pas disparu. Elle vit dans Odoo (D27), pas dans
      // Redis -- rien de ce que Redis vient de perdre (pool géo-indexé, réservation, marqueur
      // d'engagement, position) n'est un état MÉTIER de la course (invariant 1).
      assert.equal(
        await readRideState(ridePublicId),
        'assigned',
        'la course affectée doit survivre à la perte de Redis'
      );

      // Et elle reste utilisable derrière : démarrer, terminer sans exiger de mesure (measured
      // peut être faux ici, D30 -- aucune position n'a été envoyée depuis la reprise de Redis,
      // ce n'est pas ce que ce critère vérifie). Seule l'absence de perte de la COURSE compte.
      const start = await callRideEndpoint(`/rides/${ridePublicId}/start`, driverSession);
      assert.equal(start.status, 200, `start a échoué : ${JSON.stringify(start.body)}`);
      const complete = await callRideEndpoint(`/rides/${ridePublicId}/complete`, driverSession, {});
      assert.equal(complete.status, 200, `complete a échoué : ${JSON.stringify(complete.body)}`);
      assert.equal(await readRideState(ridePublicId), 'completed');

      await takeDriverOffline(driverSocket);
      for (const socket of clientSockets) socket.close();
    }
  );
});
