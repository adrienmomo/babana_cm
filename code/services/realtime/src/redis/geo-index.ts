import type Redis from 'ioredis';
import { hasFreshPosition } from './positions';

/**
 * Géo-index des chauffeurs disponibles (L3-03) : index géospatial Redis (GEOADD/GEOSEARCH)
 * contenant UNIQUEMENT les chauffeurs éligibles à une proposition -- en ligne, approuvés, sans
 * course en cours, sous leur plafond d'encaisse. L'entrée/la sortie pour ces conditions est
 * décidée par l'appelant (L3-04 pour en ligne/hors ligne ; L3-06/L3-07, hors de ce lot, pour
 * course en cours et réservation) : ce module ne connaît que l'appartenance au pool, jamais la
 * raison métier qui la justifie -- invariant 3 (aucune règle métier dans ce service).
 *
 * L3-05 (les 5 plus proches, hors de ce lot) et L3-06 (réservation atomique) s'appuient sur cette
 * structure : le retrait d'un script Lua unique (L3-06) devra être indivisible -- écrit en
 * sachant que ce retrait est un simple ZREM sur la clé ci-dessous, appelable depuis un script Lua
 * sans autre état à synchroniser.
 */

const AVAILABLE_DRIVERS_KEY = 'babana:drivers:available';

export async function addToPool(
  redis: Redis,
  driverId: string,
  latitude: number,
  longitude: number
): Promise<void> {
  await redis.geoadd(AVAILABLE_DRIVERS_KEY, longitude, latitude, driverId);
}

export async function removeFromPool(redis: Redis, driverId: string): Promise<void> {
  await redis.zrem(AVAILABLE_DRIVERS_KEY, driverId);
}

export async function isInPool(redis: Redis, driverId: string): Promise<boolean> {
  const score = await redis.zscore(AVAILABLE_DRIVERS_KEY, driverId);
  return score !== null;
}

export interface NearbyDriver {
  driverId: string;
  distanceMeters: number;
}

/**
 * Requête par rayon, triée par distance croissante (critère d'acceptation 4). La distance
 * renvoyée est à vol d'oiseau (spécification L3-03) : acceptable pour ordonner quelques
 * chauffeurs proches, un appel de routage par chauffeur serait prohibitif -- ce qui est affiché
 * au client doit être présenté comme une proximité, jamais comme un temps d'arrivée précis.
 *
 * Filtre les candidats dont la position a expiré (L3-02) : `addToPool`/`removeFromPool`
 * n'écoutent aucun événement d'expiration Redis (pas de notification keyspace, hors de ce lot),
 * un chauffeur peut donc rester un court instant dans l'index après l'expiration de sa position
 * -- jamais le renvoyer tant qu'il n'a pas explicitement quitté le pool serait pire qu'un
 * candidat manquant. Nettoyage paresseux : un candidat sans position fraîche est retiré du pool
 * au passage, pour que l'index ne grossisse pas indéfiniment de chauffeurs déconnectés.
 */
export async function findNearby(
  redis: Redis,
  origin: { latitude: number; longitude: number },
  radiusMeters: number,
  limit: number
): Promise<NearbyDriver[]> {
  if (radiusMeters <= 0 || limit <= 0) return [];

  // Sur-échantillonnage : certains candidats seront écartés faute de position fraîche. Un
  // facteur fixe, pas un deuxième aller-retour conditionnel -- assez pour absorber quelques
  // chauffeurs déconnectés sans compliquer l'appel.
  const OVERFETCH_FACTOR = 3;
  const raw = (await redis.geosearch(
    AVAILABLE_DRIVERS_KEY,
    'FROMLONLAT',
    origin.longitude,
    origin.latitude,
    'BYRADIUS',
    radiusMeters,
    'm',
    'ASC',
    'COUNT',
    limit * OVERFETCH_FACTOR,
    'WITHDIST'
  )) as [string, string][];

  const results: NearbyDriver[] = [];
  for (const [driverId, distance] of raw) {
    if (results.length >= limit) break;
    // eslint-disable-next-line no-await-in-loop -- ordre de distance croissante à préserver ;
    // le volume par requête (quelques dizaines de candidats au plus) rend le séquentiel
    // acceptable ici, une parallélisation casserait l'ordre sans bénéfice réel.
    const fresh = await hasFreshPosition(redis, driverId);
    if (!fresh) {
      await removeFromPool(redis, driverId);
      continue;
    }
    results.push({ driverId, distanceMeters: Number(distance) });
  }
  return results;
}
