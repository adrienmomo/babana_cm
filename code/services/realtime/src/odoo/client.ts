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

export interface CallOdooOptions {
  retries?: number;
  baseDelayMs?: number;
}

/**
 * Appel authentifié vers un contrôleur Odoo interne, avec réessais à délai croissant. Les
 * quatre écritures Odoo de la règle de partition (01-architecture.md §2) transitent par ici une
 * fois L3-* implémenté -- rien de plus ce soir que le mécanisme de transport lui-même.
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
      const response = await fetch(`${config.ODOO_INTERNAL_URL}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Realtime-Secret': config.REALTIME_SHARED_SECRET,
        },
        body: JSON.stringify(body),
      });
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
