/**
 * Sous-ensemble structurel de `WebSocket` (paquet `ws`) -- suffisant pour ce module, et ce qui
 * permet à `test/liveness.test.ts` de l'exercer avec une imitation minimale plutôt qu'une vraie
 * connexion réseau (déterministe, pas de dépendance à la vitesse réelle d'un aller-retour TCP
 * local).
 */
export interface LivenessSocket {
  on(event: 'pong', listener: () => void): unknown;
  ping(): void;
  terminate(): void;
}

export interface LivenessServer {
  readonly clients: Iterable<LivenessSocket>;
  on(event: 'connection', listener: (socket: LivenessSocket) => void): unknown;
}

/**
 * Détection de connexion à moitié fermée (L3-20, volet serveur -- D47,
 * amoa/questions/REPONSES-2026-08-30.md §1). Le cas courant sur un réseau mobile intermittent :
 * rien n'arrive, `close`/`error` ne se déclenchent jamais côté serveur non plus. Distinct du flux
 * mort sur une connexion vivante (`nearby/handler.ts`, `tracking/broadcast.ts`, même nuit) : ici
 * c'est le TRANSPORT lui-même qui ne répond plus, pas un abonnement applicatif -- un battement de
 * cœur au niveau WebSocket (ping/pong du protocole, invisible à l'application) est donc le bon
 * outil pour CE cas précis, sans se substituer à la surveillance par abonnement pour l'autre.
 *
 * Un ping toutes les `intervalMs` ; une connexion qui n'a pas répondu par un pong avant le
 * battement suivant est terminée de force (`socket.terminate()`), ce qui déclenche `close` et
 * donc tout le nettoyage déjà en place (`ws/connection.ts` : `registry.remove`,
 * `nearby.unsubscribe`, `tracking.unsubscribe`, `disconnectGrace.schedule`). Sans ça, le service
 * continuerait à calculer des diffusions périodiques pour un registre qui grossit indéfiniment,
 * vers des connexions mortes que personne ne referme jamais (spécification L3-20, "le service
 * diffuse indéfiniment vers personne et son registre grossit").
 */
export function installLivenessHeartbeat(wss: LivenessServer, intervalMs: number): { stop: () => void } {
  // Marqueur "a répondu depuis le dernier battement", par connexion -- WeakSet plutôt qu'une
  // propriété posée directement sur le socket (aucune dépendance de forme sur l'objet `ws`, pas
  // de risque de collision avec un champ interne de la bibliothèque).
  const respondedSinceLastBeat = new WeakSet<LivenessSocket>();

  wss.on('connection', (socket) => {
    // Une connexion tout juste ouverte a droit à un premier battement complet avant d'être jugée
    // -- sans ça, une connexion lente à établir son premier aller-retour serait terminée dès le
    // premier balayage.
    respondedSinceLastBeat.add(socket);
    socket.on('pong', () => {
      respondedSinceLastBeat.add(socket);
    });
  });

  const sweep = setInterval(() => {
    for (const socket of wss.clients) {
      if (!respondedSinceLastBeat.has(socket)) {
        socket.terminate();
        continue;
      }
      respondedSinceLastBeat.delete(socket);
      socket.ping();
    }
  }, intervalMs);
  // unref() : même raisonnement que tous les autres minuteurs du service (nearby/handler.ts,
  // tracking/broadcast.ts, driver/availability.ts) -- ne doit jamais empêcher un arrêt propre.
  sweep.unref();

  return {
    stop: () => clearInterval(sweep),
  };
}
