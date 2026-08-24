import { createRealtimeClient, type ConnectionState, type RealtimeClient, type WebSocketLike } from '@babana/api-client';
import type { realtime } from '@babana/contracts';
import { REALTIME_WS_URL } from '../config';
import { authClient, onSessionLost } from './auth';

/**
 * Client temps réel partagé de l'app Chauffeur (L6-11, première consommation réelle de L6-04
 * côté Chauffeur) -- même patron que `apps/client/src/realtime.ts` (voir ce fichier pour le
 * détail du raisonnement) : un seul WebSocket par session, connexion ouverte au niveau de l'app
 * et non d'un écran, `onRealtimeMessage` diffusé à autant d'abonnés que l'app en compte.
 */
const listeners = new Set<(message: realtime.ServerToClientMessage) => void>();
const connectionStateListeners = new Set<(state: ConnectionState) => void>();

export const realtimeClient: RealtimeClient = createRealtimeClient({
  url: REALTIME_WS_URL,
  createWebSocket: (url) => new WebSocket(url) as unknown as WebSocketLike,
  getAccessToken: () => authClient.getAccessToken(),
  onMessage: (message) => listeners.forEach((listener) => listener(message)),
  onConnectionStateChange: (state) => connectionStateListeners.forEach((listener) => listener(state)),
  onTokenExpired: () => {
    authClient.refresh().catch(() => {
      authClient.handleRefreshFailure().catch(() => {
        // handleRefreshFailure() ne devrait jamais rejeter (logout() est déjà best-effort en
        // interne) -- filet défensif, pas un chemin attendu.
      });
    });
  },
});

/** Abonnement à un message entrant, quel que soit l'écran qui consomme (`proposal.new`,
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
