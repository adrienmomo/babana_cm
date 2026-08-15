import { readFileSync } from 'node:fs';
import path from 'node:path';
import type Redis from 'ioredis';
import { AVAILABLE_DRIVERS_KEY, addToPool } from '../redis/geo-index';
import { getPosition } from '../redis/positions';
import { isMarkedOnline } from '../driver/availability';

/**
 * Réservation atomique du chauffeur (L3-06, D10 §C2a) : quand un client sélectionne un
 * chauffeur, le retirer du pool disponible et poser la réservation en une seule opération
 * indivisible. Sans ça, deux clients qui sélectionnent le même chauffeur au même instant
 * produiraient deux gagnants -- un bug intermittent, invisible en test unitaire, coûteux en
 * production. La preuve que ce module est bien indivisible n'est PAS ici : voir
 * test/concurrency/reservation.test.ts (L3-13).
 */

const RESERVE_SCRIPT = readFileSync(path.join(__dirname, 'reserve.lua'), 'utf8');
const RESERVATION_KEY_PREFIX = 'babana:driver:reservation:';

function reservationKey(driverId: string): string {
  return `${RESERVATION_KEY_PREFIX}${driverId}`;
}

export type ReservationOutcome = { reserved: true } | { reserved: false };

/**
 * Décision et écriture dans le MÊME script Lua (critère d'acceptation 1) -- aucune condition en
 * TypeScript entre une lecture et une écriture. `redis.eval` exécute `reserve.lua` tel quel, une
 * seule fois, sans jamais rappeler ce module depuis le script (pas de boucle, pas de retry ici :
 * un échec est un échec, `DRIVER_ALREADY_TAKEN` au client, qui revient à la sélection).
 */
export async function reserveDriver(redis: Redis, driverId: string, ttlSeconds: number): Promise<ReservationOutcome> {
  const result = await redis.eval(RESERVE_SCRIPT, 2, AVAILABLE_DRIVERS_KEY, reservationKey(driverId), driverId, ttlSeconds);
  return result === 1 ? { reserved: true } : { reserved: false };
}

/**
 * Remet le chauffeur dans le pool s'il est toujours éligible -- en ligne, position fraîche --
 * jamais un ajout inconditionnel (mêmes conditions d'entrée que L3-02/L3-04). Deux appelants :
 * explicitement, à l'échec de l'appel Odoo qui devait suivre la réservation (critère 4) ; et le
 * mécanisme d'expiration ci-dessous (critère 5). Idempotent : relâcher une réservation déjà
 * relâchée ou expirée ne fait rien de plus qu'un GEOADD sans effet visible si le chauffeur est
 * déjà dans le pool.
 *
 * Pas de section critique ici : contrairement à la réservation, personne d'autre ne dispute ce
 * chauffeur au moment du relâchement -- au pire, une expiration et un relâchement explicite se
 * chevauchent, et les deux convergent vers le même état (réservation absente, chauffeur dans le
 * pool s'il est éligible), sans jamais produire deux gagnants.
 */
export async function releaseDriver(redis: Redis, driverId: string): Promise<void> {
  await redis.del(reservationKey(driverId));
  const [online, position] = await Promise.all([isMarkedOnline(redis, driverId), getPosition(redis, driverId)]);
  if (online && position) {
    await addToPool(redis, driverId, position.latitude, position.longitude);
  }
}

export async function isReserved(redis: Redis, driverId: string): Promise<boolean> {
  return (await redis.exists(reservationKey(driverId))) === 1;
}

/**
 * Écoute l'expiration des réservations (critère 5) via les notifications keyspace de Redis --
 * seul mécanisme qui avertit sans sondage actif qu'une clé à TTL vient de disparaître (une
 * réservation qui expire ne déclenche par elle-même aucun ZADD de retour dans le pool ; quelque
 * chose doit le faire). Connexion dédiée en mode abonnement : Redis l'exige, une connexion qui
 * s'abonne ne peut plus exécuter de commande normale sur la même connexion.
 *
 * `notify-keyspace-events` est activé ici plutôt que dans l'image Redis (infra/compose.yaml) :
 * ce service ne doit dépendre d'aucune configuration externe pour fonctionner correctement --
 * même esprit que L3-15 pour la configuration Odoo (défauts qui marchent sans dépendre d'un
 * réglage externe fait à la main).
 */
export function startReservationExpiryWatcher(redis: Redis): () => void {
  const subscriber = redis.duplicate();
  let closed = false;

  redis.config('SET', 'notify-keyspace-events', 'Ex').catch(() => {
    // Filet défensif : si le serveur Redis refuse CONFIG SET (managé, verrouillé en production),
    // les réservations se libèrent alors uniquement via le chemin explicite (critère 4) --
    // dégradé, jamais un plantage du service au démarrage.
  });

  const db = subscriber.options.db ?? 0;
  const expiredChannel = `__keyevent@${db}__:expired`;

  subscriber.subscribe(expiredChannel).catch(() => {});
  subscriber.on('message', (_channel: string, expiredKey: string) => {
    if (closed || !expiredKey.startsWith(RESERVATION_KEY_PREFIX)) return;
    const driverId = expiredKey.slice(RESERVATION_KEY_PREFIX.length);
    releaseDriver(redis, driverId).catch(() => {
      // Une panne Redis passagère ici ne doit jamais faire planter le service -- au pire, le
      // chauffeur reste hors du pool jusqu'à sa prochaine bascule en ligne/hors ligne (L3-04).
    });
  });

  return () => {
    closed = true;
    subscriber.disconnect();
  };
}
