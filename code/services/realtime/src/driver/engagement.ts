import type Redis from 'ioredis';
import * as rideState from '../ride/state';

/**
 * Façade au-dessus de l'état de course unifié (`ride/state.ts`, L3-18) -- même signature
 * publique qu'avant l'unification (`setEngaged`/`clearEngaged`/`isEngaged`), pour que ses
 * appelants (`driver/reconcile.ts`) et ses tests n'aient pas à changer.
 *
 * Marqueur d'engagement d'un chauffeur sur une course (L3-07, D26) : état DISTINCT de la
 * réservation, posé à l'acceptation, EN REMPLACEMENT de la réservation (voir `ride/state.lua`,
 * action `resolve`). Sans expiration -- une course n'a pas de durée prévisible, un embouteillage
 * à Douala ne doit pas remettre au pool un chauffeur qui transporte un client. Unifier le
 * stockage n'a pas unifié les échéances (L3-18, "le point délicat") : l'engagement reste sans TTL.
 *
 * `setEngaged`/`clearEngaged` restent des écritures directes, volontairement -- comme avant
 * l'unification : `driver/reconcile.ts` les appelle sans passer par le cycle réservation ->
 * résolution (L3-17, critère 7, réparation d'un écart contre Odoo, pas une nouvelle réservation
 * disputée). Passent par `ride/state.lua` (actions `force-engage`/`release`) : aucune écriture
 * brute sur la clé unifiée ne subsiste hors de ce script, dans tout le service (même règle,
 * même vérification que le critère 6 de L3-06 -- L3-18, critère 2).
 */
export async function setEngaged(redis: Redis, driverId: string): Promise<void> {
  await rideState.forceEngaged(redis, driverId);
}

export async function clearEngaged(redis: Redis, driverId: string): Promise<void> {
  await rideState.release(redis, driverId);
}

export async function isEngaged(redis: Redis, driverId: string): Promise<boolean> {
  return rideState.isEngaged(redis, driverId);
}
