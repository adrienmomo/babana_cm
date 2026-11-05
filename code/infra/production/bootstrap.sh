#!/bin/sh
# Durcissement de l'hôte de production (L0-07, étapes 2 et 3 de la procédure de
# amoa/04-monorepo-et-services.md §9). À exécuter en root, sur le VPS fraîchement provisionné,
# AVANT tout `deploy.sh`.
#
#   sudo SSH_ADMIN_IPS="203.0.113.4,198.51.100.0/24" sh infra/production/bootstrap.sh
#
# Changement de port SSH : DEUX passages, sans quoi une erreur enferme dehors.
#   1. sudo SSH_ADMIN_IPS=... SSH_PORT=44646 sh infra/production/bootstrap.sh
#      -> sshd écoute sur 22 ET 44646, le pare-feu laisse passer les deux.
#   2. Ouvrir une NOUVELLE session sur 44646 (sans fermer la courante), puis :
#      sudo SSH_ADMIN_IPS=... SSH_PORT=44646 SSH_PORT_CONFIRMED=1 sh infra/production/bootstrap.sh
#      -> 22 est retiré de sshd et du pare-feu.
#
# Exceptions à §9, jamais par défaut (amoa/questions/DEVSERVER-2026-11-05.md §3) :
#   SSH_ADMIN_IPS=any          SSH ouvert à toute adresse (limité en débit par ufw, et fail2ban)
#   SSH_KEEP_PASSWORD_LOGIN=1  n'écrit aucune directive de mot de passe ni de connexion root :
#                              l'hôte garde ce qu'il avait
#
# Idempotent : relançable sans dommage. Ne provisionne PAS le VPS (étape 1) et ne touche PAS au
# DNS (étape 4) -- voir docs/operations/production.md pour la frontière exacte.
#
# Cible : Debian/Ubuntu LTS (apt, ufw, unattended-upgrades). Gère les deux façons de démarrer
# sshd : service classique (Debian 12, Ubuntu 22.04) et activation de socket (Ubuntu 24.04).
# Vérifié par test/config/bootstrap.test.sh.
set -eu

log() { printf '\n=== %s ===\n' "$1"; }
die() { printf 'ÉCHEC : %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "à exécuter en root (sudo)."
command -v apt-get >/dev/null 2>&1 || die "ce script cible Debian/Ubuntu (apt-get absent)."

SSH_PORT="${SSH_PORT:-22}"
SSH_PORT_CONFIRMED="${SSH_PORT_CONFIRMED:-0}"
SSH_KEEP_PASSWORD_LOGIN="${SSH_KEEP_PASSWORD_LOGIN:-0}"
SSH_LISTEN_WAIT_SECONDS="${SSH_LISTEN_WAIT_SECONDS:-10}"
: "${SSH_ADMIN_IPS:?SSH_ADMIN_IPS obligatoire -- adresses autorisées sur le port SSH, séparées par des virgules, ou « any » pour toute adresse (exception à §9). Sans elle, ce script pourrait vous verrouiller dehors.}"

case "$SSH_PORT" in
  ''|*[!0-9]*) die "SSH_PORT invalide : « $SSH_PORT »." ;;
esac
[ "$SSH_PORT" -ge 1 ] && [ "$SSH_PORT" -le 65535 ] || die "SSH_PORT hors de 1-65535 : $SSH_PORT."

# Ports sur lesquels sshd écoute À L'ISSUE de ce passage. Tant que le nouveau port n'a pas été
# éprouvé par une vraie session, 22 reste ouvert à côté : c'est ce qui rend l'erreur réparable.
if [ "$SSH_PORT" = 22 ] || [ "$SSH_PORT_CONFIRMED" = 1 ]; then
  LISTEN_PORTS="$SSH_PORT"
else
  LISTEN_PORTS="22 $SSH_PORT"
fi

# Garde-fou AVANT toute écriture : refuser si aucun compte n'a de clé publique installée. Écrite
# après la configuration sshd (ancienne version), elle laissait le fichier en place, appliqué au
# prochain redémarrage de sshd ou de la machine.
_has_key=0
for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
  [ -s "$f" ] && _has_key=1
done
[ "$_has_key" = "1" ] || die "aucune clé publique SSH trouvée (authorized_keys vide). Installer votre clé AVANT de relancer, sinon le prochain login échoue."

# --- 2a. Paquets -----------------------------------------------------------------------------
# `age` et `rclone` : exigés par backup.sh/restore.sh (L8-08, critère d'acceptation 7) --
# `command -v age`/`command -v rclone` y font échouer la sauvegarde net si absents, et rien
# d'autre ne les installe. Un VPS provisionné en suivant cette seule procédure doit pouvoir
# sauvegarder dès le premier soir -- c'est ce script, le seul qui touche l'hôte lui-même, qui
# les pose (constaté le 3 septembre : `bootstrap.sh` durcissait déjà SSH/pare-feu sans jamais
# poser l'outillage applicatif que `backup.sh` suppose déjà présent).
log "paquets (ufw, unattended-upgrades, fail2ban, chrony, age, rclone)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ufw unattended-upgrades fail2ban chrony curl ca-certificates age rclone

# --- 2b. SSH ---------------------------------------------------------------------------------
log "SSH : port(s) $(echo $LISTEN_PORTS | tr ' ' ',')"
SSHD_DROPIN=/etc/ssh/sshd_config.d/10-babana-hardening.conf
mkdir -p /etc/ssh/sshd_config.d
{
  echo "# Posé par infra/production/bootstrap.sh (L0-07). Ne pas éditer à la main : relancer le script."
  for p in $LISTEN_PORTS; do echo "Port $p"; done
  if [ "$SSH_KEEP_PASSWORD_LOGIN" != 1 ]; then
    # Le premier fichier qui pose une directive l'emporte : `10-` passe avant le
    # `50-cloud-init.conf` des images cloud, qui réactive le mot de passe.
    echo "PasswordAuthentication no"
    echo "KbdInteractiveAuthentication no"
    echo "ChallengeResponseAuthentication no"
    echo "PermitRootLogin prohibit-password"
  fi
  echo "PubkeyAuthentication yes"
  echo "X11Forwarding no"
  echo "MaxAuthTries 3"
} > "$SSHD_DROPIN"

if command -v sshd >/dev/null 2>&1; then sshd -t || die "config sshd invalide, rien n'a été rechargé."; fi

# Ubuntu 24.04 : le port appartient à ssh.socket, régénéré depuis sshd_config par
# sshd-socket-generator au daemon-reload. `reload ssh` n'y change rien -- c'est le défaut qui
# enfermait dehors (amoa/questions/DEVSERVER-2026-11-05.md §2). Redémarrer le socket redémarre
# sshd (ssh.service en dépend) ; KillMode=process laisse vivre les sessions ouvertes.
if systemctl is-enabled ssh.socket >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl restart ssh.socket
else
  systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || service ssh restart
fi

# Vérifier que chaque port écoute RÉELLEMENT avant de toucher au pare-feu.
for p in $LISTEN_PORTS; do
  _waited=0
  until ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${p}\$"; do
    [ "$_waited" -ge "$SSH_LISTEN_WAIT_SECONDS" ] && die "sshd n'écoute pas sur le port $p après ${SSH_LISTEN_WAIT_SECONDS}s. Pare-feu NON modifié ; la session courante reste ouverte. Voir 'ss -ltnp' et 'journalctl -u ssh.socket -u ssh'."
    sleep 1; _waited=$((_waited + 1))
  done
done

# --- 2c. Pare-feu : 80, 443, SSH seulement ------------------------------------------------
# Le port 80 RESTE OUVERT -- Caddy en a besoin pour renouveler les certificats ACME. Le fermer
# « par sécurité » est la cause classique d'une expiration silencieuse ~3 mois après la mise en
# service (spécification L0-07, piège).
log "pare-feu ufw : 80/tcp, 443/tcp, SSH $(echo $LISTEN_PORTS | tr ' ' ',')/tcp depuis ${SSH_ADMIN_IPS}"
[ -f /etc/default/ufw ] && sed -i 's/^IPV6=.*/IPV6=yes/' /etc/default/ufw
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 80/tcp comment 'ACME + redirection HTTPS (ne jamais fermer)'
ufw allow 443/tcp comment 'HTTPS'
for p in $LISTEN_PORTS; do
  if [ "$SSH_ADMIN_IPS" = any ]; then
    ufw limit "$p/tcp" comment 'SSH, toute adresse (limité en débit)'
  else
    _old_ifs=$IFS; IFS=','
    for ip in $SSH_ADMIN_IPS; do
      ip=$(printf '%s' "$ip" | tr -d ' ')
      [ -n "$ip" ] || continue
      ufw allow from "$ip" to any port "$p" proto tcp comment 'SSH admin'
    done
    IFS=$_old_ifs
  fi
done
ufw --force enable
ufw status verbose

# --- 2d. fail2ban : surveiller le port réellement ouvert ------------------------------------
# La prison `sshd` par défaut surveille « ssh », c'est-à-dire 22 : après un changement de port
# elle ne protégeait plus rien.
log "fail2ban : prison sshd sur $(echo $LISTEN_PORTS | tr ' ' ',')"
mkdir -p /etc/fail2ban/jail.d
cat > /etc/fail2ban/jail.d/babana-sshd.local <<EOF
# Posé par infra/production/bootstrap.sh (L0-07). Ne pas éditer à la main : relancer le script.
[sshd]
enabled = true
port = $(echo $LISTEN_PORTS | tr ' ' ',')
EOF
systemctl enable fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban
systemctl is-active --quiet fail2ban || die "fail2ban ne démarre pas -- voir 'journalctl -u fail2ban'. SSH est exposé sans protection contre les essais répétés."

# --- 3. Mises à jour de sécurité automatiques --------------------------------------------
log "mises à jour de sécurité automatiques"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

log "terminé"
if [ "$LISTEN_PORTS" != "$SSH_PORT" ]; then
  cat <<EOF
Port SSH en TRANSITION : sshd écoute sur 22 et ${SSH_PORT}. NE PAS fermer cette session.
  1. Depuis une NOUVELLE session :  ssh -p ${SSH_PORT} <user>@<hôte>
  2. Si elle s'ouvre, retirer 22 :
     sudo SSH_ADMIN_IPS="${SSH_ADMIN_IPS}" SSH_PORT=${SSH_PORT} SSH_PORT_CONFIRMED=1 sh infra/production/bootstrap.sh
EOF
fi
cat <<EOF
Vérifications à faire MAINTENANT, depuis une NOUVELLE session (ne pas fermer celle-ci avant
d'avoir confirmé) :
  - ssh -p ${SSH_PORT} <user>@<hôte>            doit fonctionner par clé
  - ufw status                                  80, 443 ouverts ; SSH selon SSH_ADMIN_IPS
  - fail2ban-client status sshd                 prison active
  - age --version && rclone --version           les deux doivent répondre (requis par backup.sh)

Étapes qui restent, et qui n'appartiennent pas à ce script :
  1. Provisionnement du VPS (NVMe, LTS) -- compte hébergeur.
  4. DNS -- enregistrements A babana.cm / api. / admin. / storage. (+ recette), et ATTENDRE la
     propagation avant deploy.sh (Caddy échoue sur un nom non résolu).
Puis : infra/production/deploy.sh
EOF
