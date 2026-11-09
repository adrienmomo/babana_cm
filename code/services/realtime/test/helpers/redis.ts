/**
 * Redis des tests unitaires du service (8 novembre). `make test` tourne pile démarrée : le service
 * temps réel du conteneur `realtime` travaille sur le même serveur Redis, et sa réconciliation
 * d'engagement (driver/reconcile.ts, toutes les 20 s) efface comme « orphelin » tout chauffeur
 * engagé qu'Odoo ne connaît pas -- c'est-à-dire ceux que ces tests engagent sur une course
 * inventée. Constaté : `r5-engaged-…` effacé en pleine attente de reservation.test.ts. Une base
 * distincte de celle du service (test/redis-isolation.test.ts) le met hors d'atteinte.
 */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
