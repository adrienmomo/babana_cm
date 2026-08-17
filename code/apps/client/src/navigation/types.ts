import type { RideId } from '@babana/navigation';

/**
 * Arborescence de l'app Client (L6-00) : une séquence -- accueil, estimation, attente, suivi,
 * résumé -- pas un écran permanent interrompu par des événements (voir apps/driver pour
 * l'arborescence inverse). Un seul navigateur plutôt que des sous-navigateurs emboîtés : le
 * point qui distingue "empiler" de "remplacer" (le piège du bouton retour Android, spécification
 * L6-00) est `navigation.reset()` au bon moment (`./transitions.ts`), pas la forme de l'arbre.
 *
 * Écrans métier réels écrits par L6-06 à L6-10 -- ici, seuls les noms de route et leurs
 * paramètres existent, portés par `PlaceholderScreen` (@babana/navigation) en attendant.
 */
export type ClientParamList = {
  Home: undefined;
  Quote: undefined;
  Waiting: { rideId: RideId };
  DriverRejected: { rideId: RideId };
  Tracking: { rideId: RideId };
  RideSummary: { rideId: RideId };
  History: undefined;
  Invoice: { rideId: RideId };
};

export type AuthParamList = {
  SignIn: undefined;
};
