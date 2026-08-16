/**
 * Constructeurs de clés Redis pour la proposition active d'un chauffeur (L3-07). Deux clés,
 * délibérément séparées :
 *
 * - `proposalRideIdKey` : la valeur minimale (le rideId, en clair) que `resolve.lua` doit pouvoir
 *   comparer atomiquement, dans le même script que la résolution elle-même -- sans elle, un
 *   message tardif référençant une proposition déjà remplacée par une nouvelle pour le même
 *   chauffeur pourrait valider par erreur la mauvaise course (voir `resolve.lua`).
 * - `proposalRecordKey` : le reste de la charge utile (origine, destination, montant, distance,
 *   client) -- purement informationnel, lu par `proposal/lifecycle.ts` seulement APRÈS que la
 *   résolution atomique a réussi, pour composer les messages sortants. Jamais lu à l'intérieur du
 *   script Lua : nul besoin d'y décoder du JSON pour une donnée qui ne conditionne aucune écriture.
 */

const PROPOSAL_RIDE_ID_KEY_PREFIX = 'babana:driver:proposal:rideId:';
const PROPOSAL_RECORD_KEY_PREFIX = 'babana:driver:proposal:record:';

export function proposalRideIdKey(driverId: string): string {
  return `${PROPOSAL_RIDE_ID_KEY_PREFIX}${driverId}`;
}

export function proposalRecordKey(driverId: string): string {
  return `${PROPOSAL_RECORD_KEY_PREFIX}${driverId}`;
}
