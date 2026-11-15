import type { realtime } from '@babana/contracts';
import { onRealtimeMessage } from './realtime';
import { alertIncomingProposal } from './proposalAlert';
import { handleProposalPushMessage, type ProposalRouteResult } from './push/handlers';

/**
 * Propositions reçues quand aucun écran n'est monté (décision du 14 novembre : un chauffeur en
 * ligne reçoit des courses même app fermée).
 *
 * Balayer l'app des récentes détruit l'activité : React Native démonte alors tout l'arbre des
 * écrans, y compris l'accueil qui écoute `proposal.new` -- mais le service de premier plan garde
 * le processus, le WebSocket et ce module en vie. Ce module prend alors le relais de l'accueil :
 * il sonne l'alerte, et garde la proposition pour l'accueil qui se remontera quand le chauffeur
 * touchera la notification. Il passe par le chemin d'une notification (`push/handlers.ts`) : à la
 * réouverture, l'écran revalide la proposition auprès du serveur -- elle a pu expirer ou partir
 * ailleurs entre-temps, et l'app n'affiche jamais une course qui n'est plus la sienne.
 *
 * App seulement en arrière-plan (activité vivante) : l'accueil reste monté et s'en charge seul,
 * ce module ne fait rien.
 */

let attachedHosts = 0;

/** Appelé par l'accueil à son montage ; la fonction rendue le détache au démontage. */
export function attachProposalHost(): () => void {
  attachedHosts += 1;
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    attachedHosts -= 1;
  };
}

/** Vrai tant qu'au moins un accueil est monté. */
export function isProposalHostAttached(): boolean {
  return attachedHosts > 0;
}

export interface ProposalWatchDeps {
  isHostAttached: () => boolean;
  route: (rideId: string, expiresAt: string) => ProposalRouteResult;
  alert: () => void;
}

/** Décision pure : ouvrir l'alerte pour une proposition annoncée pendant qu'aucun écran n'écoute. */
export function handleDetachedProposalMessage(message: realtime.ServerToClientMessage, deps: ProposalWatchDeps): void {
  if (deps.isHostAttached()) return;
  const proposal =
    message.type === 'proposal.new'
      ? { rideId: message.payload.rideId, expiresAt: message.payload.expiresAt }
      : message.type === 'session.synced' && message.payload.activeProposal
        ? { rideId: message.payload.activeProposal.rideId, expiresAt: message.payload.activeProposal.expiresAt }
        : null;
  if (!proposal) return;
  // Déjà prise en charge (même proposition rejouée par une resynchronisation) : une seule alerte.
  if (deps.route(proposal.rideId, proposal.expiresAt) === 'shown') deps.alert();
}

let started = false;

/** Point d'accroche unique (`bootstrap.ts`). Idempotent. */
export function startProposalWatch(): void {
  if (started) return;
  started = true;
  onRealtimeMessage((message) =>
    handleDetachedProposalMessage(message, {
      isHostAttached: isProposalHostAttached,
      route: (rideId, expiresAt) => handleProposalPushMessage({ type: 'proposal', rideId, expiresAt }),
      alert: alertIncomingProposal,
    })
  );
}
