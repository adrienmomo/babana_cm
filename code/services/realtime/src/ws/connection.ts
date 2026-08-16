import type { IncomingMessage } from 'node:http';
import type Redis from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';
import type { Config } from '../config';
import {
  authenticateConnection,
  ConnectionRegistry,
  WS_CLOSE_TOKEN_EXPIRED,
  WS_CLOSE_UNAUTHENTICATED,
} from './auth';
import { createMessageDispatcher } from './dispatch';
import { DisconnectGraceTimers } from '../driver/availability';
import { NearbyManager } from '../nearby/handler';
import { ProposalLifecycle } from '../proposal/lifecycle';

// Réexportés pour compatibilité : posés ici par L0-04, avant que ws/auth.ts (L3-01) n'existe.
// test/ws.test.ts importe encore WS_CLOSE_UNAUTHENTICATED depuis ce module.
export { WS_CLOSE_UNAUTHENTICATED, WS_CLOSE_TOKEN_EXPIRED };

// setTimeout au-delà de cette valeur déclenche IMMÉDIATEMENT (le délai est un int32 signé côté
// Node) -- inatteignable avec un jeton d'une heure, mais D23 rouvre la question de sa durée de
// vie, et un jeton mal choisi fermerait alors toutes les connexions à l'instant de leur
// ouverture, avec le code "jeton expiré" -- le symptôme le plus déroutant possible (L3-01,
// amoa/questions/REPONSES-2026-08-15.md §6).
const MAX_SET_TIMEOUT_MS = 2 ** 31 - 1;

export function createConnectionHandler(config: Config, redis: Redis) {
  const wss = new WebSocketServer({ noServer: true });
  const registry = new ConnectionRegistry();
  const nearby = new NearbyManager(config, redis);
  // registry est aussi le registre d'émission ciblée de ProposalLifecycle (L3-07) : proposal.new
  // au chauffeur, ride.assigned/ride.rejected au client -- même registre que celui qui suit les
  // connexions actives (spécification L3-01).
  const proposals = new ProposalLifecycle(config, redis, registry);
  const dispatch = createMessageDispatcher(config, redis, nearby, proposals);
  const disconnectGrace = new DisconnectGraceTimers();

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const auth = authenticateConnection(request, config);

    if (!auth.ok) {
      socket.close(auth.closeCode, auth.reason);
      return;
    }

    const { context, expiresAtMs } = auth;
    registry.add(context, socket);

    // Une reconnexion avant l'échéance de la période de grâce (L3-04, critère 3) annule la
    // sortie du pool programmée par la déconnexion précédente -- sans ça, un chauffeur qui
    // retrouve du réseau juste à temps sortirait quand même du pool par la faute d'un minuteur
    // qui n'a plus lieu d'être.
    if (context.role === 'driver' && context.driverId) {
      disconnectGrace.cancel(context.driverId);
    }

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
      // Un abonnement nearby.subscribe ne doit pas survivre à la connexion qui l'a ouvert (L3-05,
      // critère 5 -- même principe qu'un seul abonnement actif par client) : sans ça, une
      // reconnexion laisserait un minuteur orphelin continuer à interroger Redis pour un socket
      // fermé, jusqu'au prochain nearby.subscribe qui l'aurait de toute façon remplacé.
      nearby.unsubscribe(context);

      // Critère d'acceptation 3 : une déconnexion réseau ne met pas hors ligne immédiatement --
      // période de grâce configurable, puis sortie du pool (L3-04). Rien à faire pour un client :
      // seuls les chauffeurs ont une disponibilité à gérer.
      if (context.role === 'driver' && context.driverId) {
        disconnectGrace.schedule(redis, context.driverId, config.AVAILABILITY_DISCONNECT_GRACE_SECONDS);
      }
    });

    // Le contexte posé à l'authentification est la seule source d'autorisation consultée par le
    // dispatcher -- aucun message entrant ne peut redéfinir qui l'envoie (L3-01, critère 3).
    socket.on('message', (data) => {
      dispatch(context, socket, data.toString()).catch(() => {
        // ingestPosition/dispatch ne devraient pas lever (erreurs métier renvoyées en valeur) --
        // filet défensif : une position perdue ne doit jamais fermer la connexion.
      });
    });
  });

  return wss;
}
