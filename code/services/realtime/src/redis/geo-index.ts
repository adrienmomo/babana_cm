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

// Exportée pour L3-06 (ride/state.lua) : le retrait atomique d'un chauffeur réservé est
// un simple ZREM sur cette même clé, exécuté depuis le script Lua -- une seule définition, pas
// une chaîne dupliquée qui pourrait diverger.
export const AVAILABLE_DRIVERS_KEY = 'babana:drivers:available';

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
  latitude: number;
  longitude: number;
}

// Sur-échantillonnage de départ : certains candidats seront écartés faute de position fraîche.
const OVERFETCH_FACTOR = 3;
// Plafond du doublement ci-dessous (L3-05, amoa/questions/REPONSES-2026-08-16.md §1 fin) : borne
// le nombre d'allers-retours Redis même si le pool se comporte de façon inattendue. 3 * 2^3 = 24
// -- largement suffisant pour atteindre un pool entier à l'échelle d'un pilote, sans boucler sans
// fin sur un géo-index anormalement clairsemé.
const OVERFETCH_MAX_MULTIPLIER = OVERFETCH_FACTOR * 8;

/**
 * Requête par rayon, triée par distance croissante (critère d'acceptation 4). La distance
 * renvoyée est à vol d'oiseau (spécification L3-03) : acceptable pour ordonner quelques
 * chauffeurs proches, un appel de routage par chauffeur serait prohibitif -- ce qui est affiché
 * au client doit être présenté comme une proximité, jamais comme un temps d'arrivée précis.
 *
 * Filtre les candidats dont la position a expiré (L3-02) : `addEligibleToPool`/`removeFromPool`
 * n'écoutent aucun événement d'expiration Redis (pas de notification keyspace, hors de ce lot),
 * un chauffeur peut donc rester un court instant dans l'index après l'expiration de sa position
 * -- jamais le renvoyer tant qu'il n'a pas explicitement quitté le pool serait pire qu'un
 * candidat manquant. Nettoyage paresseux : un candidat sans position fraîche est retiré du pool
 * au passage, pour que l'index ne grossisse pas indéfiniment de chauffeurs déconnectés.
 *
 * **Complète jusqu'à `limit`** (L3-05, ajouté le 16 août -- amoa/questions/REPONSES-2026-08-16.md
 * §1 fin) : le sur-échantillonnage initial suppose qu'au plus une fraction du pool est périmée,
 * vrai en régime normal, faux après une coupure réseau généralisée -- le cas courant à Douala.
 * Si le premier passage ne suffit pas, le facteur double et la requête est rejouée, jusqu'à
 * `limit` résultats frais ou jusqu'à ce que Redis renvoie moins de candidats bruts que demandé
 * (tout le rayon a déjà été parcouru, il n'y a personne de plus à interroger). Sans cette
 * seconde condition, un rayon clairsemé ferait boucler jusqu'au plafond pour rien.
 */
export async function findNearby(
  redis: Redis,
  origin: { latitude: number; longitude: number },
  radiusMeters: number,
  limit: number
): Promise<NearbyDriver[]> {
  if (radiusMeters <= 0 || limit <= 0) return [];

  let multiplier = OVERFETCH_FACTOR;
  for (;;) {
    const count = limit * multiplier;
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
      count,
      'WITHCOORD',
      'WITHDIST'
    )) as [string, string, [string, string]][];

    const results: NearbyDriver[] = [];
    for (const [driverId, distance, coord] of raw) {
      if (results.length >= limit) break;
      // eslint-disable-next-line no-await-in-loop -- ordre de distance croissante à préserver ;
      // le volume par requête (quelques dizaines de candidats au plus) rend le séquentiel
      // acceptable ici, une parallélisation casserait l'ordre sans bénéfice réel.
      const fresh = await hasFreshPosition(redis, driverId);
      if (!fresh) {
        await removeFromPool(redis, driverId);
        continue;
      }
      const longitude = Number(coord[0]);
      const latitude = Number(coord[1]);
      results.push({ driverId, distanceMeters: Number(distance), latitude, longitude });
    }

    if (results.length >= limit || raw.length < count || multiplier >= OVERFETCH_MAX_MULTIPLIER) {
      return results;
    }
    multiplier *= 2;
  }
}
