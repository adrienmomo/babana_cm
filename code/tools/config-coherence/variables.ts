// L0-10 -- cohérence de la chaîne de configuration (D59, amoa/01-architecture.md §9 sexies).
//
// Deux listes explicites, jamais des défauts silencieux (le point même de cette tâche) :
//
//   - INTERNAL_TOPOLOGY_NAMES : des noms qui ressemblent à des variables de configuration mais
//     n'en sont pas -- topologie du réseau Docker interne, fixée en dur dans infra/compose.yaml,
//     jamais dans infra/env/.env.example (même raisonnement déjà écrit dans
//     infra/env/README.md, "Ce qui n'apparaît volontairement pas dans cette table", étendu ici à
//     ce que L4-06/L1-05 ont ajouté depuis : S3_*, REALTIME_INTERNAL_URL). Aucune de ces valeurs
//     ne varie entre environnements (D18, une seule pile compose) ; certaines sont des
//     renommages volontaires d'une variable déjà déclarée (S3_ACCESS_KEY = ${MINIO_ROOT_USER},
//     convention S3 côté Odoo) -- pas une seconde variable à suivre.
//
//   - SELF_SUFFICIENT_DEFAULTS : des variables réellement lues par le code, mais dont le repli
//     est une valeur de production RÉELLE (adresse, seuil, plafond), jamais `undefined` ni `''`.
//     Leur absence ne casse rien -- ce n'est pas le défaut du 13 septembre (une adresse de
//     fournisseur qui se tait), donc pas besoin du protocole des trois moments. Liste explicite
//     et commentée : retirer une entrée d'ici sans lui donner un repli sûr la fait réapparaître
//     aussitôt comme "consommée mais non déclarée" (le test la retrouve).
export const INTERNAL_TOPOLOGY_NAMES: ReadonlySet<string> = new Set([
  'REDIS_URL',
  'ODOO_INTERNAL_URL',
  'REALTIME_INTERNAL_URL',
  'S3_ENDPOINT',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'S3_BUCKET',
  // Alias posés par infra/compose.yaml pour l'entrypoint de l'image odoo (HOST/USER/PASSWORD ->
  // --db_host/--db_user/--db_password) -- des noms de variable *dans le conteneur*, jamais des
  // noms de infra/env/.env.example (qui porte POSTGRES_USER/POSTGRES_PASSWORD, déjà suivis).
  'HOST',
  'USER',
  'PASSWORD',
  // Port d'écoute HTTP interne des services Node (realtime, mocks) -- fixé par service dans
  // infra/compose.yaml, jamais une adresse ou un secret qui changerait entre environnements.
  'PORT',
]);

export const SELF_SUFFICIENT_DEFAULTS: ReadonlySet<string> = new Set([
  // Adresse de production réelle (D18, api.babana.cm) déjà câblée en repli -- une surcharge de
  // développement se pose en ligne de commande au lancement du bundler (voir apps/*/config.ts),
  // jamais via infra/env/.env.
  'BABANA_API_URL',
  'BABANA_REALTIME_WS_URL',
  // Capture GPS (L6-05) et téléversement de document (L6-15) : réglages métier PROVISOIRES au
  // sens de D21 (amoa/questions/L6-05.md) -- même écart assumé que les seuils de
  // services/realtime/src/config.ts. Tous ont un repli numérique ou booléen réel.
  'BABANA_LOCATION_INTERVAL_IDLE_MS',
  'BABANA_LOCATION_INTERVAL_MOVING_MS',
  'BABANA_LOCATION_INTERVAL_RIDE_MS',
  'BABANA_LOCATION_IDLE_SPEED_THRESHOLD_MPS',
  'BABANA_LOCATION_IDLE_DISPLACEMENT_THRESHOLD_METERS',
  'BABANA_LOCATION_IDLE_DETECTION_WINDOW_MS',
  'BABANA_LOCATION_BATCH_SIZE',
  'BABANA_LOCATION_BATCH_MAX_WAIT_MS',
  'BABANA_LOCATION_DEGRADED_MODE',
  'BABANA_LOCATION_DEGRADED_ONLINE_INTERVAL_MS',
  'BABANA_LOCATION_NOTIFICATION_REFRESH_MS',
  'BABANA_ONBOARDING_MAX_DOCUMENT_BYTES',
]);

// Consommées par l'IMAGE tierce elle-même (postgres:16 -- POSTGRES_PASSWORD configure le mot de
// passe du superutilisateur au premier démarrage, comportement documenté de l'image officielle),
// jamais par du code de ce dépôt : aucun fichier suivi n'a de raison de contenir ce mot de passe
// en clair. POSTGRES_USER, lui, apparaît bien dans infra/production/backup.sh et restore.sh
// (`-U "$POSTGRES_USER"`) -- pas dans cette liste. Repérée en vérifiant pourquoi ce test
// signalait POSTGRES_PASSWORD comme "consommée nulle part" alors qu'infra/compose.yaml la livre
// bel et bien au conteneur postgres.
export const THIRD_PARTY_IMAGE_CONSUMED: ReadonlySet<string> = new Set(['POSTGRES_PASSWORD']);

export interface ConfigException {
  name: string;
  reason: string;
  /** Non vide, toujours -- critère d'acceptation 4 de L0-10 : "une exception sans tâche fait
   * échouer la suite". Un identifiant de tâche (`L1-09`) ou, à défaut d'une tâche numérotée, une
   * référence datée et vérifiable (voir BABANA_GOOGLE_IOS_CLIENT_ID ci-dessous). */
  closingTask: string;
}

// Vérifiées dans le dépôt le 13 septembre 2026 (L0-10), pas recopiées de la spécification :
// FCM_PROJECT_ID/FCM_CLIENT_EMAIL/FCM_PRIVATE_KEY, un temps pressentis comme une exception
// possible ("FCM_* sans fournisseur"), sont en réalité déjà déclarées, livrées
// (infra/compose.yaml) ET consommées (services/push.py, FcmPushProvider) -- les trois moments
// tiennent, il n'y a pas de maillon manquant à couvrir ici. Seule la vérification CONTRE un
// vrai compte Firebase reste à faire, au pilote -- ce n'est pas ce que ce test mesure. Voir
// amoa/questions/L0-10.md.
export const EXCEPTIONS: readonly ConfigException[] = [
  {
    name: 'SMS_GATEWAY_API_KEY',
    reason:
      "Passerelle SMS non choisie (amoa/questions/L0-06.md) ; L1-09 journalise l'OTP au lieu de " +
      "l'envoyer (D19). Rien ne la livre ni ne la consomme tant que L1-09 n'existe pas.",
    closingTask: 'L1-09',
  },
  {
    name: 'SMS_GATEWAY_SENDER_ID',
    reason: 'Même passerelle que SMS_GATEWAY_API_KEY ci-dessus.',
    closingTask: 'L1-09',
  },
  {
    name: 'GOOGLE_MAPS_API_KEY',
    reason:
      'Clé du SDK natif de carte (rendu <MapView>, AndroidManifest.xml / Info.plist) -- ' +
      'distincte de BABANA_GOOGLE_MAPS_API_KEY (appels REST Places/Geocoding, déjà suivie). ' +
      "Prérequis suivi hors code (amoa/05-prerequis-et-simulation.md §5 : \"doit être faite " +
      'avant L6-06").',
    closingTask: 'L6-06',
  },
  {
    name: 'BABANA_GOOGLE_IOS_CLIENT_ID',
    reason:
      'Consommée (apps/client/config.ts, apps/client/config.web.ts, apps/driver/config.ts) mais ' +
      "jamais livrée : aucun build iOS n'existe encore -- Android est prioritaire (CDC §III.1), " +
      'iOS après le pilote (amoa/03-decoupage-taches.md §6, pas de tâche numérotée à ce jour).',
    closingTask: 'iOS après le pilote (amoa/03-decoupage-taches.md §6)',
  },
];
