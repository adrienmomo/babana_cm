import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { realtime } from '@babana/contracts';
import type { Config } from '../config';
import type { ConnectionContext } from './auth';
import { fetchActiveRide, type ActiveRide } from '../odoo/rides';

/**
 * Réponse à `session.resync` (L3-11) : un état complet, jamais un différentiel (politique de
 * reconnexion, docs/contracts/realtime-events.md). Odoo est la source de vérité (D27) -- ce
 * service ne garde aucune trace durable de l'état d'une course (invariant 1), la réponse
 * interroge donc Odoo à chaque resynchronisation plutôt que de refléter un état local qui
 * n'existe pas.
 *
 * Dégradation silencieuse si Odoo est injoignable : la connexion reste ouverte, le rejeu de la
 * file d'actions locale (côté client, `packages/api-client/src/realtime/connection.ts`) n'attend
 * pas cette réponse pour continuer (même raisonnement que `nearby/handler.ts` pour une panne
 * Redis passagère) -- ne jamais renvoyer `activeRideId: null` par défaut sur un échec réseau, ce
 * qui laisserait croire à tort qu'aucune course n'est en cours.
 */
export async function handleSessionResync(
  config: Config,
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

  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(buildSessionSyncedMessage(active)));
}

function buildSessionSyncedMessage(active: ActiveRide): realtime.SessionSyncedMessage {
  return {
    type: 'session.synced',
    id: randomUUID(),
    emittedAt: new Date().toISOString(),
    payload: {
      activeRideId: active.rideId,
      activeRideState: active.state,
      serverTime: new Date().toISOString(),
    },
  };
}
