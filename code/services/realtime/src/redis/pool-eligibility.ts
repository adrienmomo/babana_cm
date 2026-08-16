import { readFileSync } from 'node:fs';
import path from 'node:path';
import type Redis from 'ioredis';
import { AVAILABLE_DRIVERS_KEY } from './geo-index';
import { onlineFlagKey, engagementKey } from '../driver/keys';
import { reservationKey } from '../reservation/keys';

/**
 * Unique point d'écriture GEOADD sur le pool (D26, L3-06R) -- voir pool-eligibility.lua pour la
 * garantie qu'il porte. Décision et écriture dans le MÊME script, exactement comme reserve.lua
 * (L3-06) : aucun `if (en ligne) { geoadd }` ne doit revenir en TypeScript entre un appelant et
 * Redis -- c'est précisément ce qui a cassé l'invariant une première fois (tracking/ingest.ts,
 * avant ce correctif, amoa/questions/REPONSES-2026-08-16-J7.md §2).
 *
 * `redis/geo-index.ts` conserve son propre `addToPool` (GEOADD inconditionnel), mais réservé aux
 * fixtures de test qui n'ont pas de rapport avec la réservation ou l'engagement (nearby.test.ts,
 * geo-index.test.ts) -- voir son docstring. Aucun appelant de production n'y touche plus.
 */
const POOL_ELIGIBILITY_SCRIPT = readFileSync(path.join(__dirname, 'pool-eligibility.lua'), 'utf8');

export async function addEligibleToPool(
  redis: Redis,
  driverId: string,
  latitude: number,
  longitude: number
): Promise<boolean> {
  const result = await redis.eval(
    POOL_ELIGIBILITY_SCRIPT,
    4,
    AVAILABLE_DRIVERS_KEY,
    onlineFlagKey(driverId),
    reservationKey(driverId),
    engagementKey(driverId),
    driverId,
    longitude,
    latitude
  );
  return result === 1;
}
