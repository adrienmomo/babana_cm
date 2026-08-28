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
    /** Distance de la course (départ -> arrivée), celle qui sert au tarif. */
    distanceMeters: number;
    /** Distance à vide jusqu'au client (D51), à vol d'oiseau -- `null` si le serveur n'a pas pu
     * lire la position du chauffeur au moment de la réservation. */
    distanceToOriginMeters: number | null;
    /** ISO 8601 -- le serveur seul est juge de l'expiration (L3-07), ce champ n'est qu'indicatif. */
    expiresAt: string;
  };
  /**
   * Portée par la navigation depuis `Proposal` (L6-13) : la course en cours a besoin des points
   * (guidage, phases) et du montant (transmis ensuite à `Settlement`). Rien n'est relu depuis un
   * abonnement -- `proposal.new` a déjà tout porté, `ProposalScreen` le fait suivre.
   */
  ActiveRide: {
    rideId: RideId;
    origin: LatLng;
    destination: LatLng;
    /** Montant dû, transmis tel quel à `Settlement` -- l'app ne le recalcule jamais (invariant 3). */
    amount: number;
    /** Distance de référence de la course (celle du tarif) -- voir `apps/driver/src/ride/completion.ts`. */
    distanceMeters: number;
    /**
     * D42 (2 septembre, amoa/questions/REPONSES-2026-09-02.md §1, referme
     * `amoa/questions/L6-13.md`) : le numéro du client, porté par `proposal.accepted` --
     * `ProposalScreen` le fait suivre ici. `null` si l'enregistrement a expiré côté serveur
     * entre la résolution atomique et sa lecture (filet D30), ou si la reprise passe par le
     * filet `session.synced` plutôt que par `proposal.accepted` lui-même (rien à faire suivre
     * dans ce cas -- absent, jamais inventé). Effacé à `Settlement` : n'y figure jamais.
     */
    clientPhoneNumber: string | null;
  };
  Settlement: { rideId: RideId; amount: number };
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
