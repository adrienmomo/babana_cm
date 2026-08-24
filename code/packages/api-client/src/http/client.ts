import { ZodError } from 'zod';
import { http } from '@babana/contracts';
import { ApiError } from './errors';
import { generateIdempotencyKey, isWriteMethod } from './idempotency';

/**
 * Client REST générique, construit directement sur le registre `HTTP_ENDPOINTS` de
 * @babana/contracts (C-01) : un seul endroit décrit méthode, chemin, schémas et erreurs -- ce
 * client ne redéclare rien (D17, critère d'acceptation 1). Généralise `http.ts` de L0-03 avec ce
 * que L6-03 ajoute : réessais, idempotence, traduction en français (`./errors.ts`).
 */

export interface ApiClientConfig {
  /** Ex. https://api.babana.cm -- jamais codée en dur dans les écrans (invariant 5). */
  baseUrl: string;
  getAccessToken?: () => string | null | undefined | Promise<string | null | undefined>;
  fetchImpl?: typeof fetch;
  /** Injectable pour les tests -- une vraie temporisation par défaut (setTimeout). */
  wait?: (ms: number) => Promise<void>;
  /** Tentatives réseau/serveur au-delà de la première (critère 2). Défaut 3. */
  maxRetries?: number;
  /** Délai avant le premier réessai, doublé à chaque tentative suivante. Défaut 300 ms. */
  retryBaseDelayMs?: number;
}

export type EndpointName = keyof typeof http.HTTP_ENDPOINTS;

export interface RequestOptions {
  pathParams?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string | number | boolean>;
  /** Remplace la clé auto-générée (L8-04) -- un appelant qui met sa propre écriture en file
   * hors connexion (`@babana/api-client` n'a pas de file persistante générique, L6-16) doit
   * pouvoir réutiliser la MÊME clé d'un appel `request()` à l'autre, sans quoi chaque tentative
   * de rejeu obtiendrait une nouvelle clé et pourrait dupliquer une écriture déjà reçue par le
   * serveur mais dont la réponse se serait perdue en chemin. Ignoré sur un GET (jamais
   * d'idempotence, isWriteMethod ci-dessous). */
  idempotencyKey?: string;
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Une erreur reçue avec un statut HTTP -- réseau ou serveur (>= 500) -- est rejouée (critère 2) :
 * le serveur n'a peut-être pas vu la requête, ou a échoué de façon transitoire. Une erreur
 * métier (4xx bien formée -- `DRIVER_ALREADY_TAKEN`, `NO_DRIVER_AVAILABLE`...) ne l'est **jamais** :
 * la rejouer ne produira jamais un succès et masquerait le vrai message à l'appelant (spécification
 * L6-03). `RATE_LIMITED` (429) n'est pas non plus rejoué automatiquement : un réessai aveugle
 * aggraverait la limitation plutôt que de la respecter.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500;
}

export function createHttpClient(config: ApiClientConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const wait = config.wait ?? defaultWait;
  const maxRetries = config.maxRetries ?? 3;
  const retryBaseDelayMs = config.retryBaseDelayMs ?? 300;

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

  async function attemptOnce<Name extends EndpointName>(
    name: Name,
    options: RequestOptions,
    idempotencyKey: string | undefined
  ): Promise<unknown> {
    // Type explicite plutôt qu'inféré : sans elle, TypeScript réduit `endpoint` à la forme
    // littérale exacte des seuls endpoints réellement présents dans HTTP_ENDPOINTS pour ce
    // `Name` générique -- ce qui, une fois `GET /drivers/nearby` retiré (le seul GET à porter un
    // requestSchema, amoa/questions/C-01R.md §1), rend la branche GET+requestSchema ci-dessous
    // statiquement invalide aux yeux du compilateur (aucun membre de l'union restante ne
    // satisfait `method: 'GET'` et `requestSchema` non nul en même temps). Le contrat général
    // (`HttpEndpointDescriptor`) reste correct : c'est lui qu'on veut ici, pas la précision
    // ponctuelle du registre actuel.
    const endpoint: http.HttpEndpointDescriptor = http.HTTP_ENDPOINTS[name];
    const url = buildUrl(endpoint.path, options.pathParams ?? {}, options.query);

    // GET ne porte pas de corps -- un requestSchema sur un endpoint GET décrirait les
    // paramètres de requête, déjà posés sur `url` par buildUrl() ci-dessus ; on ne fait ici que
    // vérifier leur forme avant l'envoi, on ne les sérialise pas une seconde fois dans un corps
    // qu'un GET n'a jamais dû porter (bug latent de l0-03, révélé en écrivant les tests de L6-03
    // -- aucun appelant n'exerçait encore un GET avec requestSchema). Aucun endpoint du contrat
    // ne prend cette branche aujourd'hui (`GET /drivers/nearby`, seul exemple, retiré du contrat
    // -- amoa/questions/C-01R.md §1) ; elle reste posée pour le prochain GET paramétré.
    let requestBody: string | undefined;
    if (endpoint.requestSchema) {
      if (endpoint.method === 'GET') {
        endpoint.requestSchema.parse(options.query ?? {});
      } else {
        const parsed = endpoint.requestSchema.parse(options.body ?? {});
        requestBody = JSON.stringify(parsed);
      }
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (endpoint.requiresAuth && config.getAccessToken) {
      const token = await config.getAccessToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const response = await fetchImpl(url, {
      method: endpoint.method,
      headers,
      body: requestBody,
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const parsedError = http.ApiErrorSchema.safeParse(payload);
      const apiError = parsedError.success
        ? new ApiError(parsedError.data.error.code, parsedError.data.error.message, response.status, parsedError.data.error.details)
        : new ApiError('INTERNAL_ERROR', `Réponse d'erreur non reconnue (HTTP ${response.status})`, response.status, payload);
      throw apiError;
    }

    return endpoint.responseSchema.parse(payload);
  }

  async function request<Name extends EndpointName>(name: Name, options: RequestOptions = {}): Promise<unknown> {
    const endpoint = http.HTTP_ENDPOINTS[name];
    const idempotencyKey = isWriteMethod(endpoint.method) ? options.idempotencyKey ?? generateIdempotencyKey() : undefined;

    let attempt = 0;
    for (;;) {
      try {
        return await attemptOnce(name, options, idempotencyKey);
      } catch (error) {
        // C-01R (amoa/questions/C-01.md) : une ZodError -- schéma de requête OU de réponse --
        // n'est PAS une erreur réseau. `attemptOnce` la lève après que `fetch` a déjà résolu
        // (réponse reçue, `response.ok` vérifié) : la requête HTTP a pleinement réussi, c'est sa
        // lecture qui échoue. La rejouer réapplique une écriture déjà faite, avec la même
        // Idempotency-Key -- sans danger côté serveur (C-01R corrige aussi le cache
        // d'idempotence Odoo), mais sans le moindre espoir de succès non plus : le même défaut
        // de schéma échouera identiquement à chaque tentative jusqu'à épuisement des réessais.
        // Seul un `fetch` qui a levé avant toute réponse, ou un `ApiError` de statut >= 500,
        // justifie un réessai.
        const retryable = error instanceof ZodError ? false : error instanceof ApiError ? isRetryableStatus(error.status) : true;
        if (!retryable || attempt >= maxRetries) throw error;
        await wait(retryBaseDelayMs * 2 ** attempt);
        attempt += 1;
      }
    }
  }

  return { request };
}

export type HttpClient = ReturnType<typeof createHttpClient>;
