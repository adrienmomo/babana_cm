import { randomUUID } from '../uuid';

/**
 * JSON-RPC pour les lectures secondaires (historique, factures, profil) -- `01-architecture.md`
 * §5 : les chemins critiques passent par des contrôleurs explicites (C-01), le reste par
 * JSON-RPC natif Odoo plutôt que par un endpoint dédié pour chaque champ affiché.
 *
 * **Ce que ce fichier ne peut pas encore prouver.** Le JSON-RPC natif d'Odoo authentifie par
 * session de cookie (`/web/session/authenticate`, `db`/`login`/`password`) ou par
 * `(db, uid, password)` explicites dans les arguments (`/jsonrpc`, `service: 'object'` --
 * utilisé tel quel par `test/concurrency/helpers/odoo-session.ts` pour préparer des fixtures,
 * avec des identifiants de service, pas ceux d'un utilisateur mobile). Aucun des deux ne
 * comprend le jeton applicatif Bearer que porte ce client (D4, L1-02) -- et aucun contrôleur
 * Odoo n'expose aujourd'hui de pont JSON-RPC authentifié par ce jeton. Ce fichier pose donc le
 * client (forme de l'enveloppe JSON-RPC 2.0, en-tête Bearer), testé contre un point de
 * terminaison simulé ; le brancher sur un vrai lecture (L6-10, historique/factures) suppose
 * qu'un contrôleur Odoo apprenne à accepter ce jeton pour ce chemin -- hors du périmètre de
 * cette tâche, à signaler quand L6-10 s'ouvrira si ce pont n'existe toujours pas.
 */
export interface JsonRpcConfig {
  /** Ex. https://api.babana.cm/jsonrpc */
  url: string;
  getAccessToken?: () => string | null | undefined | Promise<string | null | undefined>;
  fetchImpl?: typeof fetch;
}

export interface JsonRpcCall {
  model: string;
  method: string;
  args?: unknown[];
  kwargs?: Record<string, unknown>;
}

export class JsonRpcError extends Error {
  constructor(
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

export function createJsonRpcClient(config: JsonRpcConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;

  async function call<T>(request: JsonRpcCall): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.getAccessToken) {
      const token = await config.getAccessToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        id: randomUUID(),
        params: {
          model: request.model,
          method: request.method,
          args: request.args ?? [],
          kwargs: request.kwargs ?? {},
        },
      }),
    });

    const payload = (await response.json()) as { result?: T; error?: { message?: string; data?: unknown } };
    if (payload.error) {
      throw new JsonRpcError(payload.error.message ?? 'Erreur JSON-RPC', payload.error.data);
    }
    return payload.result as T;
  }

  return { call };
}

export type JsonRpcClient = ReturnType<typeof createJsonRpcClient>;
