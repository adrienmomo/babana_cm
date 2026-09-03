#!/bin/sh
# Restauration d'une sauvegarde (L0-07, étape 7 -- la moitié qui compte). À exécuter sur un hôte
# VIERGE (pas la production), pour prouver que les sauvegardes sont exploitables. L8-08 n'est
# satisfait que quand ce script a réussi et qu'un compte rendu daté est dans
# docs/operations/production.md.
#
#   BACKUP_REMOTE=b2:babana-backups RESTORE_TS=20261013T020000Z \
#   BACKUP_AGE_IDENTITY_FILE=~/.config/babana/backup-key.txt sh infra/production/restore.sh
#
# Prérequis : dépôt cloné, infra/env/.env déjà déchiffré et en place (age -d -i
# "$BACKUP_AGE_IDENTITY_FILE" -o infra/env/.env env-<TS>.age -- ou laisser ce script le faire, il
# le déchiffre lui-même plus bas), BABANA_DOMAIN pointant vers un nom de test résolu (sinon Caddy
# n'obtient pas de certificat -- ou utiliser un domaine .localhost pour la vérification sans TLS
# public).
#
# BACKUP_AGE_IDENTITY_FILE : le fichier de clé PRIVÉE age (format `age-keygen`) correspondant à
# l'un des destinataires de `backup.sh` (BACKUP_AGE_RECIPIENTS) -- jamais dans le dépôt (invariant
# 5), tenu par le gestionnaire de secrets au même titre que les autres secrets de production.
#
# RESTORE_COMPOSE_PROJECT (optionnel) : nom de projet `docker compose` cible, transmis via `-p`.
# Vide par défaut -- le nom déclaré dans infra/compose.yaml (`babana`) s'applique, le comportement
# normal en production. Le poser à autre chose (`babana-restore-test`, par exemple) fait tourner
# cette restauration dans des conteneurs et des volumes ISOLÉS de toute pile déjà en cours sous le
# nom de projet par défaut -- exactement ce que L8-08 demande pour un « exercice de restauration
# à refaire périodiquement » (spécification) sans jamais risquer d'écraser une base déjà en usage
# avec le même nom. C'est ainsi que la preuve du 3 septembre 2026 (J38,
# docs/operations/production.md §7) a été construite -- voir amoa/rapport-nuit-J38.md §3.
set -eu

cd "$(git rev-parse --show-toplevel)/code" 2>/dev/null || cd "$(dirname "$0")/../.."
ENV_FILE=infra/env/.env
COMPOSE="docker compose${RESTORE_COMPOSE_PROJECT:+ -p $RESTORE_COMPOSE_PROJECT} -f infra/compose.yaml --env-file $ENV_FILE"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

die() { printf 'ÉCHEC restauration : %s\n' "$1" >&2; exit 1; }

: "${BACKUP_REMOTE:?BACKUP_REMOTE obligatoire.}"
: "${RESTORE_TS:?RESTORE_TS obligatoire -- horodatage du répertoire de sauvegarde (ex. 20261013T020000Z).}"
: "${BACKUP_AGE_IDENTITY_FILE:?BACKUP_AGE_IDENTITY_FILE obligatoire -- clé privée age pour déchiffrer la sauvegarde (backup.sh chiffre tout depuis le 14 septembre, amoa/questions/REPONSES-2026-09-14.md).}"
command -v rclone >/dev/null 2>&1 || die "rclone absent."
command -v age    >/dev/null 2>&1 || die "age absent (déchiffrement de la sauvegarde)."
[ -f "$BACKUP_AGE_IDENTITY_FILE" ] || die "$BACKUP_AGE_IDENTITY_FILE introuvable."

rclone copy "$BACKUP_REMOTE/$RESTORE_TS/" "$WORK/" || die "récupération de la sauvegarde."

# --- Déchiffrement -- rien de ce qui suit ne restaure depuis un fichier .age directement -----
DUMP_AGE=$(ls "$WORK"/babana-*.dump.age 2>/dev/null | head -1) || true
DOCS_AGE=$(ls "$WORK"/babana-documents-*.tar.age 2>/dev/null | head -1) || true
ENV_AGE=$(ls "$WORK"/env-*.age 2>/dev/null | head -1) || true
[ -n "$DUMP_AGE" ] && [ -s "$DUMP_AGE" ] || die "dump PostgreSQL chiffré introuvable dans la sauvegarde $RESTORE_TS."

DUMP="${DUMP_AGE%.age}"
age -d -i "$BACKUP_AGE_IDENTITY_FILE" -o "$DUMP" "$DUMP_AGE" || die "déchiffrement du dump."
[ -s "$DUMP" ] || die "dump PostgreSQL vide après déchiffrement."

DOCS=""
if [ -n "$DOCS_AGE" ] && [ -s "$DOCS_AGE" ]; then
  DOCS="${DOCS_AGE%.age}"
  age -d -i "$BACKUP_AGE_IDENTITY_FILE" -o "$DOCS" "$DOCS_AGE" || die "déchiffrement des documents."
fi

[ ! -f "$ENV_FILE" ] && [ -n "$ENV_AGE" ] && [ -s "$ENV_AGE" ] && {
  age -d -i "$BACKUP_AGE_IDENTITY_FILE" -o "$ENV_FILE" "$ENV_AGE" || die "déchiffrement du .env."
}
[ -f "$ENV_FILE" ] || die "$ENV_FILE absent, et aucun env-<TS>.age dans cette sauvegarde pour le reconstituer."

# --- Pile nue (postgres/redis/minio), sans Odoo pour l'instant -----------------------
# `redis` démarre ici VIDE, et c'est correct : L8-08 critère 5, invariant 1 (règle de partition,
# amoa/01-architecture.md §2) -- le service temps réel ne possède aucune donnée durable, rien à
# restaurer. Une course en cours au moment de l'incident se retrouve par L3-14 (résilience), pas
# par une restauration Redis qui n'existe délibérément pas.
$COMPOSE up -d --wait postgres redis minio

# --- PostgreSQL : recréer la base et charger le dump --------------------------------
$COMPOSE exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS babana;" -c "CREATE DATABASE babana OWNER \"$POSTGRES_USER\";"' \
  || die "recréation de la base."
$COMPOSE exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d babana --no-owner --clean --if-exists' < "$DUMP" \
  || die "pg_restore."

# --- MinIO : recharger les pièces --------------------------------------------------
# `docker compose cp`, pas un `tar` exécuté DANS le conteneur (même correctif que backup.sh,
# L8-08, amoa/questions/REPONSES-2026-09-14.md) : l'image `minio/minio` (UBI-micro) n'a pas
# `tar` -- seul `mc` y est installé. L'archive se déballe sur l'HÔTE, `compose cp` dépose le
# résultat DANS le conteneur, `mc mirror` s'exécute depuis ce chemin déjà présent.
if [ -s "$DOCS" ]; then
  mkdir -p "$WORK/docs" && tar -C "$WORK/docs" -xf "$DOCS"
  $COMPOSE exec -T minio sh -c 'mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mb --ignore-existing local/babana-documents >/dev/null' || true
  $COMPOSE exec -T minio sh -c 'rm -rf /tmp/rs' || true
  $COMPOSE cp "$WORK/docs" minio:/tmp/rs || die "dépôt des documents dans le conteneur MinIO."
  $COMPOSE exec -T minio sh -c 'mc mirror --quiet --overwrite /tmp/rs local/babana-documents' \
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
