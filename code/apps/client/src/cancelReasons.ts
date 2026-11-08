/**
 * Motifs proposés au client qui annule (demande du 6 novembre) -- des libellés d'interface, envoyés
 * tels quels comme `reason` (L4-07 : motif libre, facultatif pour le client). « Autre » ouvre un
 * champ libre (`CancelRideSheet`). Le serveur n'en déduit aucune règle.
 */
export const CLIENT_CANCEL_REASONS = [
  'Le chauffeur met trop de temps',
  "J'ai changé d'avis",
  'Mauvais point de départ',
  "J'ai trouvé un autre moyen",
];
