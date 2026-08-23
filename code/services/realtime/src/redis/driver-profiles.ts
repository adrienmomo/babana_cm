import type Redis from 'ioredis';
import type { Config } from '../config';
import { fetchDriverProfiles } from '../odoo/driver-profiles';

/**
 * Cache des profils chauffeur (L3-16) : les quatre champs affichés par `nearby.drivers` --
 * prénom, photo, note, gamme de moto -- possédés par Odoo, jamais lus directement d'ici
 * (invariant 1, aucun client PostgreSQL dans ce service). Remplace le hash provisoire posé par
 * L3-05 (champ-pont, amoa/questions/L3-05.md, code/docs/bridge-fields.md) : `setDriverProfile`
 * n'est plus seedé qu'à la main par les tests, c'est désormais aussi l'écrivain réel du cache,
 * alimenté par `getDriverProfiles` ci-dessous via le canal interne Odoo (D27 : le sens de la
 * dépendance ne s'inverse pas, Odoo n'écrit jamais dans Redis).
 *
 * Aucun TTL Redis sur les clés elles-mêmes : une expiration TTL supprimerait un profil déjà lu
 * dès qu'Odoo devient injoignable plus longtemps que le TTL de fraîcheur -- l'inverse du critère
 * 2 ("les profils déjà lus restent servis"). La fraîcheur est gérée en application, par une clé
 * compagnon (`profileFetchedAtKey`) : une entrée périmée déclenche une tentative de
 * rafraîchissement, jamais une suppression.
 */

export interface DriverProfile {
  firstName: string | null;
  photoUrl: string | null;
  rating: number | null;
  motorcycleClass: 'standard' | 'premium' | null;
  /**
   * Ajouté le 25 août (D41, amoa/questions/REPONSES-2026-08-25.md §2) : de quoi reconnaître la
   * moto qui arrive, une fois seulement un chauffeur affecté. `nearby/projection.ts` ne lit
   * jamais ce champ (liste blanche explicite, C2b) -- seul `proposal/lifecycle.ts::accept`
   * (`ride.assigned`) le fait. Le cache est le même que celui de `nearby.drivers` : même donnée
   * Odoo, même fraîcheur, deux consommateurs qui ne projettent pas les mêmes champs.
   */
  licensePlate: string | null;
}

const DRIVER_PROFILE_KEY_PREFIX = 'babana:driver:profile:';
const DRIVER_PROFILE_FETCHED_AT_KEY_PREFIX = 'babana:driver:profile:fetched-at:';

function profileKey(driverId: string): string {
  return `${DRIVER_PROFILE_KEY_PREFIX}${driverId}`;
}

function profileFetchedAtKey(driverId: string): string {
  return `${DRIVER_PROFILE_FETCHED_AT_KEY_PREFIX}${driverId}`;
}

/**
 * Écrivain canonique du cache -- utilisé aussi bien par `getDriverProfiles` (production) que par
 * les fixtures de test (`test/nearby.test.ts`, même principe que `test/geo-index.test.ts` qui
 * seed le géo-index sans passer par le service). Marque l'entrée comme fraîche à l'instant de
 * l'écriture : un profil seedé directement par un test n'est donc jamais périmé au sens de
 * `getDriverProfiles`, qui ne tente alors aucun appel Odoo pour lui.
 */
export async function setDriverProfile(redis: Redis, driverId: string, profile: DriverProfile): Promise<void> {
  await redis.set(profileKey(driverId), JSON.stringify(profile));
  await redis.set(profileFetchedAtKey(driverId), String(Date.now()));
}

export async function getDriverProfile(redis: Redis, driverId: string): Promise<DriverProfile | null> {
  const raw = await redis.get(profileKey(driverId));
  if (!raw) return null;
  return JSON.parse(raw) as DriverProfile;
}

export async function removeDriverProfile(redis: Redis, driverId: string): Promise<void> {
  await redis.del(profileKey(driverId));
  await redis.del(profileFetchedAtKey(driverId));
}

/**
 * Profils des chauffeurs candidats d'une requête `nearby` (critère 3 : au plus un appel Odoo par
 * lot, jamais un par chauffeur, quel que soit le nombre de candidats déjà en cache ou non).
 *
 * Un chauffeur absent de la map renvoyée n'a jamais eu de profil lu avec succès (jamais lu du
 * tout, ou Odoo injoignable à sa toute première lecture) -- jamais inventé (D30). C'est
 * `nearby/projection.ts` qui traduit cette absence en champs à `null` dans `NearbyDriver`, jamais
 * ce module : la distinction "pas de profil" / "profil à null" reste au bon niveau, celui qui
 * connaît le contrat C-01.
 */
export async function getDriverProfiles(
  config: Config,
  redis: Redis,
  driverIds: string[]
): Promise<Map<string, DriverProfile>> {
  const now = Date.now();
  const ttlMs = config.DRIVER_PROFILE_CACHE_TTL_SECONDS * 1000;
  const result = new Map<string, DriverProfile>();

  const cached = await Promise.all(
    driverIds.map(async (driverId) => {
      const [rawProfile, rawFetchedAt] = await Promise.all([
        redis.get(profileKey(driverId)),
        redis.get(profileFetchedAtKey(driverId)),
      ]);
      return { driverId, rawProfile, rawFetchedAt };
    })
  );

  const stale: string[] = [];
  for (const { driverId, rawProfile, rawFetchedAt } of cached) {
    if (rawProfile) {
      result.set(driverId, JSON.parse(rawProfile) as DriverProfile);
    }
    const fetchedAt = rawFetchedAt ? Number(rawFetchedAt) : null;
    if (fetchedAt === null || now - fetchedAt > ttlMs) {
      stale.push(driverId);
    }
  }

  if (stale.length === 0) return result;

  try {
    const fetched = await fetchDriverProfiles(config, stale);
    await Promise.all(
      Object.entries(fetched).map(async ([driverId, profile]) => {
        result.set(driverId, profile);
        await setDriverProfile(redis, driverId, profile);
      })
    );
  } catch {
    // Odoo injoignable (critère 2) : les entrées déjà en cache (déjà posées dans `result`
    // ci-dessus) continuent d'être servies telles quelles ; les chauffeurs jamais lus restent
    // absents de la map, jamais inventés.
  }

  return result;
}
