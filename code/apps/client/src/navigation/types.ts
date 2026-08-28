import type { LatLng } from '@babana/maps';
import type { DriverId, RideId } from '@babana/navigation';
import type { http } from '@babana/contracts';

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

/**
 * Point désigné par le client (départ ou arrivée, L6-06) -- une position et le libellé qui l'a
 * produite (géocodage inverse ou résultat de recherche), pour que QuoteScreen (L6-07) puisse
 * afficher « prise en charge : <label> » sans reformuler des coordonnées brutes.
 */
export interface RidePoint {
  position: LatLng;
  label: string;
}

/**
 * Paramètres transportés d'écran en écran tout au long d'une course qui n'a pas encore été
 * affectée (L6-07, L6-08) : origine et destination désignées sur HomeScreen, le cliché des
 * chauffeurs proches (L3-05), et l'état de la boucle de refus -- ceux déjà écartés et le rang du
 * refus courant. `Quote` les reçoit tous en entrée, `Waiting` et `DriverRejected` les font
 * simplement voyager jusqu'au prochain passage par `Quote` (voir D11, L6-08 : un refus ramène à
 * la sélection, jamais à une attribution automatique).
 */
export interface RideSelectionContext {
  origin: RidePoint;
  destination: RidePoint;
  nearbyDrivers: readonly http.NearbyDriver[];
  excludedDriverIds: readonly string[];
  rejectionStreak: number;
  /** Absent au premier passage (aucune course encore créée). Présent dès qu'un chauffeur a été
   * sélectionné une première fois : `POST /rides/{id}/select-driver` accepte la transition
   * `rejected -> proposed` (C-01) précisément pour ce cas -- reproposer la même course à un
   * autre chauffeur, jamais en créer une seconde pour la même demande. */
  rideId?: RideId;
}

export type ClientParamList = {
  Home: undefined;
  Quote: RideSelectionContext;
  Waiting: {
    rideId: RideId;
    driverId: DriverId;
    proposalExpiresAt: string;
    amount: number;
    /** Horodatage de la sélection (Date.now()) -- L6-08 critère 5 : instrumenter chaque abandon
     * avec son délai suppose de savoir depuis quand le client attend. */
    selectedAt: number;
    selection: RideSelectionContext;
  };
  DriverRejected: {
    rideId: RideId;
    driverId: DriverId;
    reason: 'driver_rejected' | 'driver_timeout';
    selection: RideSelectionContext;
  };
  Tracking: {
    rideId: RideId;
    origin: RidePoint;
    destination: RidePoint;
    driver: AssignedDriverInfo;
  };
  RideSummary: {
    rideId: RideId;
    // `null` quand la course s'est terminée sans relevé de trajet accumulé (J24, `measured` faux
    // dans `ride.completed`) -- le résumé affiche « Trajet non relevé », jamais un chiffre faux.
    distanceMeters: number | null;
    durationSeconds: number | null;
    amount: number;
    breakdown: http.FareBreakdown;
  };
  History: undefined;
  Invoice: { rideId: RideId };
};

/**
 * Cliché du chauffeur affecté, porté par `ride.assigned` (D41) -- ce que TrackingScreen (L6-09)
 * affiche pendant l'approche et la course. Volontairement absent de `RideSummary` ci-dessus :
 * l'immatriculation et l'identité du chauffeur cessent d'être affichées exactement à la
 * transition Tracking -> RideSummary (`navigation.replace`, qui fait disparaître les paramètres
 * de Tracking de la pile) -- décision explicite, pas un champ qu'on aurait oublié de retirer
 * (doute relevé le 26 août, amoa/questions/REPONSES-2026-08-26.md §5).
 */
export interface AssignedDriverInfo {
  driverId: DriverId;
  firstName: string | null;
  photoUrl: string | null;
  motorcycleClass: http.VehicleClass | null;
  licensePlate: string | null;
  /** D42 (2 septembre, amoa/questions/REPONSES-2026-09-02.md §1) : le numéro du chauffeur, pour
   * l'appeler pendant l'approche puis la course (`amoa/questions/L6-09.md`). Même effacement que
   * `licensePlate` -- absent de `RideSummary`, disparaît avec le reste de cette interface à
   * `navigation.replace('RideSummary', ...)`. */
  phoneNumber: string | null;
}

export type AuthParamList = {
  SignIn: undefined;
};
