import type Redis from 'ioredis';
import { http } from '@babana/contracts';
import { findNearby } from '../redis/geo-index';

/**
 * Chauffeur proche tel que ce service le manipule : l'identifiant reste interne (exclusion des
 * refusants, `nearby/expand.ts`) et n'est jamais envoyé au client (`toNearbyDriver`).
 */
export interface NearbyCandidate {
  driverId: string;
  position: { latitude: number; longitude: number };
  distanceMeters: number;
}

/**
 * Projection des chauffeurs proches (L3-05) : géo-index (L3-03, position + distance) ->
 * candidats, position déjà arrondie (garde-fou C2b).
 *
 * **Plus aucun profil** (22 octobre) : le serveur choisit le chauffeur, le client ne voit que des
 * points anonymes jusqu'à l'affectation (`NearbyDriverSchema`). Le cache de profils
 * (redis/driver-profiles.ts) ne sert plus qu'à la proposition et à l'affectation. Seule l'absence
 * de position écarte un chauffeur (D30), `findNearby` ne renvoyant que des candidats positionnés.
 */
export async function projectNearbyDrivers(
  redis: Redis,
  origin: { latitude: number; longitude: number },
  radiusMeters: number,
  limit: number
): Promise<NearbyCandidate[]> {
  const candidates = await findNearby(redis, origin, radiusMeters, limit);
  return candidates.map((candidate) => ({
    driverId: candidate.driverId,
    position: {
      latitude: http.roundToNearbyPrecision(candidate.latitude),
      longitude: http.roundToNearbyPrecision(candidate.longitude),
    },
    distanceMeters: Math.round(candidate.distanceMeters),
  }));
}

/**
 * Ce qui part sur le fil : une liste blanche construite champ par champ, jamais une copie du
 * candidat -- un champ ajouté à `NearbyCandidate` n'atteint donc pas le client par accident.
 */
export function toNearbyDriver(candidate: NearbyCandidate): http.NearbyDriver {
  return { position: candidate.position, distanceMeters: candidate.distanceMeters };
}
