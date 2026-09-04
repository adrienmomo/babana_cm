import type { Config } from '../config';

/**
 * Client Odoo sortant, authentifié par le secret partagé REALTIME_SHARED_SECRET (L0-04,
 * spécification), avec temporisation et réessais. `fetch` global de Node -- aucune dépendance
 * HTTP nouvelle nécessaire.
 */

const HEALTH_TIMEOUT_MS = 2000;

export async function pingOdoo(config: Config): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const response = await fetch(`${config.ODOO_INTERNAL_URL}/web/health`, {
        signal: controller.signal,
      });
      return response.ok;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

/**
 * Même patron que `pingOdoo` ci-dessus (`AbortController` + `setTimeout`, nettoyé dans un
 * `finally`), factorisé pour `callOdoo` et `callOdooOnce` (D71) : les deux seuls appels sortants
 * du service qui transportent le travail réel, donc les deux seuls qui doivent transformer un
 * Odoo silencieux en échec plutôt qu'en attente sans fin.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export interface CallOdooOptions {
  retries?: number;
  baseDelayMs?: number;
}

/**
 * Appel authentifié vers un contrôleur Odoo interne, avec réessais à délai croissant. Les
 * quatre écritures Odoo de la règle de partition (01-architecture.md §2) transitent par ici une
 * fois L3-* implémenté -- rien de plus ce soir que le mécanisme de transport lui-même.
 *
 * Chaque tentative est bornée par `ODOO_CALL_TIMEOUT_MS` (D71) : sans cela, un Odoo qui ne
 * répond ni n'échoue jamais n'atteint jamais la tentative suivante -- la boucle de réessai
 * ci-dessous ne protège de rien si le premier essai ne se termine pas.
 */
export async function callOdoo(
  config: Config,
  path: string,
  body: unknown,
  options: CallOdooOptions = {}
): Promise<unknown> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 200;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        `${config.ODOO_INTERNAL_URL}${path}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Realtime-Secret': config.REALTIME_SHARED_SECRET,
          },
          body: JSON.stringify(body),
        },
        config.ODOO_CALL_TIMEOUT_MS
      );
      if (!response.ok) {
        throw new Error(`Odoo a répondu ${response.status} pour ${path}`);
      }
      return await response.json();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

export interface CallOdooOnceResult {
  ok: boolean;
  status: number;
  body: unknown;
}

/**
 * Une seule tentative, sans réessai ni délai entre tentatives -- réservée à `odoo/outbox.ts`
 * (L3-12), qui porte lui-même sa propre temporisation croissante, persistante à travers un
 * redémarrage du service (`callOdoo` ci-dessus réessaie en mémoire, ce qui ne survivrait pas).
 * Ne lève jamais sur une réponse HTTP d'erreur (contrairement à `callOdoo`) : l'appelant a
 * besoin du statut et du corps pour distinguer un échec à rejouer d'un rejeu déjà appliqué (409
 * RIDE_INVALID_TRANSITION, silencieusement absorbé par l'idempotence d'Odoo, L4-03) -- seule une
 * erreur réseau (Odoo injoignable, timeout) lève encore, il n'y a alors ni statut ni corps à
 * distinguer.
 *
 * Le timeout ci-dessous (D71, `ODOO_CALL_TIMEOUT_MS`) était nommé dans ce commentaire avant
 * d'exister dans le code : sans lui, un Odoo qui se tait ne lève jamais, donc ne remonte jamais
 * ici comme un échec -- l'entrée reste "en cours" indéfiniment plutôt que d'être reprogrammée par
 * `attemptOutboxEntry`, et la file de rejeu qu'elle est censée alimenter ne se déclenche pas.
 * C'est le même défaut que `callOdoo`, une tentative plus loin dans la chaîne.
 */
export async function callOdooOnce(
  config: Config,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<CallOdooOnceResult> {
  const response = await fetchWithTimeout(
    `${config.ODOO_INTERNAL_URL}${path}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Realtime-Secret': config.REALTIME_SHARED_SECRET,
        ...headers,
      },
      body: JSON.stringify(body),
    },
    config.ODOO_CALL_TIMEOUT_MS
  );
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { ok: response.ok, status: response.status, body: parsed };
}
