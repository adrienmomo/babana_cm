import { z } from 'zod';

/**
 * Toute la configuration vient de variables d'environnement, validées au démarrage (L0-04,
 * spécification). `parseConfig` est une fonction pure -- testable sans toucher au vrai
 * `process.env` -- appelée avec effet de bord (message nommant la variable manquante, puis
 * `process.exit(1)`) uniquement depuis index.ts, le point d'entrée réel du service.
 */
const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  REDIS_URL: z.string().min(1, 'REDIS_URL est requis'),
  ODOO_INTERNAL_URL: z.string().min(1, 'ODOO_INTERNAL_URL est requis'),
  REALTIME_SHARED_SECRET: z.string().min(1, 'REALTIME_SHARED_SECRET est requis'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET est requis'),

  // --- Seuils, rayon, délais (L3-02, L3-03, L3-04) ------------------------------------------
  //
  // PROVISOIRE au sens de D21 (amoa/05-prerequis-et-simulation.md) : ces valeurs métier
  // devraient vivre en base, via les réglages Odoo (L9-06), pas en variable d'environnement --
  // mais le service temps réel n'a et ne doit avoir aucun client PostgreSQL (invariant 1), et
  // aucun canal de lecture de configuration Odoo -> temps réel n'existe encore. Écart détaillé
  // et assumé dans amoa/questions/L3-02.md. Toutes les valeurs par défaut sont plausibles (D21),
  // pas arbitraires -- le rectangle englobant de Douala est repris tel quel de
  // services/odoo/addons/babana/data/babana_zone_default.xml plutôt que réinventé.

  /** Zone d'exploitation (L3-02, validation de plausibilité des positions). */
  OPERATIONAL_BOUNDS_MIN_LAT: z.coerce.number().default(3.95),
  OPERATIONAL_BOUNDS_MAX_LAT: z.coerce.number().default(4.15),
  OPERATIONAL_BOUNDS_MIN_LNG: z.coerce.number().default(9.60),
  OPERATIONAL_BOUNDS_MAX_LNG: z.coerce.number().default(9.85),

  /** Durée de vie d'une position en Redis -- "de l'ordre de la minute" (L3-02). */
  POSITION_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  /** Précision au-delà de laquelle une position pollue le géo-index (L3-02). */
  POSITION_MAX_ACCURACY_METERS: z.coerce.number().positive().default(150),
  /** Tolérance d'horloge avant de rejeter une position "dans le futur" (L3-02). */
  POSITION_MAX_TIMESTAMP_FUTURE_MS: z.coerce.number().int().nonnegative().default(5_000),
  /** Au-delà, une position est "trop ancienne" (L3-02). */
  POSITION_MAX_TIMESTAMP_AGE_MS: z.coerce.number().int().positive().default(30_000),
  /** ~140 km/h : au-delà, un déplacement implicite est un artefact GPS, pas une moto (L3-02). */
  POSITION_MAX_IMPLIED_SPEED_MPS: z.coerce.number().positive().default(38.9),

  /** Rayon maximal d'une requête de chauffeurs proches, quel que soit le rayon demandé (L3-03). */
  NEARBY_MAX_RADIUS_METERS: z.coerce.number().positive().default(5_000),

  /** Période de grâce avant sortie du pool sur déconnexion réseau (L3-04). */
  AVAILABILITY_DISCONNECT_GRACE_SECONDS: z.coerce.number().int().positive().default(45),

  /** Durée de vie d'une réservation de chauffeur (L3-06) avant libération automatique -- doit
   * couvrir au moins le délai d'acceptation de la proposition (L3-07), avec marge incluse plutôt
   * qu'une valeur strictement égale : c'est le filet de sécurité qui survit à un redémarrage du
   * service (le minuteur JS de PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS, lui, ne survit pas). Vérifié
   * au niveau du schéma ci-dessous (`.refine`), pas seulement documenté ici. */
  RESERVATION_TTL_SECONDS: z.coerce.number().int().positive().default(45),

  /** Délai d'acceptation d'une proposition (L3-07), 30 s par défaut (L9-06). Seul juge de
   * l'expiration côté serveur -- le compte à rebours affiché côté chauffeur est indicatif. */
  PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),

  /** Fréquence de diffusion des mises à jour nearby.drivers pendant un abonnement actif (L3-05). */
  NEARBY_BROADCAST_INTERVAL_SECONDS: z.coerce.number().positive().default(5),
  /** Limitation de débit sur nearby.subscribe (L3-05, C2b -- empêche l'échantillonnage rapide de
   * la flotte) : au plus ce nombre d'abonnements par fenêtre glissante, par utilisateur. */
  NEARBY_RATE_LIMIT_MAX_SUBSCRIPTIONS: z.coerce.number().int().positive().default(10),
  NEARBY_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().positive().default(60),

  /** Durée pendant laquelle la dernière liste des 5 envoyée à un client reste opposable (L3-17,
   * précondition C-03 -- "chauffeur présent dans la dernière liste des 5") : doit dépasser
   * `NEARBY_BROADCAST_INTERVAL_SECONDS` d'une marge confortable, le temps qu'un client tape
   * "sélectionner" après avoir VU la liste, pas seulement jusqu'à la diffusion suivante. */
  NEARBY_LAST_SENT_TTL_SECONDS: z.coerce.number().int().positive().default(30),

  /** Fenêtre pendant laquelle l'endpoint interne de réservation (L3-17, `/internal/reservations`)
   * rejoue la réponse d'un appel déjà traité plutôt que de le recalculer -- doit dépasser le
   * budget de rejeu d'Odoo sur conflit de sérialisation PostgreSQL (D25,
   * `odoo.service.model.retrying`, MAX_TRIES_ON_CONCURRENCY_FAILURE avec temporisation aléatoire
   * croissante) : c'est le piège central de L3-17, un appel sortant non idempotent dans une
   * transaction rejouable. Valeur volontairement large, pas ajustée au plus juste. */
  RESERVATION_IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(60),

  /** Période de réconciliation des marqueurs d'engagement contre Odoo (L3-17) : le marqueur
   * n'expire jamais tout seul (D26) -- un seul échec le laisserait en place pour toujours sans
   * cette réconciliation périodique, qui aligne les marqueurs de Redis sur les courses réellement
   * actives dans Odoo (source de vérité, D27) et journalise l'écart constaté à chaque passage. */
  ENGAGEMENT_RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(20),
}).refine((config) => config.RESERVATION_TTL_SECONDS > config.PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS, {
  // Sans cette marge, le filet de sécurité Redis (RESERVATION_TTL_SECONDS) pourrait expirer une
  // réservation AVANT le minuteur JS qui doit normalement trancher en premier (proposal/timeout.ts)
  // -- une proposition expirerait alors sans que personne n'émette ride.rejected/proposal.expired,
  // silencieusement (L3-07).
  message:
    'RESERVATION_TTL_SECONDS doit être strictement supérieur à PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS (marge de sécurité, L3-07)',
  path: ['RESERVATION_TTL_SECONDS'],
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {}

/**
 * Lève une ConfigError dont le message nomme précisément chaque variable manquante ou invalide
 * (critère d'acceptation 3 de L0-04) -- jamais un échec silencieux ou générique.
 */
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(racine)'} : ${issue.message}`)
      .join('\n');
    throw new ConfigError(
      `Configuration invalide, le service refuse de démarrer :\n${details}`
    );
  }
  return result.data;
}
