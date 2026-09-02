#!/bin/sh
# Retour arrière d'un déploiement (L0-07, étape 10). À exécuter sur l'hôte de production, depuis
# la racine du dépôt.
#
#   sh infra/production/rollback.sh                 # revient au commit précédemment déployé
#   sh infra/production/rollback.sh <commit|tag>    # revient à une référence précise
#
# Ce script ne restaure PAS la base de données. Un retour de CODE suffit quand le déploiement
# fautif n'a pas migré le schéma Odoo. S'il l'a fait (une tâche a tourné `-u babana` avec un
# modèle modifié), la restauration passe par infra/production/backup.sh -> restore.sh et une
# fenêtre d'indisponibilité -- décision humaine, pas automatique. Voir docs/operations/production.md.
set -eu

cd "$(git rev-parse --show-toplevel)/code" 2>/dev/null || cd "$(dirname "$0")/../.."
ENV_FILE=infra/env/.env
COMPOSE="docker compose -f infra/compose.yaml --env-file $ENV_FILE"
STATE_DIR=infra/production/.state

die() { printf 'ÉCHEC : %s\n' "$1" >&2; exit 1; }

TARGET="${1:-$(cat "$STATE_DIR/previous_commit" 2>/dev/null || true)}"
[ -n "$TARGET" ] || die "aucune référence fournie et $STATE_DIR/previous_commit absent. Usage : rollback.sh <commit|tag>"

CURRENT=$(git rev-parse HEAD)
printf 'Retour arrière : %s  ->  %s\nContinuer ? [o/N] ' "$CURRENT" "$TARGET"
read -r answer
case "$answer" in o|O|oui|y|Y) ;; *) die "annulé." ;; esac

git checkout --quiet "$TARGET"

if command -v npm >/dev/null 2>&1; then
  npm ci --prefix . --silent && npm run build:web -w @babana/client
fi

$COMPOSE up -d --build --wait --wait-timeout 300
# Recharge le module dans l'état du code cible (sans -u : pas de migration descendante
# automatique -- si le schéma avait changé, s'arrêter ici et restaurer la base).
$COMPOSE exec -T odoo sh -c 'odoo -d babana --stop-after-init --no-http -u babana --db_host="$HOST" --db_user="$USER" --db_password="$PASSWORD"' \
  || die "rechargement du module en échec sur $TARGET -- probable divergence de schéma. Restaurer la base (backup.sh -> restore.sh)."

sh infra/smoke-test.sh || die "smoke-test toujours rouge après retour arrière."

echo "$TARGET" > "$STATE_DIR/deployed_commit"
date -u +%FT%TZ > "$STATE_DIR/deployed_at"
printf '\nRetour arrière terminé sur %s.\n' "$TARGET"
