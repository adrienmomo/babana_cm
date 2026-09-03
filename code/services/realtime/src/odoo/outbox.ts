import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { Config } from '../config';
import { callOdooOnce } from './client';

/**
 * File d'attente persistante des appels sortants vers Odoo (L3-12). Trou signalé depuis le 20
 * août (amoa/questions/L3-17.md §1) : `odoo/rides.ts::reportDriverAccepted`/`reportDriverRejected`
 * appelaient `callOdoo` directement -- trois réessais EN MÉMOIRE (L0-04), rien de plus. Un refus
 * dont l'appel Odoo échoue plus longtemps que ces trois réessais laissait la course bloquée en
 * `proposed` pour toujours : `action_propose` n'accepte que `requested`/`rejected` en état
 * source, plus aucune proposition n'est alors possible sur cette course.
 *
 * **Persistante** : chaque intention d'écriture est posée dans Redis AVANT la première tentative
 * (`enqueue`, ci-dessous), donc un redémarrage du service entre l'enregistrement et le succès de
 * l'appel ne perd rien -- `startOutboxWorker` (index.ts) reprend au démarrage suivant exactement
 * comme un passage périodique ordinaire trouverait une entrée en retard. C'est la seule donnée
 * que ce service persiste ; elle ne contredit pas l'invariant 1 (aucune donnée MÉTIER durable) :
 * ce n'est pas un état de course, c'est une intention d'écriture en attente (spécification).
 *
 * **Idempotente côté Odoo** : chaque tentative porte l'identifiant de l'entrée en `Idempotency-
 * Key` (le mécanisme de L4-03/C-01R, `_common.run_idempotent` -- désormais câblé sur
 * `controllers/internal.py::driver_accepted`/`driver_rejected`, qui ne le portaient pas avant ce
 * soir). Rejouer une entrée déjà appliquée renvoie la réponse mise en cache par Odoo, sans
 * réexécuter la transition -- jamais une erreur.
 *
 * **Une entrée qui échoue indéfiniment se voit** : `getOutboxStats` expose la taille de la file
 * et l'âge de sa plus ancienne entrée, `drainDueEntries` alerte (journal) si l'une ou l'autre
 * dépasse son seuil, ou si une entrée précise dépasse son nombre de tentatives -- même principe
 * que `driver/reconcile.ts` (L3-17) : une file qui grossit signifie que des courses ne
 * s'enregistrent pas, et le dire est aussi important que réessayer.
 *
 * Ne pas confondre avec la file de `packages/api-client` (L3-11) : celle-là est côté app, pour
 * les actions émises hors connexion ; celle-ci est côté service, pour les appels sortants vers
 * Odoo décrits par la règle de partition (`01-architecture.md` §2).
 */

const OUTBOX_QUEUE_KEY = 'babana:outbox:queue';
const OUTBOX_ENTRY_KEY_PREFIX = 'babana:outbox:entry:';

function outboxEntryKey(id: string): string {
  return `${OUTBOX_ENTRY_KEY_PREFIX}${id}`;
}

/**
 * Deux types aujourd'hui -- affectation (acceptation) et refus/expiration -- pas les quatre
 * écritures de la version révisée de la règle de partition (`01-architecture.md` §2, révision du
 * 10 août) : la création de la demande et l'encaissement sont déclenchés par l'app directement
 * vers Odoo (spécification L3-12, points 1 et 4) ; la fin de course transmet distance/durée/
 * tracé par un chemin LU par Odoo avant sa propre transition (`fetch_ride_measurement`,
 * `services/realtime_client.py`, même exception que `reserve_and_propose`), jamais par un appel
 * sortant que ce service initierait. Voir amoa/questions/L3-12.md pour le détail de cet écart --
 * un cinquième type ajouté ici sans y répondre casse `test_outbox_carries_exactly_the_writes_it_
 * is_meant_to_carry` (test/outbox.test.ts), délibérément -- `OUTBOX_ENTRY_TYPES` ci-dessous, pas
 * seulement le type TypeScript, pour que ce test-là ait quelque chose à énumérer à l'exécution.
 */
export const OUTBOX_ENTRY_TYPES = ['driver-accepted', 'driver-rejected'] as const;
export type OutboxEntryType = (typeof OUTBOX_ENTRY_TYPES)[number];

export interface OutboxEntry {
  id: string;
  type: OutboxEntryType;
  path: string;
  body: unknown;
  attempts: number;
  enqueuedAt: number;
  nextAttemptAt: number;
  lastError: string | null;
}

export type OutboxAttemptOutcome = 'applied' | 'retry';

const inFlight = new Set<string>();

async function persistEntry(redis: Redis, entry: OutboxEntry): Promise<void> {
  await Promise.all([
    redis.set(outboxEntryKey(entry.id), JSON.stringify(entry)),
    redis.zadd(OUTBOX_QUEUE_KEY, entry.nextAttemptAt, entry.id),
  ]);
}

async function removeEntry(redis: Redis, id: string): Promise<void> {
  await Promise.all([redis.del(outboxEntryKey(id)), redis.zrem(OUTBOX_QUEUE_KEY, id)]);
}

/**
 * Pose l'entrée dans Redis -- AVANT toute tentative HTTP (voir le raisonnement de persistance
 * ci-dessus). `nextAttemptAt` vaut immédiatement `now` : rien n'empêche une tentative
 * immédiate juste après (`reportOutboxWrite`, plus bas), c'est seulement le filet qui doit
 * exister avant elle.
 */
export async function enqueueOutboxEntry(
  redis: Redis,
  type: OutboxEntryType,
  path: string,
  body: unknown
): Promise<OutboxEntry> {
  if (!(OUTBOX_ENTRY_TYPES as readonly string[]).includes(type)) {
    // Garde d'exécution, pas seulement de typage (le typage ne protège pas un appelant JS, ou un
    // `as` mal placé) : voir OUTBOX_ENTRY_TYPES ci-dessus pour ce que ce cinquième type devrait
    // d'abord répondre (amoa/questions/L3-12.md).
    throw new Error(`odoo/outbox.ts : type d'entrée inconnu '${type}' -- voir OUTBOX_ENTRY_TYPES`);
  }
  const now = Date.now();
  const entry: OutboxEntry = {
    id: randomUUID(),
    type,
    path,
    body,
    attempts: 0,
    enqueuedAt: now,
    nextAttemptAt: now,
    lastError: null,
  };
  await persistEntry(redis, entry);
  return entry;
}

function isAlreadyApplied(status: number, body: unknown): boolean {
  if (status >= 200 && status < 300) return true;
  // Rejeu silencieux (spécification, "Odoo rejette silencieusement un identifiant déjà
  // traité") : une transition déjà appliquée par un autre chemin renvoie RIDE_INVALID_
  // TRANSITION -- la réessayer indéfiniment n'aboutirait jamais, la retenir comme un échec
  // masquerait un vrai défaut derrière un faux. Le cas nominal ne passe même pas par ici : la
  // clé d'idempotence (ci-dessous) fait renvoyer la réponse 200 mise en cache par Odoo avant
  // même de réexécuter la transition.
  if (status === 409) {
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    return code === 'RIDE_INVALID_TRANSITION';
  }
  return false;
}

function nextDelayMs(config: Config, attempts: number): number {
  const raw = config.OUTBOX_BASE_DELAY_MS * 2 ** attempts;
  return Math.min(raw, config.OUTBOX_MAX_DELAY_MS);
}

/**
 * Une tentative pour une entrée déjà chargée depuis Redis. Ne lève jamais : une panne réseau ou
 * une erreur HTTP reprogramme l'entrée avec un délai croissant plutôt que de remonter -- c'est le
 * même filet défensif que le reste du service (`proposal/lifecycle.ts`, `driver/reconcile.ts`).
 */
export async function attemptOutboxEntry(
  config: Config,
  redis: Redis,
  entry: OutboxEntry
): Promise<OutboxAttemptOutcome> {
  try {
    const result = await callOdooOnce(config, entry.path, entry.body, {
      'Idempotency-Key': entry.id,
    });
    if (isAlreadyApplied(result.status, result.body)) {
      await removeEntry(redis, entry.id);
      return 'applied';
    }

    const attempts = entry.attempts + 1;
    const updated: OutboxEntry = {
      ...entry,
      attempts,
      nextAttemptAt: Date.now() + nextDelayMs(config, attempts),
      lastError: `Odoo a répondu ${result.status} pour ${entry.path}`,
    };
    await persistEntry(redis, updated);
    if (attempts >= config.OUTBOX_ALERT_ATTEMPTS_THRESHOLD) {
      console.error(
        `[L3-12] entrée de file Odoo en échec répété (${entry.type}, ${attempts} tentatives) :`,
        { id: entry.id, path: entry.path, lastError: updated.lastError }
      );
    }
    return 'retry';
  } catch (err: unknown) {
    const attempts = entry.attempts + 1;
    const updated: OutboxEntry = {
      ...entry,
      attempts,
      nextAttemptAt: Date.now() + nextDelayMs(config, attempts),
      lastError: err instanceof Error ? err.message : String(err),
    };
    await persistEntry(redis, updated);
    if (attempts >= config.OUTBOX_ALERT_ATTEMPTS_THRESHOLD) {
      console.error(
        `[L3-12] entrée de file Odoo en échec répété (${entry.type}, ${attempts} tentatives) :`,
        { id: entry.id, path: entry.path, lastError: updated.lastError }
      );
    }
    return 'retry';
  }
}

async function attemptOutboxEntryById(config: Config, redis: Redis, id: string): Promise<void> {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    const raw = await redis.get(outboxEntryKey(id));
    if (!raw) {
      // Déjà traitée entre le ZRANGEBYSCORE et cette lecture (tentative immédiate concurrente
      // de `reportOutboxWrite`, ou passage précédent) -- rien à faire, l'entrée n'existe plus.
      await redis.zrem(OUTBOX_QUEUE_KEY, id);
      return;
    }
    const entry = JSON.parse(raw) as OutboxEntry;
    await attemptOutboxEntry(config, redis, entry);
  } finally {
    inFlight.delete(id);
  }
}

export interface OutboxStats {
  pending: number;
  oldestAgeMs: number | null;
}

export async function getOutboxStats(redis: Redis): Promise<OutboxStats> {
  const ids = await redis.zrange(OUTBOX_QUEUE_KEY, '0', '-1');
  if (ids.length === 0) return { pending: 0, oldestAgeMs: null };

  const raws = await Promise.all(ids.map((id) => redis.get(outboxEntryKey(id))));
  let oldestEnqueuedAt: number | null = null;
  for (const raw of raws) {
    if (!raw) continue;
    const entry = JSON.parse(raw) as OutboxEntry;
    if (oldestEnqueuedAt === null || entry.enqueuedAt < oldestEnqueuedAt) {
      oldestEnqueuedAt = entry.enqueuedAt;
    }
  }
  return {
    pending: ids.length,
    oldestAgeMs: oldestEnqueuedAt === null ? null : Date.now() - oldestEnqueuedAt,
  };
}

/**
 * Passage périodique (`startOutboxWorker`, appelé une fois depuis index.ts, même patron que
 * `startEngagementReconciliation`) : reprend les entrées dont l'échéance est atteinte -- c'est
 * ce qui fait survivre la file à un redémarrage (une entrée posée avant l'arrêt du service a une
 * échéance déjà dépassée au redémarrage, donc reprise dès le premier passage). Alerte si la file
 * dépasse son seuil (critère d'acceptation 5) -- indépendamment de l'alerte par entrée que
 * `attemptOutboxEntry` émet déjà, celle-ci porte sur la file entière.
 */
export async function drainDueEntries(
  config: Config,
  redis: Redis,
  options: { batchSize?: number } = {}
): Promise<{ processed: number; stats: OutboxStats }> {
  const batchSize = options.batchSize ?? 50;
  const dueIds = await redis.zrangebyscore(
    OUTBOX_QUEUE_KEY,
    '-inf',
    String(Date.now()),
    'LIMIT',
    0,
    batchSize
  );
  for (const id of dueIds) {
    await attemptOutboxEntryById(config, redis, id);
  }

  const stats = await getOutboxStats(redis);
  if (stats.pending >= config.OUTBOX_ALERT_QUEUE_SIZE_THRESHOLD) {
    console.error(
      `[L3-12] file Odoo au-dessus du seuil d'alerte : ${stats.pending} entrée(s) en attente, ` +
        `la plus ancienne depuis ${stats.oldestAgeMs} ms -- des courses ne s'enregistrent pas.`
    );
  }
  return { processed: dueIds.length, stats };
}

/**
 * Point d'entrée pour `odoo/rides.ts` : persiste l'entrée puis tente un envoi immédiat, sans
 * bloquer l'appelant (même contrat que l'ancien `reportDriverAccepted`/`reportDriverRejected`,
 * qui ne s'attendaient jamais -- la résolution atomique côté Redis fait déjà foi pour les deux
 * parties connectées, voir `proposal/lifecycle.ts`). L'échec de la tentative immédiate n'est
 * jamais une erreur ici : l'entrée reste en file, `drainDueEntries` la reprendra.
 */
export function reportOutboxWrite(
  config: Config,
  redis: Redis,
  type: OutboxEntryType,
  path: string,
  body: unknown
): void {
  enqueueOutboxEntry(redis, type, path, body)
    .then((entry) => attemptOutboxEntry(config, redis, entry))
    .catch((err: unknown) => {
      console.error(`[L3-12] échec inattendu de mise en file (${type}, ${path}) :`, err);
    });
}

/**
 * Démarre le passage périodique (appelé une fois depuis index.ts). `unref()` : ne doit jamais
 * empêcher un arrêt propre du processus, même patron que `startEngagementReconciliation`.
 */
export function startOutboxWorker(config: Config, redis: Redis): () => void {
  const timer = setInterval(() => {
    drainDueEntries(config, redis).catch((err: unknown) => {
      console.error("[L3-12] échec du passage de purge de la file Odoo :", err);
    });
  }, config.OUTBOX_POLL_INTERVAL_SECONDS * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
