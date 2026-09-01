#!/bin/sh
# Sonde qui a besoin d'un accès à l'hôte (L0-07, étape 8). À faire tourner depuis une AUTRE
# machine, qui se connecte en SSH à l'hôte de production -- toujours pas de sonde sur la machine
# surveillée.
#
#   */5 * * * *  SSH_TARGET=deploy@babana.cm ALERT_CMD='...' sh probe-host.sh
#
# Contrôle, sur l'hôte :
#   - occupation disque (/ et le volume Docker) ;
#   - VOL DE CPU (steal %) -- spécifique au choix D18 (hôte partagé Contabo) : une dégradation
#     due au voisinage est indiscernable d'une régression applicative si personne ne la mesure ;
#   - âge de la dernière sauvegarde réussie (infra/production/.state/last_backup_ok) ;
#   - taille de la file d'attente vers Odoo (L3-12) -- PLACEHOLDER : la file de rejeu n'est pas
#     encore construite (voir amoa/PROMPT-NUIT-J29.md « Après cette nuit »). Le contrôle est
#     posé, désactivé, prêt à être activé quand L3-12 existera.
set -u

: "${SSH_TARGET:?SSH_TARGET obligatoire -- ex. deploy@babana.cm}"
SSH_OPTS="${SSH_OPTS:--o ConnectTimeout=10 -o BatchMode=yes}"
DISK_WARN_PCT="${DISK_WARN_PCT:-85}"
STEAL_WARN_PCT="${STEAL_WARN_PCT:-8}"
BACKUP_MAX_AGE_H="${BACKUP_MAX_AGE_H:-30}"
APP_DIR="${APP_DIR:-/opt/babana/code}"
ALERT_CMD="${ALERT_CMD:-}"
fail=0

alert() { printf 'ALERTE - %s\n' "$1"; fail=1; [ -n "$ALERT_CMD" ] && sh -c "$ALERT_CMD" _ "babana probe-host: $1" >/dev/null 2>&1 || true; }
ok()    { printf 'OK    - %s\n' "$1"; }

# Heredoc quoté : tout s'évalue SUR L'HÔTE. APP_DIR est passé en argument ($1), pas interpolé
# côté client. shellcheck SC2086 : $SSH_OPTS doit rester non quoté (liste d'options).
# shellcheck disable=SC2086
REMOTE=$(ssh $SSH_OPTS "$SSH_TARGET" "sh -s '$APP_DIR'" <<'REMOTE_EOF' 2>/dev/null
set -u
APP_DIR=$1
echo "DISK_ROOT=$(df -P / | awk 'NR==2{gsub(/%/,"",$5); print $5}')"
echo "DISK_DOCKER=$(df -P /var/lib/docker 2>/dev/null | awk 'NR==2{gsub(/%/,"",$5); print $5}')"
# vol de CPU : 2e lecture de 'vmstat 1 2', dernière colonne ('st')
echo "STEAL=$(vmstat 1 2 2>/dev/null | awk 'END{print $NF}')"
echo "BACKUP_TS=$(cat "$APP_DIR/infra/production/.state/last_backup_ok" 2>/dev/null)"
echo "DEPLOYED=$(cat "$APP_DIR/infra/production/.state/deployed_commit" 2>/dev/null)"
REMOTE_EOF
)
[ -n "$REMOTE" ] || { alert "SSH vers $SSH_TARGET impossible"; exit 1; }

# eval sûr : chaque ligne est KEY=valeur produite ci-dessus
eval "$REMOTE"

case "${DISK_ROOT:-}" in
  ''|*[!0-9]*) alert "occupation disque / illisible" ;;
  *) [ "${DISK_ROOT}" -ge "$DISK_WARN_PCT" ] && alert "disque / à ${DISK_ROOT}% (seuil $DISK_WARN_PCT)" || ok "disque / à ${DISK_ROOT}%" ;;
esac
case "${DISK_DOCKER:-}" in
  ''|*[!0-9]*) : ;;
  *) [ "${DISK_DOCKER}" -ge "$DISK_WARN_PCT" ] && alert "disque Docker à ${DISK_DOCKER}%" || ok "disque Docker à ${DISK_DOCKER}%" ;;
esac
case "${STEAL:-}" in
  ''|*[!0-9]*) ok "vol de CPU : non mesurable (vmstat absent ?)" ;;
  *) [ "${STEAL}" -ge "$STEAL_WARN_PCT" ] && alert "vol de CPU à ${STEAL}% (seuil $STEAL_WARN_PCT) -- voisinage Contabo, cf. seuil de bascule" || ok "vol de CPU à ${STEAL}%" ;;
esac

if [ -z "${BACKUP_TS:-}" ]; then
  alert "aucune sauvegarde réussie enregistrée (last_backup_ok absent)"
else
  bs=$(date -u -d "$BACKUP_TS" +%s 2>/dev/null || echo 0)
  age_h=$(( ( $(date -u +%s) - bs ) / 3600 ))
  [ "$bs" = "0" ] && alert "horodatage de sauvegarde illisible ($BACKUP_TS)" \
    || { [ "$age_h" -gt "$BACKUP_MAX_AGE_H" ] && alert "dernière sauvegarde il y a ${age_h} h (seuil $BACKUP_MAX_AGE_H)" || ok "dernière sauvegarde il y a ${age_h} h"; }
fi

# File d'attente Odoo (L3-12) -- décommenter quand la file de rejeu existe.
# QUEUE=$(ssh $SSH_OPTS "$SSH_TARGET" "cd $APP_DIR && docker compose -f infra/compose.yaml exec -T odoo sh -c 'odoo shell ...'")
ok "file d'attente Odoo (L3-12) : contrôle en attente de la tâche L3-12"

exit "$fail"
