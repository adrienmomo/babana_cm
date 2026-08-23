/**
 * Mise en forme partagée par les écrans du parcours de course (Quote, Waiting, Tracking,
 * RideSummary) -- un même montant, une même distance routée, un même ETA affichés de façon
 * identique partout, une seule fois écrits (même raisonnement que `components/driverFormatting.ts`
 * pour la fiche chauffeur).
 */

export function formatMoney(amount: number): string {
  return `${amount.toLocaleString('fr-FR')} FCFA`;
}

/** Distance routée (quote, résumé de fin) -- distincte de `driverFormatting.ts::distanceLabel`,
 * qui affiche une position arrondie à ~11 m (C2b) et ne doit jamais laisser croire à la même
 * précision qu'une distance calculée par l'API de routage. */
export function formatDistance(distanceMeters: number): string {
  return `${(distanceMeters / 1000).toFixed(1)} km`;
}

export function formatEta(etaSeconds: number): string {
  // La durée vient d'un modèle voiture corrigé côté serveur (É8, L10-03) par un facteur qui vaut
  // 1.0 aujourd'hui -- non calibré. "≈" et l'arrondi à la minute évitent d'afficher une précision
  // que ce chiffre n'a pas.
  return `≈ ${Math.max(1, Math.round(etaSeconds / 60))} min`;
}
