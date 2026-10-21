import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import { realtime } from '@babana/contracts';
import type { Config } from '../config';
import type { ConnectionContext, ConnectionRegistry } from '../ws/auth';
import { getRideSession } from './session';

/**
 * Itinéraire partagé et « Sur place » (chauffeur -> client), pendant l'approche puis la course.
 *
 * Le chauffeur calcule le tracé (le service temps réel n'a aucun routage, D3) et l'affiche ; ce
 * module le rediffuse **à l'identique** au client de la course, pour que les deux écrans montrent
 * le même chemin. Redis seulement, jamais Odoo : ni un tracé ni un « Sur place » ne sont des
 * événements métier (invariant 1) -- la décision « Commencer la course » reste HTTP.
 *
 * **L'émetteur est vérifié, pas le `rideId`** (L3-01) : seul le chauffeur engagé sur la course
 * (session de suivi, `tracking/session.ts`) peut partager un tracé ou se déclarer sur place ; un
 * message forgé est ignoré en silence, comme les autres messages hors rôle.
 *
 * « Sur place » n'arrive plus par ici depuis l'app : c'est une décision écrite dans Odoo (`POST
 * /rides/{id}/arrived`), qui la pousse au commit (`recordDriverArrived`).
 *
 * Le dernier tracé et le fait « sur place » sont gardés (TTL) pour être rejoués à un client qui
 * s'abonne tard -- reconnexion, app relancée. Une course terminée n'a plus de session : plus rien
 * n'est relayé, et les clés expirent d'elles-mêmes.
 */
const ROUTE_KEY_PREFIX = 'babana:ride:route:';
const ARRIVED_KEY_PREFIX = 'babana:ride:arrived:';

export function rideRouteKey(rideId: string): string {
  return `${ROUTE_KEY_PREFIX}${rideId}`;
}

export function rideArrivedKey(rideId: string): string {
  return `${ARRIVED_KEY_PREFIX}${rideId}`;
}

export class RideRouteRelay {
  constructor(
    private readonly config: Config,
    private readonly redis: Redis,
    private readonly registry: ConnectionRegistry
  ) {}

  async share(context: ConnectionContext, payload: realtime.RouteShareMessage['payload']): Promise<void> {
    const clientUserId = await this.clientOfDriversRide(context, payload.rideId);
    if (!clientUserId) return;

    const { rideId, ...route } = payload;
    await this.redis.set(rideRouteKey(rideId), JSON.stringify(route), 'EX', this.config.RIDE_ROUTE_TTL_SECONDS);
    this.sendToClient(clientUserId, buildRideRouteMessage(payload));
  }

  /**
   * Message rapide (`chat.send`) : relayé à l'AUTRE participant. L'émetteur doit être le chauffeur
   * ou le client de la course (session de suivi), et le code doit correspondre à son rôle
   * (`driver_*` / `client_*`). Rien n'est gardé : un message manqué n'est pas rejoué.
   */
  async chat(context: ConnectionContext, payload: realtime.ChatSendMessage['payload']): Promise<void> {
    const session = await getRideSession(this.redis, payload.rideId);
    if (!session) return;

    const fromDriver = context.role === 'driver' && context.driverId !== null && session.driverId === context.driverId;
    const fromClient = context.role === 'client' && session.clientUserId === context.userId;
    if (!fromDriver && !fromClient) return;
    if (!payload.code.startsWith(fromDriver ? 'driver_' : 'client_')) return;

    const message = buildChatMessage(payload.rideId, payload.code, fromDriver ? 'driver' : 'client');
    const encoded = JSON.stringify(message);
    const recipients = fromDriver ? this.registry.getByUserId(session.clientUserId) : this.registry.getByDriverId(session.driverId);
    for (const socket of recipients) {
      if (socket.readyState === socket.OPEN) socket.send(encoded);
    }
  }

  /** Rejoue au client qui vient de s'abonner (`ride.track`) ce qu'il a pu manquer. L'appelant a
   * déjà vérifié que la course est la sienne. */
  async replay(socket: WebSocket, rideId: string): Promise<void> {
    const [stored, arrived] = await Promise.all([
      this.redis.get(rideRouteKey(rideId)),
      this.redis.get(rideArrivedKey(rideId)),
    ]);
    if (stored) {
      const parsed = realtime.RideRouteSchema.safeParse(JSON.parse(stored));
      if (parsed.success && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(buildRideRouteMessage({ rideId, ...parsed.data })));
      }
    }
    if (arrived && socket.readyState === socket.OPEN) {
      const parsed = StoredArrivalSchema.safeParse(JSON.parse(arrived));
      if (parsed.success) socket.send(JSON.stringify(buildDriverArrivedMessage({ rideId, ...parsed.data })));
    }
  }

  private async clientOfDriversRide(context: ConnectionContext, rideId: string): Promise<string | null> {
    if (context.role !== 'driver' || !context.driverId) return null;
    const session = await getRideSession(this.redis, rideId);
    if (!session || session.driverId !== context.driverId) return null;
    return session.clientUserId;
  }

  private sendToClient(clientUserId: string, message: realtime.ServerToClientMessage): void {
    const encoded = JSON.stringify(message);
    for (const socket of this.registry.getByUserId(clientUserId)) {
      if (socket.readyState === socket.OPEN) socket.send(encoded);
    }
  }
}

function buildRideRouteMessage(payload: realtime.RideRouteMessage['payload']): realtime.RideRouteMessage {
  return { type: 'ride.route', id: randomUUID(), emittedAt: new Date().toISOString(), payload };
}

function buildDriverArrivedMessage(payload: realtime.DriverArrivedMessage['payload']): realtime.DriverArrivedMessage {
  return { type: 'driver.arrived', id: randomUUID(), emittedAt: new Date().toISOString(), payload };
}

const StoredArrivalSchema = z.object({ arrivedAt: z.string(), noShowGraceSeconds: z.number().int().positive() });

/**
 * « Sur place », sens Odoo -> temps réel (`/internal/rides/arrived`, au COMMIT de
 * `action_mark_arrived`, D32) : garde l'arrivée (pour la rejouer à un client qui s'abonne tard) et
 * pousse `driver.arrived` au client ET aux appareils du chauffeur. Odoo désigne les destinataires
 * (il les connaît) : aucune relecture de session ici, même patron que `broadcastRideStarted`.
 */
export async function recordDriverArrived(
  redis: Redis,
  config: Config,
  registry: ConnectionRegistry,
  params: { rideId: string; clientUserId: string; driverId: string; arrivedAt: string; noShowGraceSeconds: number }
): Promise<void> {
  const { rideId, clientUserId, driverId, arrivedAt, noShowGraceSeconds } = params;
  await redis.set(
    rideArrivedKey(rideId),
    JSON.stringify({ arrivedAt, noShowGraceSeconds }),
    'EX',
    config.RIDE_ROUTE_TTL_SECONDS
  );
  const encoded = JSON.stringify(buildDriverArrivedMessage({ rideId, arrivedAt, noShowGraceSeconds }));
  for (const socket of [...registry.getByUserId(clientUserId), ...registry.getByDriverId(driverId)]) {
    if (socket.readyState === socket.OPEN) socket.send(encoded);
  }
}

function buildChatMessage(
  rideId: string,
  code: realtime.ChatMessageMessage['payload']['code'],
  from: realtime.ChatMessageMessage['payload']['from']
): realtime.ChatMessageMessage {
  return { type: 'chat.message', id: randomUUID(), emittedAt: new Date().toISOString(), payload: { rideId, code, from } };
}
