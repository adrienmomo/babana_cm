import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Config } from '../config';
import { verifyApplicationToken } from './token';

/**
 * Code de fermeture documenté pour une connexion non authentifiée (critère d'acceptation 2 de
 * L0-04). Plage 4000-4999 réservée à l'usage applicatif par la spécification WebSocket (RFC
 * 6455 §7.4.2) -- 4401 fait écho à HTTP 401 pour rester lisible côté client.
 */
export const WS_CLOSE_UNAUTHENTICATED = 4401;

/**
 * Le jeton voyage en paramètre de requête (`?token=...`) plutôt qu'en en-tête HTTP personnalisé
 * à la connexion : c'est la méthode la plus largement supportée par les clients WebSocket (web
 * et React Native) au moment du handshake, qui ne permet pas toujours de définir des en-têtes
 * arbitraires. Choix d'implémentation non spécifié -- voir le message de commit.
 */
function extractToken(request: IncomingMessage): string | null {
  const url = new URL(request.url ?? '', 'http://internal');
  return url.searchParams.get('token');
}

export function createConnectionHandler(config: Config) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const token = extractToken(request);
    const claims = token ? verifyApplicationToken(token, config.JWT_SECRET) : null;

    if (!claims) {
      socket.close(WS_CLOSE_UNAUTHENTICATED, 'jeton applicatif manquant ou invalide');
      return;
    }

    // Traitement des messages temps réel (C-02) : hors du lot de cette nuit (L3-*). Le
    // squelette s'arrête à l'authentification établie, comme le demande L0-04.
  });

  return wss;
}
