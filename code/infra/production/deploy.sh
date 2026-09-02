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
#   - GOOGLE_ROUTING_URL et BABANA_MAPS_SEARCH_URL = vraies API (le défaut compose pointe
#     mock-maps, qui n'existe pas en prod) ;
#   - PUSH_PROVIDER=fcm + les trois FCM_* si les notifications doivent partir ;
#   - DNS des trois hôtes résolu (sinon Caddy n'obtiendra pas de certificat).
set -eu

cd "$(git rev-parse --show-toplevel)/code" 2>/dev/null || cd "$(dirname "$0")/../.."
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

# shellcheck disable=SC1090
. "$ENV_FILE" 2>/dev/null || true
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
# Même motif D43, appliqué à un secret (constat du 11 septembre --
# amoa/questions/REPONSES-2026-09-11.md §1) : ADMIN_PASSWORD vide ou recopié du fichier
# d'exemple laisserait le back-office en `admin`/`admin`, ou en un mot de passe de
# développement connu de quiconque a lu ce dépôt.
case "${ADMIN_PASSWORD:-}" in
  ""|dev-only-not-a-real-secret) die "ADMIN_PASSWORD vide ou égal à la valeur de développement dans $ENV_FILE -- poser un mot de passe de production généré (gestionnaire de secrets)." ;;
esac
case "${BABANA_MAPS_SEARCH_URL:-}" in
  *localhost:4001*|*mock-maps*) warn "BABANA_MAPS_SEARCH_URL pointe vers mock-maps -- le build web du Client ci-dessous embarquera cette adresse ; poser l'adresse Google réelle avant de servir aux vrais clients." ;;
esac
[ "${NODE_ENV:-}" = "production" ] || warn "NODE_ENV != production dans $ENV_FILE."

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
if command -v npm >/dev/null 2>&1; then
  npm ci --prefix . --silent
  npm run build:web -w @babana/client
else
  warn "npm absent -- bundle web NON reconstruit. Caddy servira l'ancien contenu de apps/client/dist-web (ou 404)."
fi

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
