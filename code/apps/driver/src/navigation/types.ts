import type { RideId } from '@babana/navigation';

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
  Proposal: { rideId: RideId };
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
