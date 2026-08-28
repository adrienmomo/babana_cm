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

/**
 * Clé Google Maps pour les appels REST du paquet @babana/maps (Places, Geocoding, L6-01) --
 * même rôle que côté Client, voir apps/client/config.ts. Injectée par `src/bootstrap.ts`
 * (L6-00, critère d'acceptation 7).
 */
export const GOOGLE_MAPS_API_KEY = process.env.BABANA_GOOGLE_MAPS_API_KEY || '';

/**
 * Capture GPS (L6-05) -- tout paramétrable (invariant 5), rien codé en dur dans `location/*.ts`.
 * Un mauvais réglage au pilote se corrige en changeant une valeur ici et en reconstruisant
 * l'APK, jamais en réécrivant la logique de capture elle-même -- voir `location/adaptive.ts`
 * pour ce que chaque valeur contrôle, et `docs/measurements/` (L6-17, à venir) pour ce que le
 * pilote en aura mesuré.
 *
 * **Valeurs par défaut plausibles, jamais calibrées sur un vrai terminal** (aucun banc mobile
 * dans cet environnement, voir amoa/questions/L6-05.md) -- exactement la même réserve que L2-05
 * (itinéraire de référence) ou L3-10 (simplification de tracé) : à ajuster une fois les mesures
 * de L6-17 disponibles, pas avant.
 */

/** Hors ligne : aucune capture (voir location/adaptive.ts -- pas une valeur ici, un état à part). */

/** En ligne, immobile -- très faible fréquence : la position n'a presque aucune chance d'avoir
 * changé depuis le dernier relevé, la capturer plus souvent ne ferait que vider la batterie. */
export const LOCATION_CAPTURE_INTERVAL_IDLE_MS = Number(process.env.BABANA_LOCATION_INTERVAL_IDLE_MS) || 90_000;
/** En ligne, en mouvement -- fréquence modérée : assez pour que la position affichée aux clients
 * (nearby.drivers) reste crédible, sans saturer un forfait de données compté. */
export const LOCATION_CAPTURE_INTERVAL_MOVING_MS = Number(process.env.BABANA_LOCATION_INTERVAL_MOVING_MS) || 15_000;
/** En course -- fréquence élevée : c'est la donnée que L3-10 accumule en distance/tracé, et ce
 * que le client suit en direct (driver.position). */
export const LOCATION_CAPTURE_INTERVAL_RIDE_MS = Number(process.env.BABANA_LOCATION_INTERVAL_RIDE_MS) || 5_000;

/** En dessous de cette vitesse instantanée (m/s), un chauffeur en ligne (hors course) est
 * considéré immobile -- ~1 m/s, la marche, pas la moto à l'arrêt moteur tournant. */
export const LOCATION_IDLE_SPEED_THRESHOLD_MPS = Number(process.env.BABANA_LOCATION_IDLE_SPEED_THRESHOLD_MPS) || 1.0;
/** Déplacement cumulé, sur la fenêtre ci-dessous, en dessous duquel un chauffeur en ligne est
 * considéré immobile même sans vitesse instantanée fiable (GPS bruité à l'arrêt). L'immobilité se
 * détecte sur la vitesse ET le déplacement cumulé (spécification L6-05), jamais un compteur seul. */
export const LOCATION_IDLE_DISPLACEMENT_THRESHOLD_METERS = Number(process.env.BABANA_LOCATION_IDLE_DISPLACEMENT_THRESHOLD_METERS) || 40;
/** Fenêtre glissante sur laquelle le déplacement cumulé ci-dessus est évalué. */
export const LOCATION_IDLE_DETECTION_WINDOW_MS = Number(process.env.BABANA_LOCATION_IDLE_DETECTION_WINDOW_MS) || 120_000;

/** Agrégation avant envoi (spécification L6-05, critère 3) : le tampon est vidé dès qu'il atteint
 * cette taille... */
export const LOCATION_BATCH_SIZE = Number(process.env.BABANA_LOCATION_BATCH_SIZE) || 5;
/** ...ou après ce délai depuis le premier point en attente, même si le tampon n'est pas plein --
 * pour qu'un point capté juste avant un changement d'état (ex. passage en course) ne reste pas
 * en attente indéfiniment derrière une cadence redevenue lente. */
export const LOCATION_BATCH_MAX_WAIT_MS = Number(process.env.BABANA_LOCATION_BATCH_MAX_WAIT_MS) || 45_000;

/**
 * Repli (spécification L6-05, "le mode le plus économe") : quand vrai, un chauffeur en ligne mais
 * pas en course ne capture plus qu'au rythme ci-dessous (au lieu de la distinction immobile/en
 * mouvement) -- on perd la fraîcheur du géo-index hors course, on garde la flotte. Atteignable par
 * un changement de valeur (ce booléen), jamais par un développement -- c'est tout le sens de ce
 * réglage (amoa/questions/REPONSES-2026-09-02.md §4).
 */
export const LOCATION_DEGRADED_MODE = process.env.BABANA_LOCATION_DEGRADED_MODE === 'true';
/** Cadence unique appliquée en mode dégradé, hors course. Très espacée par construction. */
export const LOCATION_DEGRADED_ONLINE_INTERVAL_MS = Number(process.env.BABANA_LOCATION_DEGRADED_ONLINE_INTERVAL_MS) || 300_000;
