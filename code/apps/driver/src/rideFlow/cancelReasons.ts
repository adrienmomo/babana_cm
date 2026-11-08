/**
 * Motifs proposés au chauffeur qui annule (demande du 6 novembre) -- des libellés d'interface,
 * envoyés tels quels comme `reason`. Le motif est obligatoire pour lui (L4-07 : le serveur le
 * refuse sinon) ; « Autre » ouvre un champ libre (`CancelRideSheet`).
 *
 * En course, l'annulation est le cas exceptionnel de C-03 (panne, accident, agression) : le
 * serveur la signale au back-office -- d'où une liste d'incidents, distincte de celle d'avant le
 * départ.
 */
export const DRIVER_CANCEL_REASONS_BEFORE_START = ['Client injoignable', 'Panne de moto', 'Problème de sécurité'];

export const DRIVER_CANCEL_REASONS_IN_RIDE = ['Panne de moto', 'Accident', 'Agression / insécurité'];
