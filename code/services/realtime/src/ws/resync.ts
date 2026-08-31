import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { realtime } from '@babana/contracts';
import type { Config } from '../config';
import type { ConnectionContext } from './auth';
import type { ProposalLifecycle } from '../proposal/lifecycle';
import { fetchActiveRide, type ActiveRide } from '../odoo/rides';

/**
 * Réponse à `session.resync` (L3-11) : un état complet, jamais un différentiel (politique de
 * reconnexion, docs/contracts/realtime-events.md). Odoo est la source de vérité (D27) pour l'état
 * d'une course -- ce service ne garde aucune trace durable de celui-ci (invariant 1), la réponse
 * interroge donc Odoo à chaque resynchronisation.
 *
 * `activeProposal` (L7-04) fait exception : une proposition `proposed` n'a pas d'échéance
 * d'acceptation dans Odoo (le minuteur vit ici, en Redis), et c'est justement la **véritable**
 * échéance qu'un chauffeur qui ouvre sa notification doit voir. Elle est donc lue localement
 * (`ProposalLifecycle.peekActiveProposal`) et l'absence est dite explicitement (`null`) -- jamais
 * déduite d'un silence (l'inférence que D49 a supprimée). Seul un chauffeur en a une ; pour un
 * client, toujours `null`.
 *
 * Dégradation silencieuse si Odoo est injoignable : la connexion reste ouverte, le rejeu de la
 * file d'actions locale (côté client) n'attend pas cette réponse -- ne jamais renvoyer
 * `activeRideId: null` par défaut sur un échec réseau, ce qui laisserait croire à tort qu'aucune
 * course n'est en cours. `activeProposal` n'est donc pas envoyé seul dans ce cas : l'app
 * resynchronise à nouveau à la reconnexion suivante.
 */
export async function handleSessionResync(
  config: Config,
  proposals: ProposalLifecycle,
  context: ConnectionContext,
  socket: WebSocket,
  payload: realtime.SessionResyncMessage['payload']
): Promise<void> {
  let active: ActiveRide;
  try {
    active = await fetchActiveRide(config, context, payload.lastKnownRideId);
  } catch (err) {
    console.error('[L3-11] échec de la resynchronisation contre Odoo :', err);
    return;
  }

  const activeProposal =
    context.role === 'driver' && context.driverId
      ? await proposals.peekActiveProposal(context.driverId)
      : null;

  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(buildSessionSyncedMessage(active, activeProposal)));
}

function buildSessionSyncedMessage(
  active: ActiveRide,
  activeProposal: realtime.ActiveProposal | null
): realtime.SessionSyncedMessage {
  return {
    type: 'session.synced',
    id: randomUUID(),
    emittedAt: new Date().toISOString(),
    payload: {
      activeRideId: active.rideId,
      activeRideState: active.state,
      activeProposal,
      serverTime: new Date().toISOString(),
    },
  };
}
