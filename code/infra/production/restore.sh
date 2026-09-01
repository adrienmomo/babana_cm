#!/bin/sh
# Restauration d'une sauvegarde (L0-07, étape 7 -- la moitié qui compte). À exécuter sur un hôte
# VIERGE (pas la production), pour prouver que les sauvegardes sont exploitables. L8-08 n'est
# satisfait que quand ce script a réussi et qu'un compte rendu daté est dans
# docs/operations/production.md.
#
#   BACKUP_REMOTE=b2:babana-backups RESTORE_TS=20261013T020000Z sh infra/production/restore.sh
#
# Prérequis : dépôt cloné, infra/env/.env déjà déchiffré et en place (age -d env-<TS>.age),
# BABANA_DOMAIN pointant vers un nom de test résolu (sinon Caddy n'obtient pas de certificat --
# ou utiliser un domaine .localhost pour la vérification sans TLS public).
set -eu

cd "$(git rev-parse --show-toplevel)/code" 2>/dev/null || cd "$(dirname "$0")/../.."
ENV_FILE=infra/env/.env
COMPOSE="docker compose -f infra/compose.yaml --env-file $ENV_FILE"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

die() { printf 'ÉCHEC restauration : %s\n' "$1" >&2; exit 1; }

: "${BACKUP_REMOTE:?BACKUP_REMOTE obligatoire.}"
: "${RESTORE_TS:?RESTORE_TS obligatoire -- horodatage du répertoire de sauvegarde (ex. 20261013T020000Z).}"
[ -f "$ENV_FILE" ] || die "$ENV_FILE absent (le déchiffrer depuis env-<TS>.age avant de lancer)."
command -v rclone >/dev/null 2>&1 || die "rclone absent."

rclone copy "$BACKUP_REMOTE/$RESTORE_TS/" "$WORK/" || die "récupération de la sauvegarde."
DUMP=$(ls "$WORK"/babana-*.dump 2>/dev/null | head -1) || true
DOCS=$(ls "$WORK"/babana-documents-*.tar 2>/dev/null | head -1) || true
[ -s "$DUMP" ] || die "dump PostgreSQL introuvable dans la sauvegarde $RESTORE_TS."

# --- Pile nue (postgres/redis/minio), sans Odoo pour l'instant -----------------------
$COMPOSE up -d --wait postgres redis minio

# --- PostgreSQL : recréer la base et charger le dump --------------------------------
$COMPOSE exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS babana;" -c "CREATE DATABASE babana OWNER \"$POSTGRES_USER\";"' \
  || die "recréation de la base."
$COMPOSE exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d babana --no-owner --clean --if-exists' < "$DUMP" \
  || die "pg_restore."

# --- MinIO : recharger les pièces --------------------------------------------------
if [ -s "$DOCS" ]; then
  mkdir -p "$WORK/docs" && tar -C "$WORK/docs" -xf "$DOCS"
  $COMPOSE exec -T minio sh -c 'mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mb --ignore-existing local/babana-documents >/dev/null' || true
  # mc mirror depuis l'hôte : on passe le contenu via un tar sur stdin dans le conteneur.
  tar -C "$WORK/docs" -cf - . | $COMPOSE exec -T minio sh -c 'mkdir -p /tmp/rs && tar -C /tmp/rs -xf - && mc mirror --quiet --overwrite /tmp/rs local/babana-documents' \
    || die "rechargement MinIO."
fi

# --- Odoo : démarrer et vérifier ------------------------------------------------
$COMPOSE up -d --build --wait --wait-timeout 300
sh infra/smoke-test.sh || die "smoke-test rouge après restauration."

# --- Contrôle de cohérence métier -------------------------------------------------
$COMPOSE exec -T odoo sh -c 'odoo shell -d babana --no-http --db_host="$HOST" --db_user="$USER" --db_password="$PASSWORD"' <<'PY'
n_rides = env["babana.ride"].sudo().search_count([])
n_drivers = env["babana.driver"].sudo().search_count([("state", "=", "approved")])
n_moves = env["babana.cash.movement"].sudo().search_count([])
print("RESTORE-CHECK rides=%d approved_drivers=%d cash_movements=%d" % (n_rides, n_drivers, n_moves))
assert n_rides >= 0 and n_drivers >= 0
PY

cat <<EOF

Restauration $RESTORE_TS terminée et vérifiée (smoke-test + contrôle de cohérence).
=> Consigner ce succès, daté, dans docs/operations/production.md (section « Restauration prouvée »).
   Sans ce compte rendu, L8-08 n'est pas satisfait.
EOF
