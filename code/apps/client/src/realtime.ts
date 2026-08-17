import { createRealtimeClient, type ConnectionState, type RealtimeClient, type WebSocketLike } from '@babana/api-client';
import type { realtime } from '@babana/contracts';
import { REALTIME_WS_URL } from '../config';
import { authClient, onSessionLost } from './auth';

/**
 * Client temps réel partagé de l'app (L6-06, première consommation réelle de L6-04). Un seul
 * WebSocket par session, comme `authClient`/`apiClient` (`./auth.ts`) : la connexion vit au
 * niveau de l'app, pas d'un écran -- HomeScreen (L6-06) est le premier consommateur, mais la
 * connexion doit rester ouverte pour les écrans suivants (Waiting, Tracking, L6-08/L6-09).
 *
 * `onMessage` de `createRealtimeClient` n'accepte qu'un seul callback global -- diffusé ici à
 * autant d'abonnés que l'app en compte (`onRealtimeMessage`), pour qu'un écran n'ait pas à
 * connaître les autres.
 */
const listeners = new Set<(message: realtime.ServerToClientMessage) => void>();
const connectionStateListeners = new Set<(state: ConnectionState) => void>();

export const realtimeClient: RealtimeClient = createRealtimeClient({
  url: REALTIME_WS_URL,
  createWebSocket: (url) => new WebSocket(url) as unknown as WebSocketLike,
  getAccessToken: () => authClient.getAccessToken(),
  onMessage: (message) => listeners.forEach((listener) => listener(message)),
  // Une reconnexion (coupure réseau puis retour, le cas courant à Douala) rouvre un socket sans
  // mémoire des abonnements précédents (`nearby.subscribe` n'est pas rejoué par la politique de
  // reconnexion, contrairement aux actions de la file -- @babana/api-client, connection.ts) :
  // diffusé pour que HomeScreen (L6-06) puisse réémettre son abonnement à chaque connexion
  // établie, initiale ou non.
  onConnectionStateChange: (state) => connectionStateListeners.forEach((listener) => listener(state)),
  // Jeton expiré (L3-01) : le renouvellement transparent des appels REST (apiClient) ne concerne
  // pas cette connexion séparée -- authClient.refresh() ici, la reconnexion automatique qui suit
  // relira un jeton frais (voir @babana/api-client, connection.ts). Un échec de renouvellement
  // (jeton de renouvellement révoqué/expiré) déclenche la même déconnexion propre que le client
  // REST -- authClient.handleRefreshFailure() efface le trousseau et appelle onSessionLost().
  onTokenExpired: () => {
    authClient.refresh().catch(() => {
      authClient.handleRefreshFailure().catch(() => {
        // handleRefreshFailure() ne devrait jamais rejeter (logout() est déjà best-effort en
        // interne) -- filet défensif, pas un chemin attendu.
      });
    });
  },
});

/** Abonnement à un message entrant, quel que soit l'écran qui consomme (`nearby.drivers`,
 * `session.synced`, ...) -- retourne la fonction de désabonnement, même convention que
 * `onSessionLost` (`./auth.ts`). */
export function onRealtimeMessage(listener: (message: realtime.ServerToClientMessage) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Abonnement aux changements d'état de connexion -- même convention que `onRealtimeMessage`. */
export function onRealtimeConnectionStateChange(listener: (state: ConnectionState) => void): () => void {
  connectionStateListeners.add(listener);
  return () => connectionStateListeners.delete(listener);
}

let connected = false;

/** Ouvre la connexion une seule fois par session -- idempotent, un écran qui la rappelle (parce
 * qu'il ignore si un écran précédent l'a déjà fait) n'ouvre jamais un second socket. */
export function ensureRealtimeConnected(): void {
  if (connected) return;
  connected = true;
  realtimeClient.connect().catch(() => {
    // La reconnexion automatique (côté client, connection.ts) prend déjà le relais sur un échec
    // ponctuel -- rien de plus à faire ici qu'éviter une rejection non gérée.
  });
}

onSessionLost(() => {
  connected = false;
  realtimeClient.disconnect();
});
