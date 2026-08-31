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
   * Deux façons d'ouvrir cet écran (L6-12, L7-04) :
   *
   * - `source: 'realtime'` (par défaut, `HomeScreen`) -- l'app tenait déjà tous les détails,
   *   portés par `proposal.new` (C-02) ou par `session.synced.activeProposal` à une reconnexion.
   *   `proposal.new` n'arrive qu'une fois, diffusé aux seuls abonnés déjà en écoute -- un
   *   abonnement posé au montage de `Proposal` ne le recevrait jamais : d'où le passage par la
   *   navigation.
   * - `source: 'notification'` -- l'app était **fermée** à l'émission, ouverte depuis la
   *   notification push. Elle n'a jamais reçu `proposal.new` : elle n'a que le `rideId` et, au
   *   mieux, une échéance approximative. L'écran **revalide auprès du serveur** (une
   *   resynchronisation forcée) avant d'afficher quoi que ce soit -- détails et **véritable**
   *   échéance, ou « cette course n'est plus à prendre » si la réponse ne porte pas de
   *   proposition active (jamais des boutons pour une course déjà attribuée ou expirée).
   */
  Proposal:
    | {
        source?: 'realtime';
        rideId: RideId;
        origin: LatLng;
        destination: LatLng;
        amount: number;
        /** Distance de la course (départ -> arrivée), celle qui sert au tarif. */
        distanceMeters: number;
        /** Distance à vide jusqu'au client (D51), à vol d'oiseau -- `null` si le serveur n'a pas
         * pu lire la position du chauffeur au moment de la réservation. */
        distanceToOriginMeters: number | null;
        /** ISO 8601 -- le serveur seul est juge de l'expiration (L3-07), ce champ n'est
         * qu'indicatif, mais il porte la **véritable** échéance restante, pas trente secondes
         * fraîches. */
        expiresAt: string;
        /** Émission d'origine de la proposition -- signalée au serveur quand l'écran s'est
         * réellement affiché (`proposal.seen`, L7-04 critère 4). */
        emittedAt: string;
      }
    | {
        source: 'notification';
        rideId: RideId;
        /** Échéance portée par la notification, si elle en portait une -- `null` sinon. Sert un
         * premier compte à rebours en attendant la revalidation ; la véritable échéance vient de
         * `session.synced.activeProposal`. */
        expiresAt: string | null;
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
 * `src/navigation/index.tsx`).
 *
 * Parcours d'inscription (L6-15) : profil, dépôt des pièces, écran d'attente. L'écran d'entrée
 * se calcule à l'ouverture depuis l'état serveur (`resolveOnboardingRoute`, `screens/onboarding/
 * state.ts`) -- c'est ce qui rend le parcours reprenable après une fermeture (critère 1).
 * `Documents` peut porter `focusType` quand on y revient pour renvoyer une pièce précise.
 *
 * `Rejected` (amoa/questions/REPONSES-2026-09-04.md §2) : dossier refusé globalement (`rejected`
 * ou `suspended`), avec son motif et le chemin pour corriger -- distinct de `Pending`
 * (« en cours de validation », rien à faire) et de `Documents` (« il manque telle pièce »),
 * parce que les trois situations n'appellent pas la même action.
 */
export type DriverOnboardingParamList = {
  Profile: undefined;
  Documents: { focusType?: 'license' | 'id_card' } | undefined;
  Pending: undefined;
  Rejected: undefined;
};

export type AuthParamList = {
  SignIn: undefined;
};
