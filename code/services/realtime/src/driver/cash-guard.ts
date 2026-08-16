import type Redis from 'ioredis';
import { cashBlockedKey } from './keys';
import { removeFromPool } from '../redis/geo-index';

/**
 * Plafond d'encaisse franchi (D8, D28, L5-02). Odoo est la source de vérité (D27, comme pour
 * l'engagement) : ce module ne décide de rien, il applique ce qu'Odoo signale au commit de la
 * transaction d'encaissement qui a fait franchir le plafond (`babana.driver.
 * _babana_apply_cash_limit`, D32 -- voir `http/internal.ts::/internal/drivers/cash-blocked`).
 *
 * **Deux points de blocage, tous deux obligatoires (spécification)** :
 * 1. `blockForCash` retire IMMÉDIATEMENT le chauffeur du pool -- il n'apparaît plus dans
 *    `nearby.drivers` pour aucun nouveau client à partir de cet instant.
 * 2. La clé posée ici est aussi consultée par `ws/dispatch.ts` avant de résoudre un
 *    `proposal.accept` : sans ce second point, une proposition émise juste avant le
 *    franchissement resterait acceptable (le chauffeur est déjà hors du pool "à venir", mais
 *    une proposition déjà en vol ne passe pas par le pool une seconde fois).
 *
 * Sans TTL, comme le marqueur d'engagement (D26) : rien ne doit faire réapparaître un chauffeur
 * bloqué sans une décision explicite côté Odoo (L5-04, remise de caisse validée -- hors de ce
 * lot). `unblockForCash` est exportée prête à l'emploi pour cette tâche future, même principe que
 * `clearEngaged` construite par L3-07 avant que L3-17 ne l'appelle.
 */

export async function blockForCash(redis: Redis, driverId: string): Promise<void> {
  await redis.set(cashBlockedKey(driverId), '1');
  await removeFromPool(redis, driverId);
}

export async function unblockForCash(redis: Redis, driverId: string): Promise<void> {
  await redis.del(cashBlockedKey(driverId));
}

export async function isCashBlocked(redis: Redis, driverId: string): Promise<boolean> {
  return (await redis.exists(cashBlockedKey(driverId))) === 1;
}
