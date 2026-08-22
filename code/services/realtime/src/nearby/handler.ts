import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { WebSocket } from 'ws';
import { realtime } from '@babana/contracts';
import type { Config } from '../config';
import type { ConnectionContext } from '../ws/auth';
import { findNearbyWithExpansion } from './expand';
import { recordLastSent } from './last-sent';

// D14, non négociable par le client (critère 2) -- déjà la borne du schéma `NearbyDriversPayloadSchema`
// (packages/contracts/src/realtime/server-to-client.ts, `.max(5)`) ; répété ici comme constante
// nommée plutôt que laissé comme littéral au fil du code.
const NEARBY_RESULT_LIMIT = 5;

interface Subscription {
  timer: NodeJS.Timeout;
}

/**
 * Abonnements `nearby.subscribe` / `nearby.unsubscribe` (L3-05, D14). Un seul abonnement actif
 * par client (critère 5) : indexé par `userId`, un nouvel abonnement du même client annule le
 * précédent avant d'en programmer un nouveau -- jamais deux minuteurs actifs pour le même client.
 *
 * Limitation de débit par utilisateur (critère 6, C2b) : porte sur l'action `subscribe`
 * elle-même (le point d'entrée qu'un client pourrait appeler en boucle pour échantillonner la
 * flotte), pas sur les diffusions périodiques qui en découlent, qui sont à la cadence du serveur.
 */
export class NearbyManager {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly rateLimitHits = new Map<string, number[]>();

  constructor(
    private readonly config: Config,
    private readonly redis: Redis
  ) {}

  async subscribe(
    context: ConnectionContext,
    socket: WebSocket,
    payload: realtime.NearbySubscribeMessage['payload']
  ): Promise<void> {
    const allowance = this.allowSubscribe(context.userId);
    if (!allowance.allowed) {
      // Accusé de réception explicite (23 août, doute L6-06 §3 --
      // amoa/questions/REPONSES-2026-08-23.md §2) : un silence est le pire retour possible pour
      // une limitation de débit, il pousse exactement au comportement qui l'aggrave.
      socket.send(JSON.stringify(buildNearbySubscribeAckMessage({ accepted: false, retryAfterMs: allowance.retryAfterMs })));
      return;
    }
    socket.send(JSON.stringify(buildNearbySubscribeAckMessage({ accepted: true })));

    this.clearSubscription(context.userId);

    // Rayon plafonné (critère 1), quelle que soit la valeur demandée -- C2b. Le schéma C-02
    // borne déjà radiusMeters à 50 km (garde-fou anti-abus au niveau du contrat) ; celui-ci est
    // la valeur métier réelle, configurable côté service (invariant 5).
    const radiusMeters = Math.min(payload.radiusMeters, this.config.NEARBY_MAX_RADIUS_METERS);
    const origin = payload.position;
    // Refusants de cette course (L3-08, 24 août) : le client les rappelle depuis les
    // ride.rejected déjà reçus (L6-08) -- vide sur un abonnement de simple découverte.
    const excludeDriverIds = payload.excludeDriverIds;

    const push = async (): Promise<void> => {
      if (socket.readyState !== socket.OPEN) {
        this.clearSubscription(context.userId);
        return;
      }
      // Élargit le rayon par paliers (L3-08) si plus aucun candidat ne reste une fois les
      // refusants exclus. Une découverte libre (excludeDriverIds vide, HomeScreen) n'élargit
      // jamais -- voir nearby/expand.ts pour le raisonnement complet (C2b).
      const result = await findNearbyWithExpansion(this.config, this.redis, origin, radiusMeters, excludeDriverIds, NEARBY_RESULT_LIMIT);
      const drivers = 'drivers' in result ? result.drivers : [];
      // Précondition C-03 (L3-17) : mémorise cette liste comme "la dernière montrée à ce client",
      // pour que /internal/reservations puisse refuser un chauffeur jamais affiché.
      await recordLastSent(this.redis, context.userId, drivers.map((d) => d.driverId), this.config.NEARBY_LAST_SENT_TTL_SECONDS);
      // Une liste vide après épuisement de l'élargissement EST le NO_DRIVER_AVAILABLE de la
      // spécification (catalogue C-01) : L6-08 traite déjà ce cas côté app, aucun message
      // distinct n'est nécessaire (voir nearby/expand.ts).
      socket.send(JSON.stringify(buildNearbyDriversMessage(drivers)));
    };

    await push();

    const timer = setInterval(() => {
      push().catch(() => {
        // Filet défensif, même politique que ws/connection.ts pour position.update : une panne
        // Redis passagère ne doit jamais faire planter le service ni fermer la connexion.
      });
    }, this.config.NEARBY_BROADCAST_INTERVAL_SECONDS * 1000);
    // unref() : ce minuteur ne doit jamais empêcher le processus de s'arrêter proprement, même
    // raisonnement que les autres minuteurs du service (ws/connection.ts, driver/availability.ts).
    timer.unref();
    this.subscriptions.set(context.userId, { timer });
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

  private allowSubscribe(
    userId: string,
    nowMs: number = Date.now()
  ): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const windowMs = this.config.NEARBY_RATE_LIMIT_WINDOW_SECONDS * 1000;
    const cutoff = nowMs - windowMs;
    const recent = (this.rateLimitHits.get(userId) ?? []).filter((hitMs) => hitMs > cutoff);
    if (recent.length >= this.config.NEARBY_RATE_LIMIT_MAX_SUBSCRIPTIONS) {
      this.rateLimitHits.set(userId, recent);
      // Sort du délai de la plus ancienne tentative retenue dans la fenêtre : c'est elle qui,
      // en en sortant, libère la première place.
      const oldest = Math.min(...recent);
      return { allowed: false, retryAfterMs: Math.max(1, windowMs - (nowMs - oldest)) };
    }
    recent.push(nowMs);
    this.rateLimitHits.set(userId, recent);
    return { allowed: true };
  }
}

function buildNearbyDriversMessage(drivers: realtime.NearbyDriversMessage['payload']['drivers']): realtime.NearbyDriversMessage {
  return {
    type: 'nearby.drivers',
    id: randomUUID(),
    emittedAt: new Date().toISOString(),
    payload: { drivers },
  };
}

function buildNearbySubscribeAckMessage(
  payload: realtime.NearbySubscribeAckMessage['payload']
): realtime.NearbySubscribeAckMessage {
  return {
    type: 'nearby.subscribe.ack',
    id: randomUUID(),
    emittedAt: new Date().toISOString(),
    payload,
  };
}
