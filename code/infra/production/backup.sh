#!/bin/sh
# Sauvegarde de la pile babana vers un stockage EXTERNE (L0-07, étape 7 ; L8-08). À faire
# tourner en cron sur l'hôte de production. « Externe » n'est pas négociable : un instantané
# chez le même hébergeur disparaît avec l'incident (amoa/04-monorepo-et-services.md §9).
#
#   0 2 * * *  cd /opt/babana/code && sh infra/production/backup.sh >> /var/log/babana-backup.log 2>&1
#
# Contenu d'une sauvegarde, CHIFFRÉE (age) avant de quitter la machine -- les trois pièces, pas
# seulement le .env : le miroir MinIO porte les pièces d'identité de chauffeurs (L1-05), un dump
# PostgreSQL en clair sur un stockage objet tiers serait tout aussi grave. Constat du 14 septembre
# (amoa/questions/REPONSES-2026-09-14.md) : seul le .env était chiffré jusqu'ici, le dump et le
# tar de documents partaient en clair par `rclone copy` -- corrigé ce soir. Chacun est écrit en
# clair dans $WORK (un `mktemp -d` local, jamais transmis tel quel), chiffré aussitôt, puis son
# clair est supprimé AVANT le seul point d'envoi hors machine (`rclone copy` plus bas) -- jamais
# un chiffrement en pipe : `set -eu` seul ne détecterait pas l'échec de `pg_dump` au milieu d'un
# pipeline (le code de sortie d'un pipeline POSIX est celui de sa DERNIÈRE commande, `age`, qui
# réussirait même sur une entrée vide) sans `pipefail`, une extension absente de `sh` (dash).
#   - dump PostgreSQL de la base `babana` (pg_dump -Fc) -> babana-<TS>.dump.age ;
#   - miroir du bucket MinIO `babana-documents` (pièces chauffeur) -> babana-documents-<TS>.tar.age ;
#   - copie de infra/env/.env chiffrée -> env-<TS>.age.
#
# Destination : définie par BACKUP_REMOTE (une "remote" rclone vers un stockage objet d'un AUTRE
# fournisseur -- Backblaze B2, Scaleway, OVH...). rclone est le seul ajout d'outil, justifié par
# "de préférence un autre fournisseur" de la spécification.
#
# Redis n'est délibérément PAS sauvegardé (L8-08, critère d'acceptation 5) : c'est l'invariant 1
# (règle de partition, amoa/01-architecture.md §2/§9 quater) -- le service temps réel ne possède
# aucune donnée durable, tout ce qui doit survivre a déjà été écrit dans Odoo au moment d'un
# événement métier. Une reprise se reconstruit depuis PostgreSQL (L3-14, test de résilience) ;
# sauvegarder Redis suggérerait à tort qu'une position GPS ou un engagement en cours serait une
# donnée à restaurer, ce qui violerait l'invariant que la partition existe pour garantir.
set -eu

cd "$(git rev-parse --show-toplevel)/code" 2>/dev/null || cd "$(dirname "$0")/../.."
ENV_FILE=infra/env/.env
COMPOSE="docker compose -f infra/compose.yaml --env-file $ENV_FILE"
STATE_DIR=infra/production/.state
TS=$(date -u +%Y%m%dT%H%M%SZ)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

die() { printf 'ÉCHEC sauvegarde : %s\n' "$1" >&2; echo "fail $TS $1" >> "$STATE_DIR/backup_history"; exit 1; }

: "${BACKUP_REMOTE:?BACKUP_REMOTE obligatoire -- ex. b2:babana-backups (remote rclone vers un AUTRE fournisseur que la machine hôte).}"
: "${BACKUP_AGE_RECIPIENTS:?BACKUP_AGE_RECIPIENTS obligatoire -- clés publiques age pour chiffrer la sauvegarde (séparées par des virgules).}"
command -v rclone >/dev/null 2>&1 || die "rclone absent."
command -v age    >/dev/null 2>&1 || die "age absent (chiffrement de la sauvegarde)."
mkdir -p "$STATE_DIR"

_recipients=""
_old_ifs=$IFS; IFS=','
for r in $BACKUP_AGE_RECIPIENTS; do _recipients="$_recipients -r $(printf '%s' "$r" | tr -d ' ')"; done
IFS=$_old_ifs

# --- PostgreSQL --------------------------------------------------------------------------
$COMPOSE exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" babana' > "$WORK/babana-$TS.dump" \
  || die "pg_dump."
[ -s "$WORK/babana-$TS.dump" ] || die "dump PostgreSQL vide."
# shellcheck disable=SC2086
age $_recipients -o "$WORK/babana-$TS.dump.age" "$WORK/babana-$TS.dump" || die "chiffrement du dump."
rm -f "$WORK/babana-$TS.dump"

# --- MinIO -- porte les pièces d'identité de chauffeurs (L1-05), chiffrée comme le dump -------
# `docker compose cp`, pas un `tar` exécuté DANS le conteneur : l'image `minio/minio` (UBI-micro)
# ne fournit ni `tar` ni les utilitaires GNU habituels -- seul `mc` y est installé (constaté le
# 14 septembre en exécutant réellement ce script pour la première fois, L8-08,
# amoa/questions/REPONSES-2026-09-14.md). `mc mirror` copie les objets vers un répertoire du
# conteneur, `compose cp` le rapatrie tel quel sur l'hôte -- qui a `tar` -- pour l'archiver puis
# le chiffrer comme le dump.
$COMPOSE exec -T minio sh -c 'mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && rm -rf /tmp/bk && mc mirror --quiet local/babana-documents /tmp/bk' \
  || die "miroir MinIO."
rm -rf "$WORK/minio-mirror"
$COMPOSE cp minio:/tmp/bk "$WORK/minio-mirror" || die "récupération du miroir MinIO."
tar -C "$WORK/minio-mirror" -cf "$WORK/babana-documents-$TS.tar" . || die "archivage des documents."
rm -rf "$WORK/minio-mirror"
# shellcheck disable=SC2086
age $_recipients -o "$WORK/babana-documents-$TS.tar.age" "$WORK/babana-documents-$TS.tar" \
  || die "chiffrement des documents."
rm -f "$WORK/babana-documents-$TS.tar"

# --- .env chiffré ----------------------------------------------------------------------
# shellcheck disable=SC2086
age $_recipients -o "$WORK/env-$TS.age" "$ENV_FILE" || die "chiffrement du .env."

# --- Envoi vers le stockage externe -- $WORK ne contient plus que des fichiers .age -----
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
