import { realtime } from '@babana/contracts';

/**
 * `node:crypto` n'existe pas dans le runtime React Native (Hermes) : ce paquet est consommé par
 * `apps/*`, donc pas de dépendance Node ici. Générateur UUID v4 minimal sur Math.random() --
 * suffisant pour un identifiant d'idempotence non secret, portable partout sans dépendance
 * nouvelle.
 */
function randomUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Client temps réel minimal, construit sur les schémas de @babana/contracts (C-02). Pas de
 * dépendance à `lib.dom` : `apps/*` fournissent leur propre implémentation WebSocket (React
 * Native en a une globale), ce paquet ne dépend que de la forme structurelle dont il a besoin.
 *
 * Politique de reconnexion (délai croissant, gigue, resynchronisation complète, file d'actions
 * rejouée avec son identifiant d'origine) : voir docs/contracts/realtime-events.md (C-02).
 * Implémentation complète de cette politique laissée à L6-* -- export minimal fonctionnel ce
 * soir (L0-03).
 */

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface RealtimeClientConfig {
  /** Ex. wss://api.babana.cm/rt/ws -- jamais codée en dur dans les écrans (invariant 5). */
  url: string;
  createWebSocket: (url: string) => WebSocketLike;
  onMessage?: (message: realtime.ServerToClientMessage) => void;
}

export function createRealtimeClient(config: RealtimeClientConfig) {
  let socket: WebSocketLike | null = null;

  function connect(): WebSocketLike {
    const ws = config.createWebSocket(config.url);
    ws.onmessage = (event) => {
      const parsed = realtime.ServerToClientMessageSchema.safeParse(JSON.parse(event.data));
      if (parsed.success) config.onMessage?.(parsed.data);
    };
    socket = ws;
    return ws;
  }

  function send<Type extends realtime.ClientToServerMessage['type']>(
    type: Type,
    payload: Extract<realtime.ClientToServerMessage, { type: Type }>['payload']
  ) {
    if (!socket) throw new Error('@babana/api-client: connect() doit être appelé avant send()');
    const message = {
      type,
      id: randomUUID(),
      emittedAt: new Date().toISOString(),
      payload,
    };
    socket.send(JSON.stringify(message));
  }

  return { connect, send };
}

export type RealtimeClient = ReturnType<typeof createRealtimeClient>;
