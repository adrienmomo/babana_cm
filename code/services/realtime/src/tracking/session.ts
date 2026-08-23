import type Redis from 'ioredis';
import * as rideState from '../ride/state';

/**
 * Façade au-dessus de l'état de course unifié (`ride/state.ts`, L3-18) -- même signature
 * publique qu'avant l'unification, pour que `proposal/lifecycle.ts` et `http/internal.ts`
 * (`handleClearEngagement`) n'aient pas à changer leur appel.
 *
 * L'association course/client/chauffeur nécessaire au suivi (L3-09). Posée par
 * `proposal/lifecycle.ts::accept`, au même moment que le marqueur d'engagement (L3-07, D26) --
 * elle vit désormais dans le MÊME enregistrement que lui, plutôt que dans une structure séparée
 * synchronisée à la main : `startRideSession` n'est donc plus qu'un attachement de champs sur un
 * enregistrement déjà passé à 'engaged' par `ride/state.ts::resolve`, jamais une seconde écriture
 * d'état. Pas de TTL : une course n'a pas de durée prévisible (même raisonnement que
 * l'engagement).
 *
 * Invariant 1 : Redis uniquement, jamais une écriture Odoo -- cette association est éphémère,
 * pas un événement métier.
 */
export interface RideSession {
  clientUserId: string;
  driverId: string;
  origin: { latitude: number; longitude: number };
}

export async function startRideSession(
  redis: Redis,
  rideId: string,
  session: { clientUserId: string; driverId: string; origin: { latitude: number; longitude: number } }
): Promise<void> {
  await rideState.attachEngagedSession(redis, session.driverId, {
    rideId,
    clientUserId: session.clientUserId,
    origin: session.origin,
  });
}

export async function getRideSession(redis: Redis, rideId: string): Promise<RideSession | null> {
  const engaged = await rideState.getEngagedSession(redis, rideId);
  if (!engaged) return null;
  return { clientUserId: engaged.clientUserId, driverId: engaged.driverId, origin: engaged.origin };
}

/** Efface la session par chauffeur, pas par course : `handleClearEngagement` (fin de course ou
 * annulation, L3-17) ne connaît que `driverId`, jamais `rideId`. Même geste que l'effacement de
 * l'engagement (`clearEngaged`) -- c'est littéralement le même enregistrement désormais. */
export async function endRideSessionForDriver(redis: Redis, driverId: string): Promise<void> {
  await rideState.release(redis, driverId);
}
