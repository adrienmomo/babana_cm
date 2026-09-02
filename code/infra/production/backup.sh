#!/bin/sh
# Sauvegarde de la pile babana vers un stockage EXTERNE (L0-07, étape 7 ; L8-08). À faire
# tourner en cron sur l'hôte de production. « Externe » n'est pas négociable : un instantané
# chez le même hébergeur disparaît avec l'incident (amoa/04-monorepo-et-services.md §9).
#
#   0 2 * * *  cd /opt/babana/code && sh infra/production/backup.sh >> /var/log/babana-backup.log 2>&1
#
# Contenu d'une sauvegarde :
#   - dump PostgreSQL de la base `babana` (pg_dump -Fc) ;
#   - miroir du bucket MinIO `babana-documents` (pièces chauffeur) ;
#   - copie de infra/env/.env chiffrée (âge/GPG) -- PAS en clair.
#
# Destination : définie par BACKUP_REMOTE (une "remote" rclone vers un stockage objet d'un AUTRE
# fournisseur -- Backblaze B2, Scaleway, OVH...). rclone est le seul ajout d'outil, justifié par
# "de préférence un autre fournisseur" de la spécification.
set -eu

cd "$(git rev-parse --show-toplevel)/code" 2>/dev/null || cd "$(dirname "$0")/../.."
ENV_FILE=infra/env/.env
COMPOSE="docker compose -f infra/compose.yaml --env-file $ENV_FILE"
STATE_DIR=infra/production/.state
TS=$(date -u +%Y%m%dT%H%M%SZ)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

die() { printf 'ÉCHEC sauvegarde : %s\n' "$1" >&2; echo "fail $TS $1" >> "$STATE_DIR/backup_history"; exit 1; }

: "${BACKUP_REMOTE:?BACKUP_REMOTE obligatoire -- ex. b2:babana-backups (remote rclone vers un AUTRE fournisseur que l'hôte).}"
: "${BACKUP_AGE_RECIPIENTS:?BACKUP_AGE_RECIPIENTS obligatoire -- clés publiques age pour chiffrer le .env (séparées par des virgules).}"
command -v rclone >/dev/null 2>&1 || die "rclone absent."
command -v age    >/dev/null 2>&1 || die "age absent (chiffrement du .env)."
mkdir -p "$STATE_DIR"

# --- PostgreSQL --------------------------------------------------------------------------
$COMPOSE exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" babana' > "$WORK/babana-$TS.dump" \
  || die "pg_dump."
[ -s "$WORK/babana-$TS.dump" ] || die "dump PostgreSQL vide."

# --- MinIO ------------------------------------------------------------------------------
$COMPOSE exec -T minio sh -c 'mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mirror --quiet local/babana-documents /tmp/bk && tar -C /tmp/bk -cf - .' \
  > "$WORK/babana-documents-$TS.tar" || die "miroir MinIO."

# --- .env chiffré ----------------------------------------------------------------------
_recipients=""
_old_ifs=$IFS; IFS=','
for r in $BACKUP_AGE_RECIPIENTS; do _recipients="$_recipients -r $(printf '%s' "$r" | tr -d ' ')"; done
IFS=$_old_ifs
# shellcheck disable=SC2086
age $_recipients -o "$WORK/env-$TS.age" "$ENV_FILE" || die "chiffrement du .env."

# --- Envoi vers le stockage externe -------------------------------------------------
rclone copy "$WORK" "$BACKUP_REMOTE/$TS/" --checksum || die "envoi rclone."

# --- Rétention (garde 14 jours) ---------------------------------------------------
rclone delete --min-age 14d "$BACKUP_REMOTE" 2>/dev/null || true
rclone rmdirs --leave-root "$BACKUP_REMOTE" 2>/dev/null || true

echo "ok $TS $(du -sh "$WORK" | cut -f1)" >> "$STATE_DIR/backup_history"
date -u +%FT%TZ > "$STATE_DIR/last_backup_ok"
printf 'Sauvegarde %s envoyée vers %s.\n' "$TS" "$BACKUP_REMOTE"

cat <<'EOF'

RAPPEL (spécification L0-07, piège de l'étape 7) : une sauvegarde jamais restaurée n'est pas une
sauvegarde. Tant que infra/production/restore.sh n'a pas RÉUSSI sur un hôte vierge, avec compte
rendu daté dans docs/operations/production.md, considérer que le projet n'a pas de sauvegarde.
EOF
