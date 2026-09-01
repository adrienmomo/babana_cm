/**
 * Configuration de l'export web (D22, L6-18). Webpack résout `config.web.ts` avant `config.ts`
 * (`resolve.extensions`, webpack.config.js) : c'est ici, et jamais dans un écran, que vit la
 * différence de plateforme pour l'adresse de l'API (même règle que `location.web.ts`).
 *
 * **Même origine, aucun CORS (D46, 29 août).** Caddy sert le bundle et proxifie `/api/*` et
 * `/rt/*` sous le même domaine (`infra/caddy/Caddyfile`). Les appels partent donc en relatif
 * vers l'origine qui a servi la page — pas de préflight, pas d'en-tête CORS sur une API à jeton
 * porteur. Le blocage `OPTIONS /api/v1/quote → 401` rencontré en vérification
 * (`amoa/questions/L6-18-cors-api-web-quote.md`) venait d'un banc d'essai à deux origines ;
 * servi sous une seule, il ne peut plus se produire.
 *
 * `process.env.*` reste prioritaire (inliné au build par `babel-plugin-transform-inline-
 * environment-variables`) : une prévisualisation qui pointerait explicitement ailleurs
 * (`staging.babana.cm`) garde la main. Sinon, l'origine courante.
 */
const runtimeOrigin =
  typeof window !== 'undefined' && window.location ? window.location.origin : '';

export const API_BASE_URL = process.env.BABANA_API_URL || runtimeOrigin;

export const REALTIME_WS_URL =
  process.env.BABANA_REALTIME_WS_URL ||
  (runtimeOrigin ? `${runtimeOrigin.replace(/^http/, 'ws')}/rt/ws` : '');

export const GOOGLE_WEB_CLIENT_ID = process.env.BABANA_GOOGLE_WEB_CLIENT_ID || '';
export const GOOGLE_IOS_CLIENT_ID = process.env.BABANA_GOOGLE_IOS_CLIENT_ID || undefined;
export const GOOGLE_MAPS_API_KEY = process.env.BABANA_GOOGLE_MAPS_API_KEY || '';

/**
 * Recherche de lieu (`searchPlace`, L6-01) : inchangée par rapport au natif — `mock-maps` en
 * développement (port hôte direct, CORS ouvert, `services/mocks/maps/src/index.js`), l'API
 * Google réelle en production. Ce n'est pas une API à jeton, D46 ne s'y applique pas.
 */
export const MAPS_SEARCH_URL = process.env.BABANA_MAPS_SEARCH_URL || undefined;
