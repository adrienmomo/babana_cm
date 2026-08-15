import type Redis from 'ioredis';

/**
 * Profil chauffeur en cache (L3-05) : prénom, photo, note, gamme de moto -- données possédées
 * par Odoo (babana.driver, res.partner), jamais lues directement d'ici (invariant 1, aucun
 * client PostgreSQL dans ce service). Hash simple, une clé JSON par chauffeur.
 *
 * PONT, tracé, condamné (amoa/questions/L3-05.md) : rien n'écrit encore cette clé en
 * production -- aucun canal Odoo -> Redis n'existe aujourd'hui pour la peupler (le canal de
 * L3-15 sert `ir.config_parameter`, pas une donnée par enregistrement comme un profil chauffeur ;
 * un mécanisme de la même famille reste à spécifier). `setDriverProfile` n'est appelé ce soir que
 * par les tests, qui seedent directement le cache -- même principe que `test/geo-index.test.ts`,
 * qui seed le géo-index sans passer par le service. Un chauffeur disponible sans profil en cache
 * est omis de `nearby.drivers` (voir nearby/projection.ts), jamais complété par une valeur
 * inventée.
 */

export interface DriverProfile {
  firstName: string;
  photoUrl: string | null;
  rating: number;
  motorcycleClass: 'standard' | 'premium';
}

const DRIVER_PROFILE_KEY_PREFIX = 'babana:driver:profile:';

function profileKey(driverId: string): string {
  return `${DRIVER_PROFILE_KEY_PREFIX}${driverId}`;
}

export async function setDriverProfile(redis: Redis, driverId: string, profile: DriverProfile): Promise<void> {
  await redis.set(profileKey(driverId), JSON.stringify(profile));
}

export async function getDriverProfile(redis: Redis, driverId: string): Promise<DriverProfile | null> {
  const raw = await redis.get(profileKey(driverId));
  if (!raw) return null;
  return JSON.parse(raw) as DriverProfile;
}

export async function removeDriverProfile(redis: Redis, driverId: string): Promise<void> {
  await redis.del(profileKey(driverId));
}
