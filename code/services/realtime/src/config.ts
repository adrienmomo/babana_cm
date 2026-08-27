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

  /** Élargissement du rayon (L3-08), quand aucun chauffeur ne reste après exclusion des
   * refusants sur cette course -- ou qu'aucun n'était disponible dans le rayon initial. Palier
   * ajouté à chaque tentative, jusqu'au plafond ci-dessous. */
  NEARBY_EXPAND_RADIUS_STEP_METERS: z.coerce.number().positive().default(2_000),
  /** Plafond de l'élargissement (L3-08) -- au-delà, plus personne : `nearby.drivers` renvoie une
   * liste vide, que L6-08 traduit en `NO_DRIVER_AVAILABLE`. Distinct de
   * `NEARBY_MAX_RADIUS_METERS` : celui-ci borne une demande normale (C2b, anti-balayage), celui-là
   * ne s'applique qu'une fois les candidats les plus proches épuisés. Vérifié au niveau du schéma
   * ci-dessous (`.refine`) : l'élargissement doit avoir un rayon de départ strictement inférieur
   * à son propre plafond, sinon il n'élargit jamais rien. */
  NEARBY_EXPAND_MAX_RADIUS_METERS: z.coerce.number().positive().default(15_000),

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

  /** Fréquence de diffusion de driver.position pendant un suivi actif (L3-09) -- délibérément
   * plus faible que la fréquence d'ingestion (position.update, côté app chauffeur, de l'ordre de
   * quelques secondes) : diffuser à la même cadence que l'ingestion saturerait un forfait de
   * données compté (CLAUDE.md, "terminaux d'entrée de gamme") pour un gain de précision que
   * l'œil ne distingue pas entre deux points si proches dans le temps. */
  TRACKING_BROADCAST_INTERVAL_SECONDS: z.coerce.number().positive().default(10),

  /** Vitesse moyenne retenue pour l'ETA d'approche (L3-09) -- PROVISOIRE au sens de D21 : aucun
   * service de routage n'est accessible depuis le service temps réel (D3, aucune dépendance
   * externe hors Redis/Odoo), l'ETA est donc une distance à vol d'oiseau convertie par une
   * vitesse plausible de moto en circulation urbaine à Douala, pas un temps de trajet routier
   * (même honnêteté que L3-03 pour la distance affichée à la découverte : "présentée comme une
   * proximité, pas comme un temps d'arrivée précis"). É8 : ni Google ni Mapbox ne calculent
   * d'itinéraire deux-roues au Cameroun -- même contrainte que L10-03, non calibrée non plus ici.
   */
  TRACKING_AVERAGE_SPEED_MPS: z.coerce.number().positive().default(8.3),

  /** Durée pendant laquelle un profil chauffeur en cache (L3-16, redis/driver-profiles.ts) est
   * servi sans rafraîchissement -- "durée de vie courte" (spécification). PROVISOIRE au sens de
   * D21, même écart que les valeurs de L3-02/L3-03/L3-04 : ce paramètre devrait vivre en base
   * (L3-15, canal de configuration Odoo -> temps réel), qui n'existe pas encore. Passé ce délai,
   * une entrée est rafraîchie à la prochaine lecture ; un profil jamais lu n'a pas d'entrée du
   * tout (D30 : c'est nearby/projection.ts qui traduit son absence en champs à `null`, jamais ce
   * paramètre). */
  DRIVER_PROFILE_CACHE_TTL_SECONDS: z.coerce.number().positive().default(30),

  /** Partage de trajet (L8-03), critère d'acceptation 6 : "un jeton partagé publiquement ne doit
   * pas devenir un point de charge". Fenêtre glissante en mémoire, par jeton -- même patron que
   * NEARBY_RATE_LIMIT_* (nearby/handler.ts), pas un second mécanisme à inventer. */
  SHARE_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(30),
  SHARE_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().positive().default(60),
  /** Cadence d'actualisation de la page publique -- même ordre de grandeur que
   * TRACKING_BROADCAST_INTERVAL_SECONDS (L3-09), pas plus fréquent : un visiteur public sur un
   * forfait de données compté n'a pas besoin d'une fraîcheur supérieure à celle du client lui-même. */
  SHARE_POLL_INTERVAL_SECONDS: z.coerce.number().positive().default(10),

  /** Accumulation distance / durée / tracé d'une course (L3-10). PROVISOIRE au sens de D21, même
   * écart que les valeurs de L3-02/L3-03/L3-04 (amoa/questions/L3-02.md) : devraient vivre en base
   * (L3-15), qui n'existe pas encore. Valeurs plausibles, pas arbitraires. */
  /** En dessous, un déplacement depuis le dernier point retenu est du bruit GPS à l'arrêt : ni
   * accumulé, ni avancé (critère 1 -- une moto à l'arrêt n'accumule pas de distance). */
  ACCUMULATION_MIN_SEGMENT_METERS: z.coerce.number().positive().default(5),
  /** Tolérance de colinéarité de la simplification du tracé au fil de l'eau (critère 3 --
   * « conserve la forme ») : un sommet dont la distance perpendiculaire est en dessous est un
   * point de ligne droite redondant, remplacé plutôt qu'empilé. */
  ACCUMULATION_SIMPLIFY_TOLERANCE_METERS: z.coerce.number().positive().default(8),
  /** Plafond dur du nombre de sommets du tracé -- au-delà, la queue se grossit plutôt que
   * d'empiler des milliers de points (L3-10 : « éviter de stocker des milliers de points »). */
  ACCUMULATION_MAX_TRACK_POINTS: z.coerce.number().int().positive().default(500),
  /** Filet de sécurité : une accumulation sans nouvelle position depuis ce délai expire -- une
   * course orpheline (notification de fin perdue, service tué avant `clear_engagement`) ne fuit
   * pas indéfiniment. Volontairement plus long que n'importe quelle course plausible. */
  ACCUMULATION_TTL_SECONDS: z.coerce.number().int().positive().default(21_600),

  /** Cadence du battement de cœur WebSocket (L3-20, ws/liveness.ts) -- détecte une connexion à
   * moitié fermée (le cas courant sur un réseau mobile), symétrique de la surveillance par
   * abonnement côté application. Une connexion qui n'a pas répondu à un ping avant le battement
   * suivant est terminée. Valeur volontairement plus large que les cadences de diffusion
   * (NEARBY_BROADCAST_INTERVAL_SECONDS, TRACKING_BROADCAST_INTERVAL_SECONDS) : ce n'est pas un
   * flux applicatif à surveiller finement, seulement un filet contre un registre qui grossirait
   * indéfiniment vers des connexions mortes. */
  WS_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().positive().default(30),
}).refine((config) => config.RESERVATION_TTL_SECONDS > config.PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS, {
  // Sans cette marge, le filet de sécurité Redis (RESERVATION_TTL_SECONDS) pourrait expirer une
  // réservation AVANT le minuteur JS qui doit normalement trancher en premier (proposal/timeout.ts)
  // -- une proposition expirerait alors sans que personne n'émette ride.rejected/proposal.expired,
  // silencieusement (L3-07).
  message:
    'RESERVATION_TTL_SECONDS doit être strictement supérieur à PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS (marge de sécurité, L3-07)',
  path: ['RESERVATION_TTL_SECONDS'],
}).refine((config) => config.NEARBY_EXPAND_MAX_RADIUS_METERS > config.NEARBY_MAX_RADIUS_METERS, {
  // Sans cette marge, l'élargissement (L3-08) partirait déjà à son propre plafond et ne
  // produirait jamais un second palier -- un client dont les 5 chauffeurs refusent reviendrait
  // toujours sur NO_DRIVER_AVAILABLE sans qu'aucun rayon plus large n'ait été essayé.
  message:
    'NEARBY_EXPAND_MAX_RADIUS_METERS doit être strictement supérieur à NEARBY_MAX_RADIUS_METERS (L3-08, sinon l’élargissement n’élargit rien)',
  path: ['NEARBY_EXPAND_MAX_RADIUS_METERS'],
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
