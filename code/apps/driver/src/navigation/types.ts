import type { RideId } from '@babana/navigation';
import type { LatLng } from '@babana/maps';

/**
 * Ce qu'une proposition porte (L6-12, L7-04). Elle ne se présente plus comme un écran : elle
 * s'affiche sur la carte de `Home` (voir `rideFlow/`), qui la reçoit du temps réel ou de la
 * notification (`Home: { proposal }`).
 *
 * Deux façons d'arriver (L6-12, L7-04) :
 *
 * - `source: 'realtime'` (par défaut) -- l'app tenait déjà tous les détails, portés par
 *   `proposal.new` (C-02) ou par `session.synced.activeProposal` à une reconnexion. `proposal.new`
 *   n'arrive qu'une fois, diffusé aux seuls abonnés déjà en écoute : c'est `Home`, toujours
 *   monté, qui le reçoit et le passe au panneau.
 * - `source: 'notification'` -- l'app était **fermée** à l'émission, ouverte depuis la
 *   notification push. Elle n'a jamais reçu `proposal.new` : elle n'a que le `rideId` et, au
 *   mieux, une échéance approximative. Le panneau **revalide auprès du serveur** (une
 *   resynchronisation forcée) avant d'afficher quoi que ce soit -- détails et **véritable**
 *   échéance, ou « cette course n'est plus à prendre » si la réponse ne porte pas de
 *   proposition active (jamais des boutons pour une course déjà attribuée ou expirée).
 */
export type ProposalParams =
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
      /** Repère laissé par le client (« devant la pharmacie »), `null` s'il n'en a pas laissé. */
      pickupNote: string | null;
      /** L'heure du SERVEUR à l'envoi (enveloppe de `proposal.new`, ou `serverTime` de
       * `session.synced`) : le compte à rebours se mesure sur elle, jamais sur l'horloge du
       * téléphone, qui peut dériver de plusieurs minutes. */
      serverNow: string;
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
 * Passée du panneau de proposition au panneau de course (L6-13) : la course en cours a besoin des
 * points (itinéraire, phases) et du montant (transmis ensuite à `Settlement`). Rien n'est relu
 * depuis un abonnement -- `proposal.new` a déjà tout porté, le panneau de proposition le fait
 * suivre.
 */
export type ActiveRideParams = {
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
   * le panneau de proposition le fait suivre ici. `null` si l'enregistrement a expiré côté serveur
   * entre la résolution atomique et sa lecture (filet D30), ou si la reprise passe par le
   * filet `session.synced` plutôt que par `proposal.accepted` lui-même (rien à faire suivre
   * dans ce cas -- absent, jamais inventé). Effacé à `Settlement` : n'y figure jamais.
   */
  clientPhoneNumber: string | null;
  /** Repère du client, montré pendant l'approche et sur place ; `null` s'il n'en a pas laissé. */
  pickupNote: string | null;
};

/**
 * Arborescence de l'app Chauffeur (L6-00) : un écran permanent (Home) -- la carte, où se déroule
 * toute la course : proposition, approche, « sur place », trajet (`rideFlow/`) -- plus les écrans
 * qui n'ont pas besoin de la carte. La fin de course bascule vers `Settlement` par `reset()`
 * (`./transitions.ts`) : un retour ne doit pas rouvrir une course déjà terminée.
 */
export type DriverParamList = {
  /** `proposal` : l'app a été ouverte (ou ramenée au premier plan) depuis la notification d'une
   * proposition -- la carte l'affiche, après revalidation auprès du serveur (L7-04). */
  Home: { proposal?: ProposalParams } | undefined;
  Settlement: { rideId: RideId; amount: number };
  /** Écran de recette (L5-07) : encaissé du jour, solde dû, marge avant plafond, historique des
   * remises. Point d'entrée permanent depuis Home, pas seulement quand le plafond bloque -- à la
   * différence de `Remittance` ci-dessous. */
  Cash: undefined;
  /** Déclaration de remise (L5-07) -- réservée dès L6-11, qui y propose déjà un accès direct
   * quand le motif de refus de passage en ligne est le plafond d'encaisse (L3-04), et `Cash`
   * ci-dessus y mène aussi depuis le bouton « Déclarer une remise ». */
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
