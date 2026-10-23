import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { WebSocket } from 'ws';
import { realtime } from '@babana/contracts';
import type { Config } from '../config';
import type { ConnectionContext } from './auth';
import type { ProposalLifecycle } from '../proposal/lifecycle';
import { fetchActiveRide, type ActiveRide } from '../odoo/rides';
import { isMarkedOnline } from '../driver/availability';

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
 * **Odoo injoignable (L7-04, 6 septembre -- `amoa/questions/REPONSES-2026-09-06.md` §4).** Avant,
 * ce cas se traduisait par un silence : aucun `session.synced` n'était envoyé, pour ne pas
 * renvoyer `activeRideId: null` qui aurait laissé croire à tort qu'aucune course n'était en
 * cours. Mais ce silence privait aussi le chauffeur d'une proposition qu'on connaît pourtant
 * localement. Troisième voie : la réponse part quand même, elle **porte** la proposition
 * (`activeProposal`, lu en Redis, indépendant d'Odoo) et **signale** que l'état de la course est
 * indéterminé (`rideStateKnown: false`) -- dire ce qu'on sait, dire ce qu'on ignore, ne rien
 * inférer d'un silence.
 *
 * `driverOnline` (22 octobre) : la disponibilité que ce service applique au chauffeur, lue en
 * Redis comme la proposition (donc indépendante d'Odoo). Un chauffeur resté déconnecté au-delà de
 * la période de grâce a été mis hors ligne ici (`driver/availability.ts`) ; c'est cette réponse
 * qui le lui apprend quand il se reconnecte. `null` pour un client.
 */
export async function handleSessionResync(
  config: Config,
  redis: Redis,
  proposals: ProposalLifecycle,
  context: ConnectionContext,
  socket: WebSocket,
  payload: realtime.SessionResyncMessage['payload']
): Promise<void> {
  let active: ActiveRide = { rideId: null, state: null };
  let rideStateKnown = true;
  try {
    active = await fetchActiveRide(config, context, payload.lastKnownRideId);
  } catch (err) {
    console.error('[L3-11] Odoo injoignable pendant la resynchronisation -- état de course indéterminé :', err);
    rideStateKnown = false;
  }

  // Lu quoi qu'il arrive : la proposition vit en Redis, pas dans Odoo -- une panne d'Odoo ne doit
  // pas priver le chauffeur d'une proposition qu'on peut lui porter.
  const activeProposal =
    context.role === 'driver' && context.driverId
      ? await proposals.peekActiveProposal(context.driverId)
      : null;
  const driverOnline =
    context.role === 'driver' && context.driverId ? await isMarkedOnline(redis, context.driverId) : null;

  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(buildSessionSyncedMessage(active, activeProposal, rideStateKnown, driverOnline)));
}

function buildSessionSyncedMessage(
  active: ActiveRide,
  activeProposal: realtime.ActiveProposal | null,
  rideStateKnown: boolean,
  driverOnline: boolean | null
): realtime.SessionSyncedMessage {
  return {
    type: 'session.synced',
    id: randomUUID(),
    emittedAt: new Date().toISOString(),
    payload: {
      activeRideId: active.rideId,
      activeRideState: active.state,
      activeProposal,
      rideStateKnown,
      driverOnline,
      serverTime: new Date().toISOString(),
    },
  };
}
