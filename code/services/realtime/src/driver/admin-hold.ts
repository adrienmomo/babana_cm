import type Redis from 'ioredis';
import { adminHoldKey } from './keys';
import { removeFromPool } from '../redis/geo-index';

/**
 * Dossier chauffeur non habilité à travailler -- suspension ou rejet côté Odoo (D5, D31, D55, J33).
 * Odoo est la source de vérité (D27, comme pour l'engagement et le plafond d'encaisse) : ce module
 * ne décide de rien, il applique ce qu'Odoo signale au commit de la transition d'état
 * (`babana.driver.write()`, D32 -- voir `http/internal.ts::/internal/drivers/unavailable`).
 *
 * Construit sur le patron de `driver/cash-guard.ts` (prompt J33 : « applique-le, ne le
 * réinvente pas »), avec ses deux points de blocage :
 * 1. `holdDriver` retire IMMÉDIATEMENT le chauffeur du pool -- il n'apparaît plus dans
 *    `nearby.drivers` pour aucun nouveau client à partir de cet instant, sans attendre
 *    l'expiration de sa dernière position.
 * 2. La clé posée ici est aussi lue par le script d'éligibilité (`redis/pool-eligibility.lua`)
 *    et par `ws/dispatch.ts` avant de résoudre un `proposal.accept` : une proposition émise
 *    juste avant la suspension ne doit pas rester acceptable.
 *
 * Sans TTL, comme le marqueur d'engagement (D26) et le blocage d'encaisse (L5-02) : rien ne doit
 * faire réapparaître un chauffeur non habilité sans une décision explicite côté Odoo. `releaseHold`
 * est levée par la réactivation (`POST /internal/drivers/available`) ; elle ne réintègre PAS le
 * chauffeur au pool -- contrairement à `unblockForCash`, un chauffeur réactivé se redéclare en
 * ligne lui-même (D7, prompt J33 : « c'est au chauffeur de se redéclarer en ligne »).
 */

export async function holdDriver(redis: Redis, driverId: string): Promise<void> {
  await redis.set(adminHoldKey(driverId), '1');
  await removeFromPool(redis, driverId);
}

export async function releaseHold(redis: Redis, driverId: string): Promise<void> {
  await redis.del(adminHoldKey(driverId));
}

export async function isOnAdminHold(redis: Redis, driverId: string): Promise<boolean> {
  return (await redis.exists(adminHoldKey(driverId))) === 1;
}
