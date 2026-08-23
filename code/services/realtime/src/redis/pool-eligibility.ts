import { readFileSync } from 'node:fs';
import path from 'node:path';
import type Redis from 'ioredis';
import { AVAILABLE_DRIVERS_KEY } from './geo-index';
import { onlineFlagKey, cashBlockedKey } from '../driver/keys';
import { rideStateKey } from '../ride/state';
import { getPosition } from './positions';

/**
 * Unique point d'écriture GEOADD sur le pool (D26, L3-06R) -- voir pool-eligibility.lua pour la
 * garantie qu'il porte. Décision et écriture dans le MÊME script, exactement comme reserve.lua
 * (L3-06) : aucun `if (en ligne) { geoadd }` ne doit revenir en TypeScript entre un appelant et
 * Redis -- c'est précisément ce qui a cassé l'invariant une première fois (tracking/ingest.ts,
 * avant ce correctif, amoa/questions/REPONSES-2026-08-16-J7.md §2).
 *
 * Depuis la correction du 17 août (amoa/questions/REPONSES-2026-08-17.md §1, critère 6 bis),
 * `redis/geo-index.ts` ne porte plus aucun `GEOADD` -- l'ancien `addToPool` (GEOADD
 * inconditionnel) a été retiré de `src/` : les fixtures de test qui en avaient besoin
 * (nearby.test.ts, geo-index.test.ts, availability.test.ts) composent désormais le pool par ce
 * même script, via `test/helpers/pool.ts` ou un appel direct à `addEligibleToPool`.
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
    rideStateKey(driverId),
    cashBlockedKey(driverId),
    driverId,
    longitude,
    latitude
  );
  return result === 1;
}

/**
 * Remet un chauffeur dans le pool s'il est toujours éligible -- jamais un ajout inconditionnel
 * (même discipline que `addEligibleToPool` ci-dessus, dont cette fonction n'est qu'un appelant de
 * plus). Partagée par `reservation/reserve.ts::releaseDriver` (L3-06, critères 4 et 5) et par le
 * câblage L3-17 (relâchement d'une réservation sur échec Odoo, effacement de l'engagement en fin
 * de course) : dans les deux cas, "le chauffeur redevient disponible" veut dire "réévalué par le
 * script d'éligibilité avec sa dernière position connue", jamais "réinséré directement".
 *
 * Sans position connue (jamais émise, ou expirée depuis), il n'y a rien à réintégrer : la
 * prochaine position acceptée (L3-02/`tracking/ingest.ts`) s'en chargera.
 */
export async function reintegrateIfEligible(redis: Redis, driverId: string): Promise<void> {
  const position = await getPosition(redis, driverId);
  if (position) {
    await addEligibleToPool(redis, driverId, position.latitude, position.longitude);
  }
}
