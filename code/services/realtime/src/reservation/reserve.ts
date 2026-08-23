import type Redis from 'ioredis';
import * as rideState from '../ride/state';
import { reintegrateIfEligible } from '../redis/pool-eligibility';

/**
 * Façade au-dessus de l'état de course unifié (`ride/state.ts`, L3-18) -- même signature
 * publique qu'avant l'unification, pour que ses appelants (`proposal/lifecycle.ts`) et ses tests
 * (`test/reservation.test.ts`, `test/concurrency/reservation.test.ts`) n'aient pas à changer.
 * Seule la structure de stockage a changé : plus de clé de réservation isolée, un champ `state`
 * dans l'enregistrement unifié par chauffeur.
 *
 * Réservation atomique du chauffeur (L3-06, D10 §C2a) : quand un client sélectionne un
 * chauffeur, le retirer du pool disponible et poser la réservation en une seule opération
 * indivisible. La preuve que ce module est bien indivisible n'est PAS ici : voir
 * test/concurrency/reservation.test.ts (L3-13) -- dont les assertions n'ont pas changé (L3-18,
 * critère 3), la gate d'exclusivité (ZSCORE/ZREM sur le pool, `ride/state.lua`) non plus.
 */

export type ReservationOutcome = { reserved: true } | { reserved: false };

export async function reserveDriver(redis: Redis, driverId: string, ttlSeconds: number): Promise<ReservationOutcome> {
  const reserved = await rideState.reserve(redis, driverId, ttlSeconds);
  return reserved ? { reserved: true } : { reserved: false };
}

/**
 * Remet le chauffeur dans le pool s'il est toujours éligible -- jamais un ajout inconditionnel.
 * Deux appelants : explicitement, à l'échec de l'appel Odoo qui devait suivre la réservation
 * (critère 4) ; et le mécanisme d'expiration ci-dessous (critère 5). Idempotent.
 */
export async function releaseDriver(redis: Redis, driverId: string): Promise<void> {
  await rideState.release(redis, driverId);
  await reintegrateIfEligible(redis, driverId);
}

export async function isReserved(redis: Redis, driverId: string): Promise<boolean> {
  return rideState.isReserved(redis, driverId);
}

/**
 * Écoute l'expiration des réservations (critère 5) via les notifications keyspace de Redis.
 * Un engagement n'a pas de TTL (D26) : cet événement ne peut jamais le concerner.
 */
export function startReservationExpiryWatcher(redis: Redis): () => void {
  return rideState.startStateExpiryWatcher(redis, (driverId) => {
    releaseDriver(redis, driverId).catch(() => {
      // Une panne Redis passagère ici ne doit jamais faire planter le service -- au pire, le
      // chauffeur reste hors du pool jusqu'à sa prochaine bascule en ligne/hors ligne (L3-04).
    });
  });
}
