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

/** Date calendaire `AAAA-MM-JJ` (expiration d'un permis) en « JJ/MM/AAAA » -- lue telle quelle,
 * sans passer par `Date`, qui la décalerait d'un jour selon le fuseau. */
export function formatDay(isoDay: string): string {
  const [year, month, day] = isoDay.split('-');
  return `${day}/${month}/${year}`;
}

function twoDigits(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Date et heure d'une course (historique), dans le fuseau du téléphone : « 29/10/2026 · 18:12 »
 * -- même forme que l'historique du client (`apps/client/src/format.ts`). */
export function formatRideDate(iso: string): string {
  const date = new Date(iso);
  return `${twoDigits(date.getDate())}/${twoDigits(date.getMonth() + 1)}/${date.getFullYear()} · ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}
