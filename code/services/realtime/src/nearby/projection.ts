import type Redis from 'ioredis';
import { http } from '@babana/contracts';
import type { Config } from '../config';
import { findNearby } from '../redis/geo-index';
import { getDriverProfiles } from '../redis/driver-profiles';

/**
 * Projection des chauffeurs proches (L3-05, D14) : géo-index (L3-03, position + distance) +
 * profil en cache (redis/driver-profiles.ts, L3-16) -> `NearbyDriver` (C-02).
 *
 * **Liste blanche de champs, jamais une exclusion** (piège documenté par la spécification) : le
 * littéral ci-dessous construit chaque champ un par un depuis les sources disponibles. Ajouter un
 * champ à `DriverProfile` ou au résultat de `findNearby` ne l'expose donc PAS automatiquement au
 * client -- il faut l'ajouter ici, explicitement, en connaissance de cause (C2b, critère 4 :
 * aucune donnée personnelle au-delà du prénom, de la photo, de la note et de la gamme de moto).
 *
 * **Un chauffeur disponible mais sans profil en cache reste dans le résultat, champs à `null`
 * (D30).** Un défaut de cache ne doit jamais retirer un chauffeur de la flotte -- seule
 * l'absence de position (donc de distance) l'écarte, `findNearby` ne renvoyant que des candidats
 * positionnés. Voir amoa/questions/REPONSES-2026-08-18.md §2 : l'ancienne règle (omission) a
 * produit un blocage total en production, aucun chauffeur réel ne portant de profil en cache.
 */
export async function projectNearbyDrivers(
  config: Config,
  redis: Redis,
  origin: { latitude: number; longitude: number },
  radiusMeters: number,
  limit: number
): Promise<http.NearbyDriver[]> {
  const candidates = await findNearby(redis, origin, radiusMeters, limit);
  const profiles = await getDriverProfiles(config, redis, candidates.map((c) => c.driverId));

  return candidates.map((candidate) => {
    const profile = profiles.get(candidate.driverId);
    return {
      driverId: candidate.driverId,
      firstName: profile?.firstName ?? null,
      photoUrl: profile?.photoUrl ?? null,
      rating: profile?.rating ?? null,
      motorcycleClass: profile?.motorcycleClass ?? null,
      position: {
        latitude: http.roundToNearbyPrecision(candidate.latitude),
        longitude: http.roundToNearbyPrecision(candidate.longitude),
      },
      distanceMeters: Math.round(candidate.distanceMeters),
    };
  });
}
