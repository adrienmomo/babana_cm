#!/bin/sh
# Déploiement de la pile babana en production (L0-07, étape 5 de amoa/04-monorepo-et-services.md
# §9). À exécuter sur l'hôte durci (voir bootstrap.sh), depuis la racine du dépôt cloné.
#
#   sh infra/production/deploy.sh              # déploie HEAD de la branche courante
#   REF=v2026.10.13 sh infra/production/deploy.sh
#
# Ce qui distingue ce script de `make up` :
#   - il n'utilise QUE infra/compose.yaml (jamais compose.dev.yaml : celui-ci expose les ports
#     internes à l'hôte, monte les sources, et démarre mailpit + les mocks -- tout ce qu'on ne
#     veut pas en production). `make up` reste un confort de développement ;
#   - il construit le bundle web du Client avant de (re)démarrer Caddy ;
#   - il enregistre le commit déployé pour rollback.sh.
#
# Prérequis vérifiés ci-dessous et qui exigent une vraie machine / de vrais secrets :
#   - infra/env/.env présent, avec BABANA_DOMAIN=babana.cm et les secrets de production
#     (JWT_SECRET, REALTIME_SHARED_SECRET, POSTGRES_PASSWORD, MinIO, SMTP réel...) ;
#   - GOOGLE_JWKS_URL = https://www.googleapis.com/oauth2/v3/certs (pas de mock en prod) ;
#   - GOOGLE_ROUTING_URL, BABANA_MAPS_SEARCH_URL, BABANA_GOOGLE_WEB_CLIENT_ID et
#     BABANA_GOOGLE_MAPS_API_KEY = vraies valeurs (le défaut compose/développement pointe
#     mock-maps ou l'identifiant de développement, qui n'existent pas en prod) ;
#   - S3_PUBLIC_ENDPOINT = https://storage.babana.cm (D64) -- jamais minio:9000 (injoignable
#     hors du réseau Docker) ni localhost:9000 (valeur de développement) ;
#   - PUSH_PROVIDER=fcm + les trois FCM_* si les notifications doivent partir ;
#   - DNS des trois hôtes résolu (sinon Caddy n'obtiendra pas de certificat).
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$(git rev-parse --show-toplevel)/code" 2>/dev/null || cd "$SCRIPT_DIR/../.."
ENV_FILE=infra/env/.env
COMPOSE="docker compose -f infra/compose.yaml --env-file $ENV_FILE"
STATE_DIR=infra/production/.state
REF="${REF:-HEAD}"

log()  { printf '\n=== %s ===\n' "$1"; }
die()  { printf 'ÉCHEC : %s\n' "$1" >&2; exit 1; }
warn() { printf 'ATTENTION : %s\n' "$1" >&2; }

# --- Contrôles préalables ----------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker absent."
docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) absent."
[ -f "$ENV_FILE" ] || die "$ENV_FILE absent -- le renseigner à partir de infra/env/.env.example (L0-06), avec les secrets de PRODUCTION."

# `set -a` : défaut du 13 septembre (L0-10, D59) -- `. "$ENV_FILE"` seul pose des variables de
# SHELL, jamais transmises à un processus fils (npm run build:web ci-dessous) sans export
# explicite. Bornage `set +a` juste après : le reste du script continue de raisonner sur des
# variables de shell ordinaires, pas tout exporter par accident au-delà de ce point.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE" 2>/dev/null || true
set +a
[ "${BABANA_DOMAIN:-}" != "localhost" ] || die "BABANA_DOMAIN=localhost dans $ENV_FILE -- ce n'est pas une configuration de production."

# Adresses de fournisseur externe : sans valeur par défaut (D43 retournée,
# amoa/questions/REPONSES-2026-09-06.md §2). infra/compose.yaml les passe sans garde `:?` pour
# ne pas gêner `make up` -- c'est donc ICI que la production est protégée : vide ou pointant vers
# un simulateur, on refuse de déployer. Le mock SMTP est le plus dangereux : il accepte une
# facture et ne signale rien.
case "${GOOGLE_JWKS_URL:-}" in
  ""|*mock-google-identity*) die "GOOGLE_JWKS_URL vide ou vers un mock dans $ENV_FILE -- poser https://www.googleapis.com/oauth2/v3/certs." ;;
esac
case "${GOOGLE_ROUTING_URL:-}" in
  ""|*mock-maps*) die "GOOGLE_ROUTING_URL vide ou vers mock-maps dans $ENV_FILE -- poser la vraie API de routage." ;;
esac
case "${SMTP_HOST:-}" in
  ""|mailpit) die "SMTP_HOST vide ou =mailpit dans $ENV_FILE -- poser le relais SMTP réel (mailpit accepte les factures et ne signale rien)." ;;
esac
[ -n "${SMTP_PORT:-}" ] || die "SMTP_PORT vide dans $ENV_FILE -- le poser (587 ou 465 selon le relais retenu)."
# D64 (amoa/01-architecture.md §9 octies) : l'URL signée renvoyée à un navigateur portait
# jusqu'ici le nom de service Docker interne, injoignable en production. Même discipline D43 --
# vide ou pointant vers l'interne/le développement, on refuse de déployer plutôt que de servir un
# bouton « Voir la pièce » qui ne charge rien.
case "${S3_PUBLIC_ENDPOINT:-}" in
  ""|*minio*|*localhost*) die "S3_PUBLIC_ENDPOINT vide ou vers une adresse interne/de développement dans $ENV_FILE -- poser https://storage.$BABANA_DOMAIN (Caddy, D64)." ;;
esac
# Même motif D43, appliqué à un secret (constat du 11 septembre --
# amoa/questions/REPONSES-2026-09-11.md §1) : ADMIN_PASSWORD vide ou recopié du fichier
# d'exemple laisserait le back-office en `admin`/`admin`, ou en un mot de passe de
# développement connu de quiconque a lu ce dépôt.
case "${ADMIN_PASSWORD:-}" in
  ""|dev-only-not-a-real-secret) die "ADMIN_PASSWORD vide ou égal à la valeur de développement dans $ENV_FILE -- poser un mot de passe de production généré (gestionnaire de secrets)." ;;
esac
# Variables lues à la COMPILATION du bundle web du Client (apps/client/config.ts,
# apps/client/config.web.ts) -- absentes ou vides, elles s'inlinent en `undefined`/`''` dans le
# fichier produit, jamais rattrapables après coup (D59, L0-10 : constat du 13 septembre,
# apps/client/dist-web/bundle.js contenait littéralement `MAPS_SEARCH_URL = false||undefined`).
# Même discipline D43 que les adresses ci-dessus : on échoue, on n'avertit plus -- un déploiement
# à moitié configuré ne doit jamais servir une page où l'on ne peut ni se connecter ni chercher
# un lieu.
case "${BABANA_MAPS_SEARCH_URL:-}" in
  ""|*localhost:4001*|*mock-maps*) die "BABANA_MAPS_SEARCH_URL vide ou vers mock-maps dans $ENV_FILE -- poser l'adresse Google réelle (searchPlace) avant de construire le bundle web de production." ;;
esac
case "${BABANA_GOOGLE_WEB_CLIENT_ID:-}" in
  ""|dev-client-id.apps.googleusercontent.com) die "BABANA_GOOGLE_WEB_CLIENT_ID vide ou égal à la valeur de développement dans $ENV_FILE -- poser l'identifiant client OAuth Web réel (Google Cloud Console), déjà listé dans GOOGLE_OAUTH_CLIENT_IDS." ;;
esac
case "${BABANA_GOOGLE_MAPS_API_KEY:-}" in
  "") die "BABANA_GOOGLE_MAPS_API_KEY vide dans $ENV_FILE -- poser la clé Google Maps réelle (appels REST Places/Geocoding) avant de construire le bundle web de production." ;;
esac
# Même discipline D43 que les variables ci-dessus (D65, amoa/questions/L0-10.md) : un bundle web
# construit avec NODE_ENV != production reste en mode développement (apps/client/webpack.config.js)
# -- silencieusement, comme BABANA_DOMAIN silencieusement en dur avant D61 étendue. On échoue, on
# n'avertit plus.
[ "${NODE_ENV:-}" = "production" ] || die "NODE_ENV != production dans $ENV_FILE -- le bundle web serait construit en mode développement."

mkdir -p "$STATE_DIR"
PREV_COMMIT=$(cat "$STATE_DIR/deployed_commit" 2>/dev/null || echo "")
[ -n "$PREV_COMMIT" ] && echo "$PREV_COMMIT" > "$STATE_DIR/previous_commit"

# --- Récupérer la référence à déployer -------------------------------------------------
log "checkout $REF"
git fetch --tags --quiet || warn "git fetch a échoué (hors ligne ?) -- on déploie l'état local."
git checkout --quiet "$REF"
TARGET_COMMIT=$(git rev-parse HEAD)
echo "commit cible : $TARGET_COMMIT"

# --- Bundle web du Client (servi par Caddy, même origine -- D46) ----------------------
log "construction du bundle web du Client"
command -v npm >/dev/null 2>&1 || die "npm absent -- impossible de construire le bundle web. Un déploiement qui servirait l'ancien contenu de apps/client/dist-web (ou 404) est le même défaut de configuration à moitié faite que L0-10 ferme ailleurs -- on échoue plutôt que de servir une page inutilisable."
npm ci --prefix . --silent
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib/build-web-bundle.sh"
build_web_bundle "$(pwd)"

# --- Démarrer / mettre à jour la pile -------------------------------------------------
log "docker compose up (infra/compose.yaml uniquement)"
$COMPOSE pull --quiet 2>/dev/null || true
$COMPOSE up -d --build --wait --wait-timeout 300

# --- Installer / mettre à jour le module Odoo ---------------------------------------
log "module Odoo : -u babana"
$COMPOSE exec -T odoo sh -c 'odoo -d babana --stop-after-init --no-http -u babana --db_host="$HOST" --db_user="$USER" --db_password="$PASSWORD"'

# --- Vérifications (étape 6) --------------------------------------------------------
log "vérifications d'infrastructure"
if sh infra/smoke-test.sh; then
  echo "$TARGET_COMMIT" > "$STATE_DIR/deployed_commit"
  date -u +%FT%TZ > "$STATE_DIR/deployed_at"
  log "déploiement OK -- commit $TARGET_COMMIT"
  cat <<EOF
Restent, hors de ce script (procédure §9) :
  7. Sauvegardes vers un stockage EXTERNE + restauration prouvée sur hôte vierge
     -> infra/production/backup.sh, puis restore.sh sur une autre machine. L8-08
        n'est PAS satisfait tant que cette restauration n'a pas réussi.
  8. Supervision hébergée AILLEURS -> infra/production/monitoring/ (probe.sh + probe-host.sh),
     à faire tourner depuis une autre machine, avec alerte -- vérifier en provoquant une panne.
  9. Latence de référence depuis Douala -> docs/operations/latency-baseline.md (à remplir).
 10. Retour arrière -> infra/production/rollback.sh ; détenteurs d'accès dans production.md.
EOF
else
  warn "smoke-test en échec APRÈS déploiement. La pile tourne peut-être en état dégradé."
  warn "Retour arrière : sh infra/production/rollback.sh"
  exit 1
fi
