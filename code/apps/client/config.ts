/**
 * Configuration lue depuis l'environnement de build, jamais codée en dur dans un écran
 * (invariant 5 ; critère d'acceptation 7 de L0-03). `babel-plugin-transform-inline-environment-
 * variables` (babel.config.js) substitue `process.env.X` par sa valeur au moment du bundle --
 * ces valeurs sont donc figées à la construction, pas lues sur l'appareil au démarrage.
 *
 * Développement : `BABANA_API_URL=https://api.localhost npm run start -w @babana/client`
 * (même variable BABANA_DOMAIN que le reste de la pile, voir infra/env/.env.example, L0-06).
 * Production : valeur par défaut ci-dessous, correspondant au domaine réel (D18).
 */
export const API_BASE_URL = process.env.BABANA_API_URL || 'https://api.babana.cm';
export const REALTIME_WS_URL = process.env.BABANA_REALTIME_WS_URL || 'wss://api.babana.cm/rt/ws';

/**
 * Google Sign-In natif (L6-02, D22) -- `GOOGLE_WEB_CLIENT_ID` doit être l'un des identifiants
 * listés dans `GOOGLE_OAUTH_CLIENT_IDS` côté serveur (`infra/env/.env.example`), jamais
 * l'identifiant Android (celui-ci se déduit côté console Google du nom de package et de
 * l'empreinte SHA-1 du certificat de signature, jamais passé en configuration ici).
 */
export const GOOGLE_WEB_CLIENT_ID = process.env.BABANA_GOOGLE_WEB_CLIENT_ID || '';
export const GOOGLE_IOS_CLIENT_ID = process.env.BABANA_GOOGLE_IOS_CLIENT_ID || undefined;

/**
 * Clé Google Maps pour les appels REST du paquet @babana/maps (Places, Geocoding, L6-01) --
 * distincte du réglage de build natif qui affiche la carte elle-même (AndroidManifest.xml /
 * Info.plist, hors de ce fichier). Injectée ici (L6-00, critère d'acceptation 7 :
 * `configureMapsProvider` appelé une fois au démarrage, à un endroit unique et nommé --
 * `src/bootstrap.ts`) plutôt que lue directement dans `@babana/maps`, qui est prébuilt et ne
 * passe pas par ce mécanisme d'inlining (voir `providers/google/config.ts`).
 */
export const GOOGLE_MAPS_API_KEY = process.env.BABANA_GOOGLE_MAPS_API_KEY || '';

/**
 * Adresse de la recherche de lieu REST (`searchPlace`, L6-01) -- même mécanisme que
 * `GOOGLE_ROUTING_URL` côté Odoo (`services/odoo/addons/babana/services/routing.py`) : une seule
 * variable d'environnement, aucune branche sur l'environnement dans le code (D19,
 * `amoa/questions/C-01R.md` §2). `undefined` laisse `@babana/maps` retomber sur l'adresse Google
 * réelle (`providers/google/places.ts::PLACES_TEXT_SEARCH_URL`) -- le comportement de production
 * si la variable est absente. En développement, `infra/env/.env.example` la pointe vers
 * `mock-maps` (port hôte exposé directement, `infra/compose.dev.yaml`, pas besoin de Caddy).
 */
export const MAPS_SEARCH_URL = process.env.BABANA_MAPS_SEARCH_URL || undefined;
