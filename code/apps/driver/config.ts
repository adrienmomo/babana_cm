/**
 * Configuration lue depuis l'environnement de build, jamais codée en dur dans un écran
 * (invariant 5 ; critère d'acceptation 7 de L0-03). `babel-plugin-transform-inline-environment-
 * variables` (babel.config.js) substitue `process.env.X` par sa valeur au moment du bundle --
 * ces valeurs sont donc figées à la construction, pas lues sur l'appareil au démarrage.
 *
 * Développement : `make driver` pose déjà `BABANA_API_URL=https://api.localhost` /
 * `BABANA_REALTIME_WS_URL=wss://api.localhost/rt/ws` (Makefile -- même variable BABANA_DOMAIN
 * que le reste de la pile, voir infra/env/.env.example, L0-06). Un lancement direct de `npm run
 * start -w @babana/driver`, hors du Makefile, doit les poser lui-même.
 *
 * Aucun repli vers le domaine de production depuis D61 (amoa/questions/REPONSES-2026-09-14.md
 * §3) -- ce fichier portait jusqu'au 14 septembre `|| 'https://api.babana.cm'` : un binaire
 * construit sans ces variables parlait alors quand même à la vraie production, sans qu'aucun
 * contrôle ne le signale (même repli plausible que D43 a déjà fermé pour BABANA_MAPS_SEARCH_URL
 * côté Client -- une adresse juste se croit, une adresse absente se voit). Absente, la
 * construction échoue ici, bruyamment, plutôt que de deviner un serveur.
 */
function requireServerAddress(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `babana: ${name} n'est pas configurée -- aucune adresse de serveur ne retombe sur une ` +
        'valeur par défaut (invariant 5, D61). La poser explicitement au build (make driver la ' +
        'pose déjà vers https://api.localhost en développement).'
    );
  }
  return value;
}

export const API_BASE_URL = requireServerAddress(process.env.BABANA_API_URL, 'BABANA_API_URL');
export const REALTIME_WS_URL = requireServerAddress(
  process.env.BABANA_REALTIME_WS_URL,
  'BABANA_REALTIME_WS_URL'
);

/**
 * Clé Google Maps pour les appels REST du paquet @babana/maps (Places, Geocoding, L6-01) --
 * même rôle que côté Client, voir apps/client/config.ts. Injectée par `src/bootstrap.ts`
 * (L6-00, critère d'acceptation 7).
 */
export const GOOGLE_MAPS_API_KEY = process.env.BABANA_GOOGLE_MAPS_API_KEY || '';

/**
 * Adresse des tuiles de la carte OpenStreetMap de l'app Chauffeur (`https://.../{z}/{x}/{y}.png`).
 * Absente, la carte reste celle de Google -- ce n'est pas un repli vers un serveur public choisi
 * à la place de l'exploitant (D43) : `make driver` pose la valeur de développement, un build de
 * production pose le fournisseur de tuiles retenu. La recherche de lieu reste celle de Google
 * (clé ci-dessus).
 */
export const MAP_TILE_URL = process.env.BABANA_MAP_TILE_URL || undefined;

/**
 * Crédit exigé par la licence du fournisseur de tuiles (affiché en bas de la carte), requis dès
 * que `BABANA_MAP_TILE_URL` est posée : `@babana/maps` refuse une adresse de tuiles sans crédit
 * (D43, aucun texte par défaut qui citerait le mauvais fournisseur). `make driver` / `make client`
 * posent celui d'OpenStreetMap avec l'adresse de développement.
 */
export const MAP_TILE_ATTRIBUTION = process.env.BABANA_MAP_TILE_ATTRIBUTION || undefined;

/**
 * Service de routage (format OSRM) qui calcule l'itinéraire du chauffeur vers le client puis vers
 * la destination (`fetchRoute`, @babana/maps). Absent : la carte reste sans tracé -- jamais un
 * serveur public choisi à la place de l'exploitant (D43). `make driver` pose la valeur de
 * développement (serveur de démonstration public, usage léger seulement) ; la production pose le
 * service retenu. É8 : modèle voiture, la durée affichée est indicative.
 */
export const ROUTING_URL = process.env.BABANA_ROUTING_URL || undefined;

/**
 * Rayon (mètres) sous lequel le bouton « Sur place » apparaît. Un confort d'affichage, pas une règle
 * métier : le serveur ne conditionne rien à cette proximité. Assez large pour absorber l'imprécision
 * d'un GPS de terminal d'entrée de gamme (quelques dizaines de mètres), assez étroit pour ne pas
 * proposer « Sur place » au bout de la rue.
 */
export const ARRIVAL_RADIUS_METERS = Number(process.env.BABANA_ARRIVAL_RADIUS_METERS) || 150;

/** Délai avant de redemander un itinéraire qui a échoué (service de routage injoignable). */
export const ROUTE_RETRY_COOLDOWN_MS = Number(process.env.BABANA_ROUTE_RETRY_COOLDOWN_MS) || 15_000;

/** Écart (m) au tracé au-delà duquel l'itinéraire est recalculé depuis la position du chauffeur --
 * au-dessus de l'imprécision d'un GPS d'entrée de gamme, pour ne pas recalculer à chaque relevé. */
export const ROUTE_DEVIATION_METERS = Number(process.env.BABANA_ROUTE_DEVIATION_METERS) || 80;

/** Âge (ms) au-delà duquel l'itinéraire est recalculé même sans écart : distance et durée
 * restantes à jour, chez le chauffeur comme chez le client (qui reçoit le même tracé). */
export const ROUTE_REFRESH_MS = Number(process.env.BABANA_ROUTE_REFRESH_MS) || 120_000;

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

/** En ligne, immobile -- chaque relevé part aussitôt (`tracker.ts`). Doit rester nettement sous
 * la durée de vie d'une position côté service temps réel (`POSITION_TTL_SECONDS`, 60 s) : au-delà,
 * un chauffeur qui attend sans bouger sort du pool entre deux relevés, et la course part ailleurs.
 * 20 s (22 octobre) : trois relevés par durée de vie, une perte réseau passagère n'en fait pas
 * sortir le chauffeur. Valait 90 s -- le chauffeur disparaissait plus d'une minute sur deux. */
export const LOCATION_CAPTURE_INTERVAL_IDLE_MS = Number(process.env.BABANA_LOCATION_INTERVAL_IDLE_MS) || 20_000;
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

/**
 * Cadence de réaffichage de la notification persistante de capture (`location/background.ts`),
 * indépendante de la capture elle-même : c'est elle qui fait vieillir le « il y a N min » quand
 * plus aucune position ne part -- le diagnostic d'une capture calée (précision du 3 septembre,
 * `amoa/questions/REPONSES-2026-09-03.md` §2). Une minute par défaut, la granularité du message.
 */
export const LOCATION_NOTIFICATION_REFRESH_MS = Number(process.env.BABANA_LOCATION_NOTIFICATION_REFRESH_MS) || 60_000;

/**
 * Taille maximale d'une photo de document après compression, avant téléversement (L6-15,
 * critère d'acceptation 2). Bien en dessous du plafond serveur (`babana.document_max_upload_bytes`,
 * 10 Mio) : sur un réseau mobile camerounais, plus la photo est légère, plus l'envoi aboutit.
 * Paramétrable (invariant 5), jamais codé en dur dans l'écran d'inscription.
 */
export const ONBOARDING_MAX_DOCUMENT_BYTES = Number(process.env.BABANA_ONBOARDING_MAX_DOCUMENT_BYTES) || 4 * 1024 * 1024;
