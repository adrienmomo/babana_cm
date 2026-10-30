/**
 * Mise en forme partagée par les écrans du parcours de course (Quote, Waiting, Tracking,
 * RideSummary) -- un même montant, une même distance routée, un même ETA affichés de façon
 * identique partout, une seule fois écrits (même raisonnement que `components/driverFormatting.ts`
 * pour la fiche chauffeur).
 */

export function formatMoney(amount: number): string {
  return `${amount.toLocaleString('fr-FR')} FCFA`;
}

/** Distance routée (quote, résumé de fin), calculée par l'API de routage. */
export function formatDistance(distanceMeters: number): string {
  return `${(distanceMeters / 1000).toFixed(1)} km`;
}

export function formatEta(etaSeconds: number): string {
  // La durée vient d'un modèle voiture corrigé côté serveur (É8, L10-03) par un facteur qui vaut
  // 1.0 aujourd'hui -- non calibré. "≈" et l'arrondi à la minute évitent d'afficher une précision
  // que ce chiffre n'a pas.
  return `≈ ${Math.max(1, Math.round(etaSeconds / 60))} min`;
}

function twoDigits(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Date et heure d'une course (historique, facture), dans le fuseau du téléphone : « 29/10/2026 · 18:12 ». */
export function formatRideDate(iso: string): string {
  const date = new Date(iso);
  return `${twoDigits(date.getDate())}/${twoDigits(date.getMonth() + 1)}/${date.getFullYear()} · ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}
