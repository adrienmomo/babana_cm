/**
 * Constructeurs des clés Redis pour les deux drapeaux d'état du chauffeur indépendants d'une
 * course, tous deux hors du périmètre de l'unification L3-18 (arbitré le 23 août -- ni "en
 * ligne" ni "plafond d'encaisse" ne sont nommés parmi les trois structures à unifier) : "en
 * ligne" (L3-04) et "plafond d'encaisse franchi" (L5-02). L'état de course lui-même (réservé,
 * engagé, session de suivi) vit désormais dans `ride/state.ts`.
 *
 * Module sans dépendance, délibérément : `redis/pool-eligibility.ts` a besoin des deux pour
 * construire son script d'éligibilité, tout comme `driver/availability.ts` (en ligne) -- si ces
 * clés vivaient dans l'un de ces modules, l'autre l'importerait et fermerait un cycle
 * (`availability.ts` importe déjà `redis/geo-index.ts`, que `redis/pool-eligibility.ts` importe
 * aussi). Une seule définition ici, jamais une chaîne de préfixe dupliquée qui pourrait diverger.
 */

const ONLINE_FLAG_PREFIX = 'babana:driver:online:';
const CASH_BLOCKED_KEY_PREFIX = 'babana:driver:cash-blocked:';

export function onlineFlagKey(driverId: string): string {
  return `${ONLINE_FLAG_PREFIX}${driverId}`;
}

/**
 * Plafond d'encaisse franchi (D8, D28, L5-02) : posée par `driver/cash-guard.ts` sur signal
 * d'Odoo (`POST /internal/drivers/cash-blocked`), consultée par le script d'éligibilité du pool
 * (`redis/pool-eligibility.lua`, point de blocage 1) et par la résolution d'acceptation
 * (`proposal/lifecycle.ts` via `ws/dispatch.ts`, point de blocage 2).
 */
export function cashBlockedKey(driverId: string): string {
  return `${CASH_BLOCKED_KEY_PREFIX}${driverId}`;
}
