import { http } from '@babana/contracts';

/**
 * Client REST générique, construit directement sur le registre `HTTP_ENDPOINTS` de
 * @babana/contracts (C-01) : un seul endroit décrit méthode, chemin, schémas et erreurs -- ce
 * client ne redéclare rien (D17). Export minimal fonctionnel ce soir (L0-03) ; consommé par
 * `apps/client` et `apps/driver` dès maintenant, complété au fil des lots L1/L3/L6.
 */

export interface ApiClientConfig {
  /** Ex. https://api.babana.cm -- jamais codée en dur dans les écrans (invariant 5). */
  baseUrl: string;
  getAccessToken?: () => string | null | undefined | Promise<string | null | undefined>;
  fetchImpl?: typeof fetch;
}

export class ApiError extends Error {
  constructor(
    public readonly code: http.ErrorCode,
    message: string,
    public readonly status: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type EndpointName = keyof typeof http.HTTP_ENDPOINTS;

export interface RequestOptions {
  pathParams?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string | number | boolean>;
}

export function createHttpClient(config: ApiClientConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;

  function buildUrl(path: string, pathParams: Record<string, string>, query?: RequestOptions['query']) {
    let resolved = path;
    for (const [key, value] of Object.entries(pathParams)) {
      resolved = resolved.replace(`{${key}}`, encodeURIComponent(value));
    }
    const url = new URL(config.baseUrl.replace(/\/$/, '') + resolved);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  async function request<Name extends EndpointName>(
    name: Name,
    options: RequestOptions = {}
  ): Promise<unknown> {
    const endpoint = http.HTTP_ENDPOINTS[name];
    const url = buildUrl(endpoint.path, options.pathParams ?? {}, options.query);

    let requestBody: string | undefined;
    if (endpoint.requestSchema) {
      const parsed = endpoint.requestSchema.parse(options.body ?? {});
      requestBody = JSON.stringify(parsed);
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (endpoint.requiresAuth && config.getAccessToken) {
      const token = await config.getAccessToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetchImpl(url, {
      method: endpoint.method,
      headers,
      body: requestBody,
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const parsedError = http.ApiErrorSchema.safeParse(payload);
      if (parsedError.success) {
        throw new ApiError(
          parsedError.data.error.code,
          parsedError.data.error.message,
          response.status,
          parsedError.data.error.details
        );
      }
      throw new ApiError('INTERNAL_ERROR', `Réponse d'erreur non reconnue (HTTP ${response.status})`, response.status, payload);
    }

    return endpoint.responseSchema.parse(payload);
  }

  return { request };
}

export type HttpClient = ReturnType<typeof createHttpClient>;
