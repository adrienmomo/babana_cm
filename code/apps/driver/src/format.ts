/**
 * Mise en forme partagée par les écrans du parcours de course chauffeur -- même patron que
 * `apps/client/src/format.ts` (montant et distance affichés de façon identique des deux côtés).
 */

export function formatMoney(amount: number): string {
  return `${amount.toLocaleString('fr-FR')} FCFA`;
}

export function formatDistance(distanceMeters: number): string {
  return `${(distanceMeters / 1000).toFixed(1)} km`;
}
