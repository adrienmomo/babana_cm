import type Redis from 'ioredis';

/**
 * Stockage des positions chauffeur (L3-02). Durée de vie courte (config.POSITION_TTL_SECONDS) :
 * une position qui expire fait sortir le chauffeur du pool disponible (L3-03 lit ce même signal
 * au moment de la requête plutôt que de dupliquer un mécanisme d'expiration actif) -- c'est le
 * mécanisme naturel de détection d'un chauffeur déconnecté, préférable à une détection explicite
 * qui peut échouer (spécification L3-02).
 *
 * Invariant 1 : Redis uniquement, aucune écriture Odoo -- une position n'est jamais un événement
 * métier.
 */

export interface StoredPosition {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  speedMetersPerSecond: number | null;
  headingDegrees: number | null;
  capturedAtMs: number;
}

const POSITION_KEY_PREFIX = 'babana:driver:position:';

export function positionKey(driverId: string): string {
  return `${POSITION_KEY_PREFIX}${driverId}`;
}

export async function storePosition(
  redis: Redis,
  driverId: string,
  position: StoredPosition,
  ttlSeconds: number
): Promise<void> {
  await redis.set(positionKey(driverId), JSON.stringify(position), 'EX', ttlSeconds);
}

export async function getPosition(redis: Redis, driverId: string): Promise<StoredPosition | null> {
  const raw = await redis.get(positionKey(driverId));
  if (!raw) return null;
  return JSON.parse(raw) as StoredPosition;
}

/** Utilisé par L3-03 : un chauffeur sans position fraîche ne doit jamais être renvoyé, même s'il
 * n'est pas encore sorti du géo-index. */
export async function hasFreshPosition(redis: Redis, driverId: string): Promise<boolean> {
  const exists = await redis.exists(positionKey(driverId));
  return exists === 1;
}
