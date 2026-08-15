// Authentification des connexions WebSocket (L3-01). Validation LOCALE du jeton applicatif,
// avec le secret partagé (JWT_SECRET) -- aucun appel sortant vers Odoo, qui ne passerait pas à
// l'échelle avec une connexion par chauffeur (amoa/specs/L3-temps-reel.md, L3-01).
//
// La connexion porte ensuite un contexte immuable (ConnectionContext ci-dessous) : identifiant
// utilisateur, rôle, identifiant du chauffeur le cas échéant. C'est la SEULE source
// d'autorisation pour tous les messages suivants -- aucun message entrant ne peut redéfinir
// l'identité de son émetteur (critère d'acceptation 3).
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import type { Config } from '../config';
import { verifyApplicationTokenWithReason } from './token';

/**
 * Codes de fermeture WebSocket documentés (plage 4000-4999 réservée à l'usage applicatif, RFC
 * 6455 §7.4.2). Deux codes distincts pour deux situations que l'app doit traiter différemment :
 * un jeton manquant ou invalide n'a rien à renouveler (ré-authentification complète nécessaire),
 * un jeton expiré si (renouvellement via /auth/refresh puis reconnexion, sans ré-authentifier
 * l'utilisateur). 4401 fait écho à HTTP 401, 4402 à l'idée d'expiration (TOKEN_EXPIRED, C-01).
 */
export const WS_CLOSE_UNAUTHENTICATED = 4401;
export const WS_CLOSE_TOKEN_EXPIRED = 4402;

/**
 * Contexte de connexion (critère d'acceptation 3) : posé une seule fois à l'authentification,
 * jamais modifié ensuite. `readonly` sur les trois champs n'empêche pas techniquement une
 * réaffectation de l'objet entier -- c'est `Object.freeze` dans `authenticateConnection`
 * ci-dessous qui rend la valeur elle-même immuable, pas seulement son type.
 */
export interface ConnectionContext {
  readonly userId: string;
  readonly role: 'client' | 'driver';
  /**
   * `null` quand le rôle n'est pas 'driver' ; toujours renseigné quand il l'est --
   * `AccessTokenClaimsSchema` (D23) rend `driverId` obligatoire sur un jeton chauffeur, donc
   * `verifyApplicationTokenWithReason` rejette déjà tout jeton chauffeur qui ne le porterait
   * pas (voir ws/token.ts). Ne jamais confondre avec `userId` : deux identifiants différents
   * (babana.driver.public_id contre res.users.babana_public_id).
   */
  readonly driverId: string | null;
}

export type AuthenticationResult =
  | { ok: true; context: ConnectionContext; expiresAtMs: number }
  | { ok: false; closeCode: number; reason: string };

/**
 * Le jeton voyage en paramètre de requête (`?token=...`) plutôt qu'en en-tête HTTP personnalisé
 * à la connexion : c'est la méthode la plus largement supportée par les clients WebSocket (web
 * et React Native) au moment du handshake, qui ne permet pas toujours de définir des en-têtes
 * arbitraires. Choix d'implémentation non spécifié, posé par L0-04 -- conservé tel quel.
 */
function extractToken(request: IncomingMessage): string | null {
  const url = new URL(request.url ?? '', 'http://internal');
  return url.searchParams.get('token');
}

export function authenticateConnection(request: IncomingMessage, config: Config): AuthenticationResult {
  const token = extractToken(request);
  if (!token) {
    return { ok: false, closeCode: WS_CLOSE_UNAUTHENTICATED, reason: 'jeton applicatif manquant' };
  }

  const result = verifyApplicationTokenWithReason(token, config.JWT_SECRET);
  if (!result.ok) {
    return result.reason === 'expired'
      ? { ok: false, closeCode: WS_CLOSE_TOKEN_EXPIRED, reason: 'jeton applicatif expiré' }
      : { ok: false, closeCode: WS_CLOSE_UNAUTHENTICATED, reason: 'jeton applicatif invalide' };
  }

  const { claims } = result;
  const context: ConnectionContext = Object.freeze({
    userId: claims.sub,
    role: claims.role,
    driverId: claims.role === 'driver' ? claims.driverId ?? null : null,
  });

  return { ok: true, context, expiresAtMs: claims.exp * 1000 };
}

/**
 * Garde générique d'identité (critère d'acceptation 3) : un identifiant porté par un message
 * entrant doit toujours correspondre à celui de la connexion, jamais le redéfinir. Aucun message
 * du contrat C-02 actuel (packages/contracts/src/realtime/client-to-server.ts) ne porte
 * aujourd'hui de champ `driverId`/`userId` dans son payload -- ce garde-fou existe par
 * anticipation, pour que le premier message qui en portera un (position.update, une fois L3-02
 * écrit) n'ait qu'à l'appeler, pas à le réinventer. Documenté dans le rapport de nuit plutôt que
 * laissé implicite : voir amoa/questions/L3-01.md.
 */
export function matchesConnectionIdentity(
  context: ConnectionContext,
  claimedUserId?: string | null
): boolean {
  if (claimedUserId === undefined || claimedUserId === null) return true;
  return claimedUserId === context.userId;
}

/**
 * Registre en mémoire des connexions actives, indexé par rôle et identifiant (spécification
 * L3-01), pour permettre l'émission ciblée -- utilisé par les tâches ultérieures du lot L3
 * (proposition, suivi) qui ont besoin de pousser un message vers UN chauffeur ou UN client
 * précis sans parcourir toutes les connexions ouvertes.
 */
export class ConnectionRegistry {
  private readonly byUserId = new Map<string, Set<WebSocket>>();
  private readonly byDriverId = new Map<string, Set<WebSocket>>();

  add(context: ConnectionContext, socket: WebSocket): void {
    this.addTo(this.byUserId, context.userId, socket);
    if (context.driverId) this.addTo(this.byDriverId, context.driverId, socket);
  }

  remove(context: ConnectionContext, socket: WebSocket): void {
    this.removeFrom(this.byUserId, context.userId, socket);
    if (context.driverId) this.removeFrom(this.byDriverId, context.driverId, socket);
  }

  getByUserId(userId: string): ReadonlySet<WebSocket> {
    return this.byUserId.get(userId) ?? new Set();
  }

  getByDriverId(driverId: string): ReadonlySet<WebSocket> {
    return this.byDriverId.get(driverId) ?? new Set();
  }

  private addTo(index: Map<string, Set<WebSocket>>, key: string, socket: WebSocket): void {
    const existing = index.get(key);
    if (existing) {
      existing.add(socket);
    } else {
      index.set(key, new Set([socket]));
    }
  }

  private removeFrom(index: Map<string, Set<WebSocket>>, key: string, socket: WebSocket): void {
    const existing = index.get(key);
    if (!existing) return;
    existing.delete(socket);
    if (existing.size === 0) index.delete(key);
  }
}
