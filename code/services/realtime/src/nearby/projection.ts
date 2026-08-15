import type Redis from 'ioredis';
import { http } from '@babana/contracts';
import { findNearby } from '../redis/geo-index';
import { getDriverProfile } from '../redis/driver-profiles';

/**
 * Projection des chauffeurs proches (L3-05, D14) : géo-index (L3-03, position + distance) +
 * profil en cache (redis/driver-profiles.ts, amoa/questions/L3-05.md) -> `NearbyDriver` (C-02).
 *
 * **Liste blanche de champs, jamais une exclusion** (piège documenté par la spécification) : le
 * littéral ci-dessous construit chaque champ un par un depuis les sources disponibles. Ajouter un
 * champ à `DriverProfile` ou au résultat de `findNearby` ne l'expose donc PAS automatiquement au
 * client -- il faut l'ajouter ici, explicitement, en connaissance de cause (C2b, critère 4 :
 * aucune donnée personnelle au-delà du prénom, de la photo, de la note et de la gamme de moto).
 *
 * Un chauffeur disponible mais sans profil en cache est omis du résultat plutôt que complété par
 * une valeur inventée (amoa/questions/L3-05.md : rien n'écrit encore ce cache en production).
 */
export async function projectNearbyDrivers(
  redis: Redis,
  origin: { latitude: number; longitude: number },
  radiusMeters: number,
  limit: number
): Promise<http.NearbyDriver[]> {
  const candidates = await findNearby(redis, origin, radiusMeters, limit);

  const projected: http.NearbyDriver[] = [];
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop -- ordre de distance croissante à préserver,
    // même raisonnement que findNearby (geo-index.ts) : au plus `limit` candidats par appel.
    const profile = await getDriverProfile(redis, candidate.driverId);
    if (!profile) continue;

    projected.push({
      driverId: candidate.driverId,
      firstName: profile.firstName,
      photoUrl: profile.photoUrl,
      rating: profile.rating,
      motorcycleClass: profile.motorcycleClass,
      position: {
        latitude: http.roundToNearbyPrecision(candidate.latitude),
        longitude: http.roundToNearbyPrecision(candidate.longitude),
      },
      distanceMeters: Math.round(candidate.distanceMeters),
    });
  }
  return projected;
}
