import type Redis from 'ioredis';
import type { WebSocket } from 'ws';
import { realtime } from '@babana/contracts';
import type { Config } from '../config';
import type { ConnectionContext } from './auth';
import { ingestPosition, plausibilityConfigFrom } from '../tracking/ingest';
import { setOnline, setOffline } from '../driver/availability';
import type { NearbyManager } from '../nearby/handler';
import type { ProposalLifecycle } from '../proposal/lifecycle';

/**
 * Routage des messages entrants (C-02) vers leur gestionnaire, par `type`. Un seul point
 * d'entrée pour `ws/connection.ts`, qui n'a pas à connaître la forme de chaque message.
 *
 * Un message illisible ou hors du schéma `ClientToServerMessageSchema` est ignoré, jamais une
 * fermeture de connexion -- même principe qu'une position rejetée (L3-02) : le réseau mobile est
 * intermittent, un message tronqué ou en retard n'est pas une faute qui justifie de couper le
 * chauffeur.
 *
 * Les types non encore traités par ce lot (`ride.start`, `ride.complete`, `ride.track`,
 * `session.resync`, ...) sont ignorés silencieusement -- ce n'est pas une erreur, seulement une
 * fonctionnalité que les tâches suivantes ajoutent au fil de l'eau.
 */
export type MessageDispatcher = (context: ConnectionContext, socket: WebSocket, raw: string) => Promise<void>;

export function createMessageDispatcher(
  config: Config,
  redis: Redis,
  nearby: NearbyManager,
  proposals: ProposalLifecycle
): MessageDispatcher {
  const plausibility = plausibilityConfigFrom(config);

  return async function dispatch(context, socket, raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const result = realtime.ClientToServerMessageSchema.safeParse(parsed);
    if (!result.success) return;
    const message = result.data;

    switch (message.type) {
      case 'position.update':
        await ingestPosition(redis, context, message, plausibility, config.POSITION_TTL_SECONDS);
        return;
      case 'availability.set':
        // L'identité vient du contexte de connexion (invariant L3-01) : un client ne peut jamais
        // basculer la disponibilité d'un chauffeur, même en forgeant ce message.
        if (context.role !== 'driver' || !context.driverId) return;
        if (message.payload.online) {
          await setOnline(redis, context.driverId);
        } else {
          await setOffline(redis, context.driverId);
        }
        return;
      case 'nearby.subscribe':
        // Émetteur : client (C-02) -- un chauffeur qui enverrait ce message est ignoré, même
        // garde-fou de rôle que availability.set ci-dessus.
        if (context.role !== 'client') return;
        await nearby.subscribe(context, socket, message.payload);
        return;
      case 'nearby.unsubscribe':
        if (context.role !== 'client') return;
        nearby.unsubscribe(context);
        return;
      case 'proposal.accept':
        // Émetteur : chauffeur (C-02). L'identité vient du contexte de connexion (L3-01) --
        // `rideId` du message n'est jamais une identité, seulement la donnée que la résolution
        // atomique fait correspondre à la proposition active de CE chauffeur (proposal/resolve.lua).
        if (context.role !== 'driver' || !context.driverId) return;
        await proposals.accept(context.driverId, message.payload.rideId);
        return;
      case 'proposal.reject':
        if (context.role !== 'driver' || !context.driverId) return;
        await proposals.reject(context.driverId, message.payload.rideId);
        return;
      default:
        return;
    }
  };
}
