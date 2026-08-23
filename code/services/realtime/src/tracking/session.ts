import type Redis from 'ioredis';

/**
 * L'association course/client/chauffeur nécessaire au suivi (L3-09) -- rien de tout cela ne
 * survivait à l'acceptation avant ce soir : `proposal/lifecycle.ts` consommait déjà le
 * `clientUserId` de la proposition à l'acceptation (`consumeRecord`), et le point de départ
 * n'était conservé nulle part. Sans cette association, `ride.track` n'a ni de quoi vérifier
 * qu'un client suit une course qui est la sienne (spécification, critère 2, "vérifié à chaque
 * diffusion, pas seulement à l'abonnement"), ni de quoi savoir quel chauffeur suivre.
 *
 * Posée par `proposal/lifecycle.ts::accept`, au même moment que le marqueur d'engagement (L3-07,
 * D26) -- même durée de vie que lui, effacée au même geste (`endRideSessionForDriver`, appelé
 * depuis `http/internal.ts::handleClearEngagement`, fin de course ou annulation). Pas de TTL :
 * une course n'a pas de durée prévisible, un embouteillage à Douala ne doit pas faire disparaître
 * le suivi en pleine approche (même raisonnement que l'engagement lui-même).
 *
 * Invariant 1 : Redis uniquement, jamais une écriture Odoo -- cette association est éphémère,
 * pas un événement métier.
 */
export interface RideSession {
  clientUserId: string;
  driverId: string;
  /** Point de prise en charge (L3-09, ETA d'approche) -- gelé à l'acceptation, comme le montant
   * et la distance de référence côté Odoo (L2-04) : le suivi mesure l'approche vers CE point,
   * jamais recalculé depuis une destination qui aurait changé entre-temps. */
  origin: { latitude: number; longitude: number };
}

const RIDE_SESSION_KEY_PREFIX = 'babana:ride:session:';
const DRIVER_ACTIVE_RIDE_KEY_PREFIX = 'babana:driver:active-ride:';

function rideSessionKey(rideId: string): string {
  return `${RIDE_SESSION_KEY_PREFIX}${rideId}`;
}

function driverActiveRideKey(driverId: string): string {
  return `${DRIVER_ACTIVE_RIDE_KEY_PREFIX}${driverId}`;
}

export async function startRideSession(redis: Redis, rideId: string, session: RideSession): Promise<void> {
  await redis.set(rideSessionKey(rideId), JSON.stringify(session));
  await redis.set(driverActiveRideKey(session.driverId), rideId);
}

export async function getRideSession(redis: Redis, rideId: string): Promise<RideSession | null> {
  const raw = await redis.get(rideSessionKey(rideId));
  if (!raw) return null;
  return JSON.parse(raw) as RideSession;
}

/** Efface la session par chauffeur, pas par course : `handleClearEngagement` (fin de course ou
 * annulation, L3-17) ne connaît que `driverId`, jamais `rideId` -- même contrat que
 * `clearEngaged` qu'il appelle déjà, pas un second paramètre à faire porter à Odoo pour ça. */
export async function endRideSessionForDriver(redis: Redis, driverId: string): Promise<void> {
  const rideId = await redis.get(driverActiveRideKey(driverId));
  await redis.del(driverActiveRideKey(driverId));
  if (rideId) await redis.del(rideSessionKey(rideId));
}
