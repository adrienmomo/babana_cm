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
