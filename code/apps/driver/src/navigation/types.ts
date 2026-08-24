import type { RideId } from '@babana/navigation';
import type { LatLng } from '@babana/maps';

/**
 * Arborescence de l'app Chauffeur (L6-00) : un écran permanent (Home) qu'interrompent des
 * événements -- proposition reçue, course en cours -- pas une séquence (voir apps/client pour
 * l'arborescence inverse). Proposal se présente en plein écran par-dessus Home (Home reste
 * dessous, un retour depuis Proposal dismiss simplement -- c'est le comportement voulu, pas une
 * fuite). L'acceptation bascule vers ActiveRide par `reset()` (`./transitions.ts`), pas
 * `navigate()` : un retour depuis une course en cours ne doit pas ramener à une proposition déjà
 * résolue.
 */
export type DriverParamList = {
  Home: undefined;
  /**
   * Portée directement par la navigation plutôt que relue depuis un nouvel abonnement (L6-12) :
   * `proposal.new` (C-02) n'arrive qu'une fois, diffusé aux abonnés déjà en écoute au moment de
   * sa réception (`onRealtimeMessage`, `@babana/api-client`) -- un abonnement posé après coup, au
   * montage de `Proposal`, ne le recevrait jamais une seconde fois. `HomeScreen` (seul appelant)
   * transmet donc tout ce que `proposal.new` a porté.
   */
  Proposal: {
    rideId: RideId;
    origin: LatLng;
    destination: LatLng;
    amount: number;
    distanceMeters: number;
    /** ISO 8601 -- le serveur seul est juge de l'expiration (L3-07), ce champ n'est qu'indicatif. */
    expiresAt: string;
  };
  ActiveRide: { rideId: RideId };
  Settlement: { rideId: RideId };
  /** Déclaration de remise (L5-07, écran pas encore construit -- `amoa/questions/L6-11.md`) :
   * réservée dès L6-11, qui doit déjà pouvoir y proposer un accès direct quand le motif de refus
   * de passage en ligne est le plafond d'encaisse (L3-04). */
  Remittance: undefined;
};

/**
 * Chauffeur dont le dossier n'est pas (ou plus) approuvé -- `pending` explicitement (spécification
 * L6-00), et par défaut-refus tout statut qui n'est pas `approved` (`rejected`, `suspended`, ou
 * inconnu tant que `AuthClient.restore()` n'a pas encore été rafraîchi, voir
 * `src/navigation/index.tsx`). Un seul écran ce soir : le parcours d'inscription complet
 * (profil, documents) est L6-15, hors de ce lot -- "routé vers son écran d'attente de dossier",
 * pas vers tout le parcours.
 */
export type DriverPendingParamList = {
  Pending: undefined;
};

export type AuthParamList = {
  SignIn: undefined;
};
