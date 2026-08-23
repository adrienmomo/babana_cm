import type { http } from '@babana/contracts';

/**
 * Détail décomposé (spécification : « prise en charge, distance, coefficient éventuel, remise »),
 * partagé entre QuoteScreen (L6-07, une estimation) et RideSummaryScreen (L6-09, ce que le
 * serveur a réellement facturé) -- même contrat `FareBreakdown`, même mise en forme, une seule
 * définition des libellés (D17 en esprit, étendu à la présentation).
 *
 * `floorAmount` et `roundingAmount` complètent la liste pour que les lignes affichées somment
 * *exactement* le total affiché (L2-03, critère 4) -- masquées quand nulles pour ne pas
 * encombrer un montant sans surprise, jamais réarrondies : additionner zéro ne change rien à la
 * somme, donc l'identité tient qu'une ligne nulle soit montrée ou non.
 */
export const FARE_LINES: ReadonlyArray<{
  key: keyof http.FareBreakdown;
  label: string;
  subtract?: boolean;
  alwaysShown?: boolean;
}> = [
  { key: 'baseFare', label: 'Prise en charge', alwaysShown: true },
  { key: 'distanceFare', label: 'Distance', alwaysShown: true },
  { key: 'surgeAmount', label: 'Majoration' },
  { key: 'discountAmount', label: 'Remise', subtract: true },
  { key: 'floorAmount', label: 'Ajustement plancher' },
  { key: 'roundingAmount', label: 'Arrondi' },
];

export function visibleFareLines(breakdown: http.FareBreakdown): typeof FARE_LINES {
  return FARE_LINES.filter((line) => line.alwaysShown || breakdown[line.key] !== 0);
}
