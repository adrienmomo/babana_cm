import { asRideId } from '@babana/navigation';
import { navigationRef } from '../navigation/ref';
import { isProposalHandled, markProposalHandled } from '../proposalDedup';

/**
 * Routage et déduplication d'un message push de proposition (L7-04). **La part native s'arrête
 * ici** : recevoir réellement un message Firebase exige un binding natif et un build mobile que
 * cet environnement ne produit pas -- cela rejoint la passe avec appareil (L6-19), comme le
 * sélecteur de pièces (L6-15) et le service de premier plan (L6-05). Ce que ce fichier porte --
 * décoder la charge utile, décider s'il faut ouvrir l'écran, et l'ouvrir au bon endroit -- se
 * teste sans SDK et s'écrit donc maintenant. La session avec appareil n'aura qu'à brancher
 * `@react-native-firebase/messaging` (ou équivalent) sur `handleProposalPushMessage`.
 *
 * Le contenu d'une notification est **minimal** (spécification) : « une course est proposée, avec
 * le temps restant ». Pas de montant, pas de points -- l'écran verrouillé est lisible par un
 * tiers, et une notification peut arriver après l'expiration : afficher un montant pour une
 * course déjà attribuée serait trompeur. Le détail vient de l'app une fois ouverte, qui revalide
 * auprès du serveur (`ProposalScreen`, `source: 'notification'`).
 */

/** Ce que porte `PushMessage.data` côté serveur (`controllers/internal.py::_proposal_push`). Les
 * valeurs FCM sont toujours des chaînes. */
export interface ProposalPushData {
  type?: unknown;
  rideId?: unknown;
  expiresAt?: unknown;
}

export type ProposalRouteResult = 'shown' | 'duplicate' | 'ignored';

export interface ProposalRouteDeps {
  isHandled(rideId: string): boolean;
  markHandled(rideId: string): void;
  /** Ouvre l'écran de proposition en mode « depuis notification » -- détails à revalider. */
  showProposal(rideId: string, expiresAt: string | null): void;
}

/**
 * Décision pure (testable sans navigation ni SDK) : un message push -> ouvrir l'écran, l'ignorer
 * comme doublon, ou l'écarter comme non pertinent.
 *
 * - `ignored` : ce n'est pas une proposition, ou il manque le `rideId`.
 * - `duplicate` : cette proposition a déjà été prise en charge -- par le WebSocket, ou par une
 *   notification précédente. Un chauffeur connecté qui reçoit les deux ne voit qu'un écran
 *   (L7-04, critère 2). Le registre est partagé avec `HomeScreen` (`proposalDedup.ts`).
 * - `shown` : première fois -- on marque, puis on ouvre.
 */
export function routeProposalNotification(data: ProposalPushData, deps: ProposalRouteDeps): ProposalRouteResult {
  if (data?.type !== 'proposal') return 'ignored';
  const rideId = typeof data.rideId === 'string' && data.rideId.length > 0 ? data.rideId : null;
  if (!rideId) return 'ignored';

  if (deps.isHandled(rideId)) return 'duplicate';
  deps.markHandled(rideId);

  const expiresAt = typeof data.expiresAt === 'string' && data.expiresAt.length > 0 ? data.expiresAt : null;
  deps.showProposal(rideId, expiresAt);
  return 'shown';
}

/**
 * Une proposition arrivée par notification avant que la navigation ne soit prête (démarrage à
 * froid depuis un appui sur la notification). `HomeScreen` la consomme à son montage. Le cas
 * « app déjà ouverte » n'y passe jamais -- la navigation est prête, on ouvre directement.
 */
let pendingProposal: { rideId: string; expiresAt: string | null } | null = null;

export function consumePendingProposalNavigation(): { rideId: string; expiresAt: string | null } | null {
  const p = pendingProposal;
  pendingProposal = null;
  return p;
}

/** Point d'entrée que le binding natif (L6-19) appellera à la réception d'un message Firebase,
 * app au premier plan comme en arrière-plan / appui sur la notification. */
export function handleProposalPushMessage(data: ProposalPushData): ProposalRouteResult {
  return routeProposalNotification(data, {
    isHandled: isProposalHandled,
    markHandled: markProposalHandled,
    showProposal: (rideId, expiresAt) => {
      if (navigationRef.isReady()) {
        navigationRef.navigate('Proposal', { source: 'notification', rideId: asRideId(rideId), expiresAt });
      } else {
        pendingProposal = { rideId, expiresAt };
      }
    },
  });
}
