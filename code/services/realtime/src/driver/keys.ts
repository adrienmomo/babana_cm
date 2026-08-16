/**
 * Constructeurs des clés Redis pour les deux drapeaux d'état du chauffeur qui conditionnent son
 * appartenance au pool disponible (D26) : "en ligne" (L3-04) et "engagé sur une course" (L3-07).
 *
 * Module sans dépendance, délibérément : `redis/pool-eligibility.ts` a besoin des deux pour
 * construire son script d'éligibilité, tout comme `driver/availability.ts` (en ligne) et
 * `driver/engagement.ts` (engagement) ont chacun besoin du sien -- si ces clés vivaient dans l'un
 * de ces modules, les deux autres l'importeraient et fermeraient un cycle (`availability.ts`
 * importe déjà `redis/geo-index.ts`, que `redis/pool-eligibility.ts` importe aussi). Une seule
 * définition ici, jamais une chaîne de préfixe dupliquée qui pourrait diverger.
 */

const ONLINE_FLAG_PREFIX = 'babana:driver:online:';
const ENGAGEMENT_KEY_PREFIX = 'babana:driver:engaged:';

export function onlineFlagKey(driverId: string): string {
  return `${ONLINE_FLAG_PREFIX}${driverId}`;
}

export function engagementKey(driverId: string): string {
  return `${ENGAGEMENT_KEY_PREFIX}${driverId}`;
}
