import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { realtime } from '@babana/contracts';
import type { ConnectionContext, ConnectionRegistry } from '../ws/auth';

/**
 * Un appareil par chauffeur (15 novembre). Odoo retient la session courante d'un chauffeur (la
 * famille de jetons ouverte par sa dernière connexion) et nous l'annonce après le commit
 * (`POST /internal/drivers/session`). Ici : la retenir, fermer la connexion de l'appareil
 * remplacé (`session.replaced` puis `WS_CLOSE_SESSION_REPLACED`), et refuser qu'il se reconnecte.
 *
 * Aucune écriture Odoo (invariant 1) : une clé Redis par chauffeur, sans échéance -- elle ne
 * change qu'à la connexion suivante.
 */

export function driverSessionKey(driverId: string): string {
  return `babana:driver:session:${driverId}`;
}

export async function setDriverSession(redis: Redis, driverId: string, sessionId: string): Promise<void> {
  await redis.set(driverSessionKey(driverId), sessionId);
}

/** Une connexion est de la session courante -- ou rien n'est encore connu (aucune connexion depuis
 * ce changement, ou Redis vidé) : on ne refuse jamais sur une absence d'information. */
export async function isCurrentSession(redis: Redis, context: ConnectionContext): Promise<boolean> {
  if (context.role !== 'driver' || !context.driverId) return true;
  const current = await redis.get(driverSessionKey(context.driverId));
  return current === null || current === context.sessionId;
}

export function buildSessionReplacedMessage(): realtime.SessionReplacedMessage {
  return { type: 'session.replaced', id: randomUUID(), emittedAt: new Date().toISOString(), payload: {} };
}

/** Prévient puis ferme chaque connexion de ce chauffeur qui n'est pas de la session `sessionId`. */
export function closeReplacedConnections(registry: ConnectionRegistry, driverId: string, sessionId: string): number {
  let closed = 0;
  for (const socket of registry.getByDriverId(driverId)) {
    const context = registry.contextOf(socket);
    if (!context || context.sessionId === sessionId) continue;
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(buildSessionReplacedMessage()));
      socket.close(realtime.WS_CLOSE_SESSION_REPLACED, 'compte connecté sur un autre téléphone');
      closed += 1;
    }
  }
  return closed;
}
