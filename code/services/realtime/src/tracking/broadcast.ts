import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { WebSocket } from 'ws';
import { realtime, http } from '@babana/contracts';
import type { Config } from '../config';
import type { ConnectionContext } from '../ws/auth';
import type { ConnectionRegistry } from '../ws/auth';
import { getRideSession } from './session';
import { getPosition } from '../redis/positions';
import { haversineDistanceMeters } from './validation';

interface Subscription {
  rideId: string;
  timer: NodeJS.Timeout;
}

/**
 * Abonnements `ride.track` (L3-09) : le client voit la position de son chauffeur, pendant
 * l'approche puis pendant la course. Même patron que `nearby/handler.ts` (un seul abonnement
 * actif par client, indexé par `userId`) -- un client ne suit jamais deux courses à la fois, un
 * nouvel abonnement remplace le précédent plutôt que d'empiler des minuteurs.
 *
 * **Vérifié à chaque diffusion, pas seulement à l'abonnement** (spécification, critère 2) : la
 * session de course (`tracking/session.ts`) est relue à chaque tick, jamais mise en cache dans
 * l'abonnement lui-même. Une course qui se termine entre deux diffusions fait donc taire le
 * suivi au tick suivant, sans action explicite du client -- c'est cette relecture qui matérialise
 * le critère 4 ("le suivi cesse à la fin de la course").
 */
export class TrackingManager {
  private readonly subscriptions = new Map<string, Subscription>();

  constructor(
    private readonly config: Config,
    private readonly redis: Redis
  ) {}

  async subscribe(context: ConnectionContext, socket: WebSocket, payload: realtime.RideTrackMessage['payload']): Promise<void> {
    this.clearSubscription(context.userId);

    const push = async (): Promise<void> => {
      if (socket.readyState !== socket.OPEN) {
        this.clearSubscription(context.userId);
        return;
      }

      // Relu à CHAQUE diffusion (critère 2) : un client qui n'est plus affecté à cette course
      // (terminée, annulée, ou jamais la sienne) ne reçoit rien -- silencieusement, pas une
      // erreur, et l'abonnement s'arrête de lui-même plutôt que de continuer à interroger Redis
      // en vain pour une course qui n'existe plus.
      const session = await getRideSession(this.redis, payload.rideId);
      if (!session || session.clientUserId !== context.userId) {
        this.clearSubscription(context.userId);
        return;
      }

      // Une position pas encore connue (chauffeur qui vient d'accepter, pas encore émis) ou
      // périmée (coupure réseau côté chauffeur, L3-02) ne produit aucune diffusion cette
      // fois-ci -- jamais une position inventée. Le suivi reprendra à la prochaine position
      // fraîche, sans que le client n'ait rien à refaire.
      const position = await getPosition(this.redis, session.driverId);
      if (!position) return;

      const distanceMeters = haversineDistanceMeters(position, session.origin);
      const etaSeconds = Math.round(distanceMeters / this.config.TRACKING_AVERAGE_SPEED_MPS);

      socket.send(
        JSON.stringify(
          buildDriverPositionMessage(payload.rideId, { latitude: position.latitude, longitude: position.longitude }, etaSeconds)
        )
      );
    };

    await push();

    const timer = setInterval(() => {
      push().catch(() => {
        // Filet défensif, même politique que le reste du service (ws/connection.ts,
        // nearby/handler.ts) : une panne Redis passagère ne doit jamais fermer la connexion.
      });
    }, this.config.TRACKING_BROADCAST_INTERVAL_SECONDS * 1000);
    timer.unref();
    this.subscriptions.set(context.userId, { rideId: payload.rideId, timer });
  }

  unsubscribe(context: ConnectionContext): void {
    this.clearSubscription(context.userId);
  }

  private clearSubscription(userId: string): void {
    const existing = this.subscriptions.get(userId);
    if (existing) {
      clearInterval(existing.timer);
      this.subscriptions.delete(userId);
    }
  }
}

function buildDriverPositionMessage(
  rideId: string,
  position: { latitude: number; longitude: number },
  etaSeconds: number
): realtime.DriverPositionMessage {
  return {
    type: 'driver.position',
    id: randomUUID(),
    emittedAt: new Date().toISOString(),
    payload: { rideId, position, etaSeconds },
  };
}

/**
 * Émetteur du cycle de vie de course (L3-19), sens Odoo -> temps réel : `http/internal.ts`
 * reçoit `/internal/rides/started|completed` déclenché au COMMIT (D32) par
 * `action_start`/`action_complete` (babana_ride_state.py), et pousse ici -- même patron d'envoi
 * que `proposal/lifecycle.ts::send` (registre ciblé par identité de connexion, jamais par une
 * relecture de session), à DEUX destinataires : le client suivi ET le chauffeur, « le même
 * message poussé à deux abonnés différents » (spécification L3-19). Odoo fournit `clientUserId`/
 * `driverId` directement (il les connaît déjà, `babana.ride.client_id`/`driver_id`) -- pas de
 * lecture de `tracking/session.ts` ici, qui introduirait une dépendance d'ordre avec
 * `handleClearEngagement` (fin de course, même requête) sans rien apporter : notifie, ne
 * transitionne rien (D31).
 */
export function broadcastRideStarted(
  registry: ConnectionRegistry,
  params: { rideId: string; clientUserId: string; driverId: string }
): void {
  sendToRideParticipants(registry, params.clientUserId, params.driverId, buildRideStartedMessage(params.rideId));
}

/**
 * Annulation (L4-12, sens Odoo -> temps réel) : pousse `ride.cancelled` (C-02) au SEUL
 * destinataire qu'Odoo désigne -- contrairement à `broadcastRideStarted`/`broadcastRideCompleted`
 * ci-dessus (toujours les deux participants), le destinataire dépend ici de l'acteur (D31 :
 * `action_cancel`, babana_ride_state.py, calcule qui prévenir -- jamais celui qui vient de
 * décider, qui le sait déjà). `notifyClientUserId`/`notifyDriverId` sont donc chacun optionnels
 * et indépendants : `null` ou absent ne pousse simplement rien vers ce rôle, plutôt que de faire
 * porter cette décision au service temps réel lui-même.
 */
export function broadcastRideCancelled(
  registry: ConnectionRegistry,
  params: {
    rideId: string;
    cancelledBy: realtime.RideCancelledMessage['payload']['cancelledBy'];
    reason?: string;
    notifyClientUserId?: string | null;
    notifyDriverId?: string | null;
  }
): void {
  const message = buildRideCancelledMessage(params);
  const payload = JSON.stringify(message);
  if (params.notifyClientUserId) {
    for (const socket of registry.getByUserId(params.notifyClientUserId)) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }
  if (params.notifyDriverId) {
    for (const socket of registry.getByDriverId(params.notifyDriverId)) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }
}

function buildRideCancelledMessage(params: {
  rideId: string;
  cancelledBy: realtime.RideCancelledMessage['payload']['cancelledBy'];
  reason?: string;
}): realtime.RideCancelledMessage {
  return {
    type: 'ride.cancelled',
    id: randomUUID(),
    emittedAt: new Date().toISOString(),
    payload: { rideId: params.rideId, cancelledBy: params.cancelledBy, reason: params.reason },
  };
}

export function broadcastRideCompleted(
  registry: ConnectionRegistry,
  params: {
    rideId: string;
    clientUserId: string;
    driverId: string;
    distanceMeters: number;
    durationSeconds: number;
    amount: number;
    breakdown: http.FareBreakdown;
  }
): void {
  sendToRideParticipants(
    registry,
    params.clientUserId,
    params.driverId,
    buildRideCompletedMessage(params)
  );
}

function sendToRideParticipants(
  registry: ConnectionRegistry,
  clientUserId: string,
  driverId: string,
  message: realtime.ServerToClientMessage
): void {
  const payload = JSON.stringify(message);
  for (const socket of registry.getByUserId(clientUserId)) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
  for (const socket of registry.getByDriverId(driverId)) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}

function buildRideStartedMessage(rideId: string): realtime.RideStartedMessage {
  return {
    type: 'ride.started',
    id: randomUUID(),
    emittedAt: new Date().toISOString(),
    payload: { rideId },
  };
}

function buildRideCompletedMessage(params: {
  rideId: string;
  distanceMeters: number;
  durationSeconds: number;
  amount: number;
  breakdown: http.FareBreakdown;
}): realtime.RideCompletedMessage {
  return {
    type: 'ride.completed',
    id: randomUUID(),
    emittedAt: new Date().toISOString(),
    payload: {
      rideId: params.rideId,
      distanceMeters: params.distanceMeters,
      durationSeconds: params.durationSeconds,
      amount: params.amount,
      breakdown: params.breakdown,
    },
  };
}
