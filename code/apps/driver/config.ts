/**
 * Configuration lue depuis l'environnement de build, jamais codée en dur dans un écran
 * (invariant 5 ; critère d'acceptation 7 de L0-03). `babel-plugin-transform-inline-environment-
 * variables` (babel.config.js) substitue `process.env.X` par sa valeur au moment du bundle --
 * ces valeurs sont donc figées à la construction, pas lues sur l'appareil au démarrage.
 *
 * Développement : `BABANA_API_URL=https://api.localhost npm run start -w @babana/driver`
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
