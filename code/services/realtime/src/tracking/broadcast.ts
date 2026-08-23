import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { WebSocket } from 'ws';
import { realtime } from '@babana/contracts';
import type { Config } from '../config';
import type { ConnectionContext } from '../ws/auth';
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
