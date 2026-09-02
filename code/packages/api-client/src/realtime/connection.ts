import { realtime } from '@babana/contracts';
import { randomUUID } from '../uuid';
import { ActionQueue, createAsyncStorageActionQueue, type ActionQueueStorage, type QueuedAction } from './queue';
import { computeReconnectDelayMs, type ReconnectPolicyConfig } from './reconnect';
import { parseIncomingMessage, type ConnectionState } from './handlers';

/**
 * Client temps réel partagé (L6-04), qui généralise l'export minimal de L0-03 avec ce que la
 * spécification demande : reconnexion avec gigue (`./reconnect.ts`), file d'actions persistante
 * (`./queue.ts`), état de connexion exposé, validation défensive des messages entrants
 * (`./handlers.ts`). Pas de dépendance à `lib.dom` : `apps/*` fournissent leur propre
 * implémentation WebSocket (React Native en a une globale).
 */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface RealtimeClientConfig {
  /** Ex. wss://api.babana.cm/rt/ws -- jamais codée en dur dans les écrans (invariant 5). */
  url: string;
  createWebSocket: (url: string) => WebSocketLike;
  getAccessToken: () => string | null | undefined | Promise<string | null | undefined>;
  /** Dernier identifiant de course connu -- porté par `session.resync` à la reconnexion, pour que
   * le serveur cible sa resynchronisation (voir `SessionResyncPayloadSchema`, @babana/contracts). */
  getLastKnownRideId?: () => string | null;
  onMessage?: (message: realtime.ServerToClientMessage) => void;
  onConnectionStateChange?: (state: ConnectionState) => void;
  /** Jeton expiré (L3-01) -- l'appelant renouvelle (AuthClient.refresh(), L6-02) ; la reconnexion
   * automatique qui suit relira un jeton frais via `getAccessToken`. */
  onTokenExpired?: () => void;
  /** Jeton invalide ou absent (L3-01) -- aucune reconnexion automatique n'est tentée (rejouer le
   * même jeton invalide ne peut pas réussir) : l'appelant doit faire ré-authentifier
   * l'utilisateur (retour à l'écran de connexion, même mécanisme que `onSessionLost`, L6-02). */
  onUnauthenticated?: () => void;
  queueStorage?: ActionQueueStorage;
  reconnectPolicy?: ReconnectPolicyConfig;
  /** Injectable pour les tests -- une vraie temporisation par défaut. */
  wait?: (ms: number) => Promise<void>;
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Déclarations d'intérêt courant, jamais des actions métier (L3-20, cause racine du 30 août --
 * `amoa/questions/L3-05-nearby-list-goes-silently-empty.md`). Chaque écran qui les émet les
 * réémet déjà lui-même à chaque `connected` (`onRealtimeConnectionStateChange`, `HomeScreen`,
 * `TrackingScreen`) : les mettre en file les rendait rejouables une seconde fois, avec des
 * paramètres capturés au moment de l'émission d'origine -- potentiellement périmés (position de
 * découverte, rayon) au moment du rejeu, plusieurs secondes ou minutes plus tard. Le rejeu
 * arrivait alors en course avec la réémission fraîche : selon l'ordre de traitement côté
 * service, la file pouvait installer SON abonnement (périmé) en dernier, remplaçant définitivement
 * l'abonnement à jour sans qu'aucune erreur ne le signale -- exactement le silence observé sur
 * `nearby.drivers`. Même raisonnement que `position.update` juste en dessous (« une position
 * obsolète est pire que pas de position », L3-11) : une déclaration d'intérêt obsolète est pire
 * que son absence.
 */
/**
 * `proposal.accept`/`proposal.reject` (L6-16, "actions interdites hors connexion") : le motif
 * est différent des trois autres membres de cet ensemble -- ce ne sont pas des déclarations
 * d'intérêt réémises automatiquement, mais des actions à conséquence unique. La bonne réponse à
 * une déconnexion n'est jamais de les rejouer plus tard (une acceptation qui atteindrait enfin le
 * serveur après plusieurs minutes accepterait une course probablement déjà expirée ou attribuée
 * à quelqu'un d'autre) ni de les rejouer automatiquement à la reconnexion sans que le chauffeur
 * ne le redécide -- l'écran appelant (`ProposalScreen.tsx`) doit refuser l'action tout de suite,
 * avec explication, avant même d'atteindre `send()`. Les inscrire ici est une garde
 * supplémentaire, pas le mécanisme principal : si un appelant futur oublie de vérifier l'état de
 * connexion, ce message sera abandonné plutôt que rejoué à l'aveugle bien plus tard.
 */
const NEVER_QUEUED_MESSAGE_TYPES: ReadonlySet<realtime.ClientToServerMessage['type']> = new Set([
  'nearby.subscribe',
  'nearby.unsubscribe',
  'ride.track',
  'proposal.accept',
  'proposal.reject',
]);

function buildEnvelope<Type extends realtime.ClientToServerMessage['type']>(
  type: Type,
  payload: Extract<realtime.ClientToServerMessage, { type: Type }>['payload'],
  id: string = randomUUID()
) {
  return { type, id, emittedAt: new Date().toISOString(), payload };
}

export function createRealtimeClient(config: RealtimeClientConfig) {
  const queue = new ActionQueue(config.queueStorage ?? createAsyncStorageActionQueue());
  const wait = config.wait ?? defaultWait;

  let socket: WebSocketLike | null = null;
  let state: ConnectionState = 'offline';
  let reconnectAttempt = 0;
  let closedByCaller = false;
  let latestPosition: ReturnType<typeof buildEnvelope<'position.update'>> | null = null;

  function setState(next: ConnectionState) {
    if (state === next) return;
    state = next;
    config.onConnectionStateChange?.(next);
  }

  async function replayQueue() {
    for (const action of await queue.list()) {
      if (!socket || socket.readyState !== 1 /* OPEN */) return; // coupé pendant le rejeu -- le reste attendra la prochaine reconnexion
      socket.send(JSON.stringify({ type: action.type, id: action.id, emittedAt: action.queuedAt, payload: action.payload }));
      await queue.remove(action.id);
    }
  }

  async function scheduleReconnect() {
    if (closedByCaller) return;
    const delay = computeReconnectDelayMs(reconnectAttempt, config.reconnectPolicy);
    reconnectAttempt += 1;
    await wait(delay);
    if (closedByCaller) return;
    await connect();
  }

  /**
   * Async (contrairement à l'export minimal de L0-03) : le jeton se résout de façon asynchrone
   * (`AuthClient.getAccessToken()` peut lire le trousseau sécurisé, L6-02) et doit être connu
   * avant d'ouvrir le socket -- pas de consommateur existant à préserver (aucun écran n'appelle
   * encore ce client), rien ne justifiait de garder une signature synchrone au prix d'une
   * connexion ouverte sans son jeton.
   */
  async function connect(): Promise<void> {
    closedByCaller = false;
    setState('connecting');

    const token = await config.getAccessToken();
    const url = token ? `${config.url}?token=${encodeURIComponent(token)}` : config.url;
    const ws = config.createWebSocket(url);
    socket = ws;

    ws.onopen = () => {
      setState('connected');
      reconnectAttempt = 0;
      const resync = buildEnvelope('session.resync', { lastKnownRideId: config.getLastKnownRideId?.() ?? null });
      ws.send(JSON.stringify(resync));
      if (latestPosition) ws.send(JSON.stringify(latestPosition));
      void replayQueue();
    };

    ws.onmessage = (event) => {
      const message = parseIncomingMessage(event.data);
      if (message) config.onMessage?.(message);
    };

    ws.onclose = (event) => {
      socket = null;
      setState('offline');
      if (closedByCaller) return;

      if (event.code === realtime.WS_CLOSE_TOKEN_EXPIRED) {
        config.onTokenExpired?.();
        void scheduleReconnect(); // relira un jeton frais via getAccessToken() au prochain essai
        return;
      }
      if (event.code === realtime.WS_CLOSE_UNAUTHENTICATED) {
        config.onUnauthenticated?.(); // aucune reconnexion automatique -- rejouer le même jeton ne peut pas réussir
        return;
      }
      void scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose suit toujours onerror sur une implémentation WebSocket standard -- la
      // reconnexion est déclenchée depuis onclose, pas ici, pour n'avoir qu'un seul chemin.
    };
  }

  function disconnect(): void {
    closedByCaller = true;
    socket?.close(1000, 'fermeture demandée par l\'application');
    socket = null;
    setState('offline');
  }

  /**
   * Hors connexion : une écriture est mise en file (rejouée à la reconnexion, critère 2) ;
   * `position.update` ne l'est jamais (critère 4) -- seule la dernière position est retenue,
   * envoyée dès la prochaine connexion établie, jamais rattrapée en file.
   */
  function send<Type extends realtime.ClientToServerMessage['type']>(
    type: Type,
    payload: Extract<realtime.ClientToServerMessage, { type: Type }>['payload']
  ): void {
    // TypeScript ne relie pas le `Type` générique de `send` à celui de `buildEnvelope` à travers
    // cet appel (limitation connue des fonctions à dispatch générique) -- `payload` est déjà
    // garanti correct par la signature de `send` elle-même, l'assertion ne fait que rétablir ce
    // que le contexte a déjà vérifié.
    const envelope = buildEnvelope(type, payload as never);

    if (type === 'position.update') {
      latestPosition = envelope as ReturnType<typeof buildEnvelope<'position.update'>>;
      if (socket && socket.readyState === 1) socket.send(JSON.stringify(envelope));
      return;
    }

    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify(envelope));
      return;
    }

    if (NEVER_QUEUED_MESSAGE_TYPES.has(type)) {
      // Silencieusement abandonné, jamais mis en file (voir le commentaire au-dessus de
      // NEVER_QUEUED_MESSAGE_TYPES) : l'écran appelant réémettra lui-même dès la prochaine
      // connexion établie, avec des paramètres à jour.
      return;
    }

    void queue.enqueue({
      id: envelope.id,
      type: envelope.type as QueuedAction['type'],
      payload: envelope.payload,
      queuedAt: envelope.emittedAt,
    });
  }

  function getState(): ConnectionState {
    return state;
  }

  return { connect, disconnect, send, getState };
}

export type RealtimeClient = ReturnType<typeof createRealtimeClient>;
