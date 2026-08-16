import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { WebSocket } from 'ws';
import { realtime } from '@babana/contracts';
import type { Config } from '../config';
import type { ConnectionContext } from '../ws/auth';
import { projectNearbyDrivers } from './projection';
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
    if (!this.allowSubscribe(context.userId)) return;

    this.clearSubscription(context.userId);

    // Rayon plafonné (critère 1), quelle que soit la valeur demandée -- C2b. Le schéma C-02
    // borne déjà radiusMeters à 50 km (garde-fou anti-abus au niveau du contrat) ; celui-ci est
    // la valeur métier réelle, configurable côté service (invariant 5).
    const radiusMeters = Math.min(payload.radiusMeters, this.config.NEARBY_MAX_RADIUS_METERS);
    const origin = payload.position;

    const push = async (): Promise<void> => {
      if (socket.readyState !== socket.OPEN) {
        this.clearSubscription(context.userId);
        return;
      }
      const drivers = await projectNearbyDrivers(this.config, this.redis, origin, radiusMeters, NEARBY_RESULT_LIMIT);
      // Précondition C-03 (L3-17) : mémorise cette liste comme "la dernière montrée à ce client",
      // pour que /internal/reservations puisse refuser un chauffeur jamais affiché.
      await recordLastSent(this.redis, context.userId, drivers.map((d) => d.driverId), this.config.NEARBY_LAST_SENT_TTL_SECONDS);
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

  private allowSubscribe(userId: string, nowMs: number = Date.now()): boolean {
    const windowMs = this.config.NEARBY_RATE_LIMIT_WINDOW_SECONDS * 1000;
    const cutoff = nowMs - windowMs;
    const recent = (this.rateLimitHits.get(userId) ?? []).filter((hitMs) => hitMs > cutoff);
    if (recent.length >= this.config.NEARBY_RATE_LIMIT_MAX_SUBSCRIPTIONS) {
      this.rateLimitHits.set(userId, recent);
      return false;
    }
    recent.push(nowMs);
    this.rateLimitHits.set(userId, recent);
    return true;
  }
}

function buildNearbyDriversMessage(
  drivers: Awaited<ReturnType<typeof projectNearbyDrivers>>
): realtime.NearbyDriversMessage {
  return {
    type: 'nearby.drivers',
    id: randomUUID(),
    emittedAt: new Date().toISOString(),
    payload: { drivers },
  };
}
