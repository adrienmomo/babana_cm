import type Redis from 'ioredis';
import { setOnline } from '../../src/driver/availability';
import { addEligibleToPool } from '../../src/redis/pool-eligibility';

/**
 * Aide de test (L3-06R, critère 6 bis -- amoa/questions/REPONSES-2026-08-17.md §1) : compose une
 * entrée dans le pool par le VRAI chemin de production -- marquer en ligne, puis appeler le script
 * d'éligibilité -- plutôt que par un `GEOADD` inconditionnel. `addToPool` (l'ancien raccourci,
 * exporté depuis `src/redis/geo-index.ts`) a été retiré du code source : le seul point d'écriture
 * du pool, en production comme en test, est désormais `addEligibleToPool`.
 *
 * Vit dans `test/`, jamais dans `src/` : une aide de test ne doit plus jamais pouvoir être
 * confondue avec une porte d'écriture de production (test/pool-single-writer.test.ts, critère 6).
 */
export async function putInPool(
  redis: Redis,
  driverId: string,
  latitude: number,
  longitude: number
): Promise<void> {
  await setOnline(redis, driverId);
  const inserted = await addEligibleToPool(redis, driverId, latitude, longitude);
  if (!inserted) {
    throw new Error(
      `putInPool: ${driverId} n'a pas pu entrer dans le pool -- réservé ou engagé par un test précédent ?`
    );
  }
}
