import { readFileSync } from 'node:fs';
import path from 'node:path';
import type Redis from 'ioredis';
import { AVAILABLE_DRIVERS_KEY } from '../redis/geo-index';
import { proposalRideIdKey } from '../proposal/keys';

/**
 * État de course unifié côté chauffeur (L3-18, D26). Un seul enregistrement Redis par chauffeur
 * (une HASH), remplaçant trois structures distinctes qui portaient chacune un fragment du cycle
 * de vie côté temps réel : la réservation (L3-06, `reservation/reserve.ts`), le marqueur
 * d'engagement (L3-07, `driver/engagement.ts`) et la session de suivi (L3-09,
 * `tracking/session.ts`). Ces trois modules deviennent des façades minces au-dessus de celui-ci
 * -- leurs signatures publiques ne changent pas (aucun de leurs appelants, ni leurs tests, n'a
 * besoin de bouger), seul l'écrivain change.
 *
 * **Portée de l'unification, arbitrée le 23 août** : seules les trois structures ci-dessus. Le
 * drapeau "en ligne" (`driver/availability.ts`, L3-04) et le blocage pour plafond d'encaisse
 * (`driver/cash-guard.ts`, L5-02) restent des clés séparées -- ce sont des états indépendants
 * d'une course, jamais nommés par le contexte de cette tâche. Le script d'éligibilité du pool
 * (`redis/pool-eligibility.lua`) passe donc de quatre clés lues à trois : en ligne, blocage
 * plafond, et cet état unifié -- pas une seule lecture globale.
 *
 * **Les échéances restent distinctes** (le point délicat de la spécification) : une réservation
 * expire (`EXPIRE`, action `reserve` de `state.lua`) ; un engagement n'expire jamais tout seul
 * (`PERSIST`, action `resolve` avec acceptation) -- un embouteillage à Douala ne doit pas remettre
 * au pool un chauffeur qui transporte un client (D26). Unifier la structure ne les a pas unifiées.
 *
 * Un index inverse (`rideOwnerKey`) accompagne l'enregistrement principal, écrit et effacé par le
 * MÊME script -- jamais un second écrivain : le client s'abonne au suivi (`ride.track`) par
 * `rideId` (il ne connaît pas `driverId`), quand tout le reste de cet état est indexé par
 * `driverId` (c'est par ce chauffeur que le script d'éligibilité l'interroge). Sans cet index, il
 * faudrait soit balayer tous les chauffeurs pour trouver celui d'une course, soit indexer
 * l'enregistrement principal par `rideId` et perdre la lecture directe par `driverId` dont
 * l'éligibilité a besoin à chaque position reçue (L3-02, le chemin le plus chaud du service).
 */

export type DriverRideState = 'reserved' | 'engaged';

export interface EngagedSession {
  driverId: string;
  rideId: string;
  clientUserId: string;
  origin: { latitude: number; longitude: number };
}

const RIDE_STATE_KEY_PREFIX = 'babana:driver:ride-state:';
const RIDE_OWNER_KEY_PREFIX = 'babana:ride:owner:';

export function rideStateKey(driverId: string): string {
  return `${RIDE_STATE_KEY_PREFIX}${driverId}`;
}

export function rideOwnerKey(rideId: string): string {
  return `${RIDE_OWNER_KEY_PREFIX}${rideId}`;
}

const STATE_SCRIPT = readFileSync(path.join(__dirname, 'state.lua'), 'utf8');

/**
 * Réservation (L3-06, critère d'acceptation 1) : décision et écriture dans le MÊME script --
 * gate inchangée par rapport à l'ancien `reserve.lua` (ZSCORE/ZREM sur le pool), c'est elle qui
 * garantit qu'une seule tentative simultanée réussit (L3-13). Seule la cible d'écriture change.
 */
export async function reserve(redis: Redis, driverId: string, ttlSeconds: number): Promise<boolean> {
  const result = await redis.eval(
    STATE_SCRIPT,
    2,
    rideStateKey(driverId),
    AVAILABLE_DRIVERS_KEY,
    'reserve',
    driverId,
    ttlSeconds
  );
  return result === 1;
}

/**
 * Résolution (L3-07, critères 1, 4, 5) : accepte, refuse ou expire une proposition. `rideId` vide
 * pour ne pas vérifier (expiration système, qui ne vise pas une course précise -- voir
 * `proposal/lifecycle.ts::expire`). Renvoie `true` si CETTE résolution a pris effet.
 */
export async function resolve(
  redis: Redis,
  driverId: string,
  expectedRideId: string | null,
  accepted: boolean
): Promise<boolean> {
  const result = await redis.eval(
    STATE_SCRIPT,
    3,
    rideStateKey(driverId),
    proposalRideIdKey(driverId),
    rideOwnerKey(expectedRideId ?? ''),
    'resolve',
    expectedRideId ?? '',
    accepted ? '1' : '0',
    driverId
  );
  return result === 1;
}

/**
 * Relâchement inconditionnel (L3-06 critère 4/5, L3-07, L3-17 critère 6) : remet l'état à libre,
 * quel qu'il soit -- annulation d'une proposition tout juste posée, fin de course, ou toute
 * annulation en cours de route. Idempotent, comme les fonctions qu'elle remplace. N'appelle PAS
 * la réintégration au pool elle-même (même contrat que l'ancien `releaseDriver`) : l'appelant
 * (`reservation/reserve.ts`, `http/internal.ts`) décide s'il y a une position connue à réévaluer.
 */
export async function release(redis: Redis, driverId: string): Promise<void> {
  await redis.eval(STATE_SCRIPT, 1, rideStateKey(driverId), 'release', RIDE_OWNER_KEY_PREFIX);
}

/**
 * Attache -- ou établit -- la session de suivi (L3-09) : `rideId`, `clientUserId` et l'origine,
 * lus par l'appelant de production depuis `proposalRecordKey` APRÈS que `resolve(..., true)` a
 * réussi, jamais dans le script Lua lui-même (même séquencement, non atomique entre les deux
 * écritures, que l'ancien `proposal/lifecycle.ts::accept`, qui posait `engagementKey` par
 * `resolve.lua` puis `startRideSession` séparément juste après -- aucune régression d'atomicité
 * introduite ici, seulement un déplacement de la cible d'écriture).
 *
 * Réécrit `state`/`rideId` en plus des champs de session (et pose l'index inverse) plutôt que de
 * supposer qu'un `resolve(..., true)` a déjà eu lieu : un appel isolé (fixture de test, ou tout
 * futur appelant qui court-circuiterait le cycle réservation/résolution) doit établir une session
 * complète à lui seul, exactement comme le faisait l'ancien `startRideSession` avant
 * l'unification. Écriture directe (pas de section critique à protéger : aucun concurrent ne
 * dispute un chauffeur déjà résolu), même exception documentée que `forceEngaged`.
 */
export async function attachEngagedSession(
  redis: Redis,
  driverId: string,
  session: { rideId: string; clientUserId: string; origin: { latitude: number; longitude: number } }
): Promise<void> {
  await redis.hset(rideStateKey(driverId), {
    state: 'engaged',
    rideId: session.rideId,
    clientUserId: session.clientUserId,
    originLat: session.origin.latitude,
    originLng: session.origin.longitude,
  });
  await redis.persist(rideStateKey(driverId));
  await redis.set(rideOwnerKey(session.rideId), driverId);
}

/**
 * Pose l'engagement directement, sans réservation préalable (L3-17, critère 7 -- réconciliation).
 * Inconditionnel, comme l'ancien `setEngaged` : Odoo est la source de vérité (D27), ce script ne
 * dispute rien, il applique. Ne pose ni `rideId` ni l'index inverse -- le suivi reste
 * indisponible pour ce chauffeur tant qu'une vraie acceptation ne les écrit pas (même limite que
 * l'ancien code, jamais aggravée par cette tâche).
 */
export async function forceEngaged(redis: Redis, driverId: string): Promise<void> {
  await redis.eval(STATE_SCRIPT, 1, rideStateKey(driverId), 'force-engage');
}

export async function getState(redis: Redis, driverId: string): Promise<DriverRideState | null> {
  const state = await redis.hget(rideStateKey(driverId), 'state');
  return state === 'reserved' || state === 'engaged' ? state : null;
}

export async function isReserved(redis: Redis, driverId: string): Promise<boolean> {
  return (await getState(redis, driverId)) === 'reserved';
}

export async function isEngaged(redis: Redis, driverId: string): Promise<boolean> {
  return (await getState(redis, driverId)) === 'engaged';
}

/**
 * Session de suivi d'une course engagée (L3-09), retrouvée par `rideId` -- le client ne connaît
 * que lui (`ride.track`, C-02). Passe par l'index inverse (`rideOwnerKey`) pour trouver le
 * chauffeur, puis lit son enregistrement -- deux lectures, jamais une écriture, donc aucune
 * section critique à protéger ici (même raisonnement que l'ancien `getRideSession`).
 */
export async function getEngagedSession(redis: Redis, rideId: string): Promise<EngagedSession | null> {
  const driverId = await redis.get(rideOwnerKey(rideId));
  if (!driverId) return null;

  const record = await redis.hgetall(rideStateKey(driverId));
  if (record.state !== 'engaged' || record.rideId !== rideId) return null;
  if (!record.clientUserId || !record.originLat || !record.originLng) return null;

  return {
    driverId,
    rideId,
    clientUserId: record.clientUserId,
    origin: { latitude: Number(record.originLat), longitude: Number(record.originLng) },
  };
}

/**
 * Balayage des chauffeurs engagés (L3-17 critère 7, réconciliation) -- remplace l'ancien
 * `scanEngagedDriverIds` de `driver/reconcile.ts`, qui balayait `ENGAGEMENT_KEY_PREFIX*`. Balaie
 * désormais l'ensemble des chauffeurs réservés OU engagés (même préfixe pour les deux, la
 * réservation étant temporaire par nature) et filtre sur le champ `state` -- un chauffeur
 * seulement réservé n'est pas orphelin au sens de la réconciliation, qui ne compare qu'à la
 * liste des courses `assigned`/`in_progress` d'Odoo (jamais `proposed`, protégée par
 * l'expiration de la réservation, pas par la réconciliation -- L3-17, critère 7).
 */
export async function scanEngagedDriverIds(redis: Redis): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor = '0';
  do {
    // eslint-disable-next-line no-await-in-loop -- SCAN est intrinsèquement itératif.
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${RIDE_STATE_KEY_PREFIX}*`, 'COUNT', 200);
    cursor = nextCursor;
    // eslint-disable-next-line no-await-in-loop -- lot borné par COUNT ci-dessus, séquentiel
    // pour rester simple ; le pool tient en quelques dizaines de chauffeurs au pilote (L3-16).
    const states = await Promise.all(keys.map((key) => redis.hget(key, 'state')));
    keys.forEach((key, index) => {
      if (states[index] === 'engaged') ids.add(key.slice(RIDE_STATE_KEY_PREFIX.length));
    });
  } while (cursor !== '0');
  return ids;
}

/**
 * Veille d'expiration des réservations (L3-06, critère 5) -- remplace
 * `startReservationExpiryWatcher`, même mécanisme (notifications keyspace Redis), même prudence
 * (`notify-keyspace-events` activé ici, jamais dans l'image Redis -- ce service ne doit dépendre
 * d'aucun réglage externe fait à la main). Seule la clé écoutée change de préfixe. Un engagement
 * n'a pas de TTL : cet événement ne peut jamais concerner un chauffeur engagé, par construction.
 */
export function startStateExpiryWatcher(redis: Redis, onExpired: (driverId: string) => void): () => void {
  const subscriber = redis.duplicate();
  let closed = false;

  redis.config('SET', 'notify-keyspace-events', 'Ex').catch(() => {
    // Filet défensif : si le serveur Redis refuse CONFIG SET (managé, verrouillé en production),
    // les réservations se libèrent alors uniquement via le chemin explicite (critère 4).
  });

  const db = subscriber.options.db ?? 0;
  const expiredChannel = `__keyevent@${db}__:expired`;

  subscriber.subscribe(expiredChannel).catch(() => {});
  subscriber.on('message', (_channel: string, expiredKey: string) => {
    if (closed || !expiredKey.startsWith(RIDE_STATE_KEY_PREFIX)) return;
    onExpired(expiredKey.slice(RIDE_STATE_KEY_PREFIX.length));
  });

  return () => {
    closed = true;
    subscriber.disconnect();
  };
}
