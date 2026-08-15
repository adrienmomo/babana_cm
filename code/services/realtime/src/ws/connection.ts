import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Config } from '../config';
import {
  authenticateConnection,
  ConnectionRegistry,
  WS_CLOSE_TOKEN_EXPIRED,
  WS_CLOSE_UNAUTHENTICATED,
} from './auth';

// Réexportés pour compatibilité : posés ici par L0-04, avant que ws/auth.ts (L3-01) n'existe.
// test/ws.test.ts importe encore WS_CLOSE_UNAUTHENTICATED depuis ce module.
export { WS_CLOSE_UNAUTHENTICATED, WS_CLOSE_TOKEN_EXPIRED };

// setTimeout au-delà de cette valeur déclenche IMMÉDIATEMENT (le délai est un int32 signé côté
// Node) -- inatteignable avec un jeton d'une heure, mais D23 rouvre la question de sa durée de
// vie, et un jeton mal choisi fermerait alors toutes les connexions à l'instant de leur
// ouverture, avec le code "jeton expiré" -- le symptôme le plus déroutant possible (L3-01,
// amoa/questions/REPONSES-2026-08-15.md §6).
const MAX_SET_TIMEOUT_MS = 2 ** 31 - 1;

export function createConnectionHandler(config: Config) {
  const wss = new WebSocketServer({ noServer: true });
  const registry = new ConnectionRegistry();

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const auth = authenticateConnection(request, config);

    if (!auth.ok) {
      socket.close(auth.closeCode, auth.reason);
      return;
    }

    const { context, expiresAtMs } = auth;
    registry.add(context, socket);

    // Critère d'acceptation 5 : un jeton qui expire en cours de vie de la connexion la ferme --
    // la vérification à l'établissement (ci-dessus) ne couvre que l'instant du handshake, une
    // connexion WebSocket normale reste ouverte bien plus longtemps que la durée de vie d'un
    // jeton d'accès. `unref()` : ce minuteur ne doit jamais empêcher le processus de s'arrêter
    // proprement (tests, arrêt du service) s'il est le seul minuteur en attente.
    const msUntilExpiry = Math.min(Math.max(expiresAtMs - Date.now(), 0), MAX_SET_TIMEOUT_MS);
    const expiryTimer = setTimeout(() => {
      socket.close(WS_CLOSE_TOKEN_EXPIRED, 'jeton applicatif expiré en cours de connexion');
    }, msUntilExpiry);
    expiryTimer.unref();

    socket.on('close', () => {
      clearTimeout(expiryTimer);
      registry.remove(context, socket);
    });

    // Traitement des messages temps réel (C-02) : hors du lot de cette nuit au-delà de
    // l'authentification (L3-02 et suivants). Le contexte ci-dessus est déjà la seule source
    // d'autorisation qu'un futur gestionnaire de message devra consulter -- voir
    // ws/auth.ts:matchesConnectionIdentity.
  });

  return wss;
}
