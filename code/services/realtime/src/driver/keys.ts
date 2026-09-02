/**
 * Constructeurs des clés Redis pour les drapeaux d'état du chauffeur indépendants d'une course,
 * tous hors du périmètre de l'unification L3-18 (arbitré le 23 août -- ni "en ligne" ni "plafond
 * d'encaisse" ne sont nommés parmi les trois structures à unifier) : "en ligne" (L3-04), "plafond
 * d'encaisse franchi" (L5-02) et "dossier non habilité à travailler" (suspension / rejet, J33).
 * L'état de course lui-même (réservé, engagé, session de suivi) vit désormais dans `ride/state.ts`.
 *
 * Module sans dépendance, délibérément : `redis/pool-eligibility.ts` a besoin des trois pour
 * construire son script d'éligibilité, tout comme `driver/availability.ts` (en ligne) -- si ces
 * clés vivaient dans l'un de ces modules, l'autre l'importerait et fermerait un cycle
 * (`availability.ts` importe déjà `redis/geo-index.ts`, que `redis/pool-eligibility.ts` importe
 * aussi). Une seule définition ici, jamais une chaîne de préfixe dupliquée qui pourrait diverger.
 */

const ONLINE_FLAG_PREFIX = 'babana:driver:online:';
const CASH_BLOCKED_KEY_PREFIX = 'babana:driver:cash-blocked:';
const ADMIN_HOLD_KEY_PREFIX = 'babana:driver:admin-hold:';

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

/**
 * Dossier chauffeur non habilité à travailler -- suspendu ou rejeté côté Odoo (D5, D31, D55, J33).
 * Posée par `driver/admin-hold.ts` sur signal d'Odoo (`POST /internal/drivers/unavailable`, au
 * commit de la transition d'état -- D32), consultée par le script d'éligibilité du pool
 * (`redis/pool-eligibility.lua`, troisième porte de blocage) et par la résolution d'acceptation
 * (`proposal/lifecycle.ts` via `ws/dispatch.ts`). Levée par `POST /internal/drivers/available`
 * (réactivation) -- mais, à la différence de `cash-unblocked`, sans réintégration au pool : un
 * chauffeur réactivé se redéclare en ligne lui-même (D7, prompt J33). Sans TTL, comme
 * `cashBlockedKey` : rien ne fait réapparaître un chauffeur non habilité sans une décision
 * explicite côté Odoo.
 */
export function adminHoldKey(driverId: string): string {
  return `${ADMIN_HOLD_KEY_PREFIX}${driverId}`;
}
