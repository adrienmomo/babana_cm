#!/bin/sh
# Durcissement de l'hôte de production (L0-07, étapes 2 et 3 de la procédure de
# amoa/04-monorepo-et-services.md §9). À exécuter UNE FOIS, en root, sur le VPS fraîchement
# provisionné, AVANT tout `deploy.sh`.
#
#   sudo SSH_ADMIN_IPS="203.0.113.4,198.51.100.0/24" SSH_PORT=22 sh infra/production/bootstrap.sh
#
# Idempotent : relançable sans dommage. Ne provisionne PAS le VPS (étape 1) et ne touche PAS au
# DNS (étape 4) -- ces deux-là exigent respectivement un compte hébergeur et un registrar, hors
# de portée d'un script. Voir docs/operations/production.md pour la frontière exacte.
#
# Cible : distribution Debian/Ubuntu LTS (apt, ufw, unattended-upgrades). Sur une autre famille,
# adapter les trois blocs paquets/pare-feu/mises à jour -- la logique reste la même.
set -eu

log() { printf '\n=== %s ===\n' "$1"; }
die() { printf 'ÉCHEC : %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "à exécuter en root (sudo)."
command -v apt-get >/dev/null 2>&1 || die "ce script cible Debian/Ubuntu (apt-get absent)."

SSH_PORT="${SSH_PORT:-22}"
: "${SSH_ADMIN_IPS:?SSH_ADMIN_IPS obligatoire -- adresses autorisées sur le port SSH, séparées par des virgules. Sans elle, ce script pourrait vous verrouiller dehors.}"

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

# --- 2b. SSH : clé uniquement, port restreint ----------------------------------------------
log "SSH : désactivation du mot de passe, port ${SSH_PORT}"
SSHD_DROPIN=/etc/ssh/sshd_config.d/10-babana-hardening.conf
mkdir -p /etc/ssh/sshd_config.d
cat > "$SSHD_DROPIN" <<EOF
# Posé par infra/production/bootstrap.sh (L0-07). Ne pas éditer à la main : relancer le script.
Port ${SSH_PORT}
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 3
EOF

# Garde-fou : refuser de couper l'accès si le compte courant n'a aucune clé publique installée.
_has_key=0
for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
  [ -s "$f" ] && _has_key=1
done
[ "$_has_key" = "1" ] || die "aucune clé publique SSH trouvée (authorized_keys vide). Installer votre clé AVANT de relancer, sinon le prochain login échoue."

if command -v sshd >/dev/null 2>&1; then sshd -t || die "config sshd invalide, rien n'a été rechargé."; fi
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || service ssh reload

# --- 2c. Pare-feu : 80, 443, SSH seulement ------------------------------------------------
# Le port 80 RESTE OUVERT -- Caddy en a besoin pour renouveler les certificats ACME. Le fermer
# « par sécurité » est la cause classique d'une expiration silencieuse ~3 mois après la mise en
# service (spécification L0-07, piège).
log "pare-feu ufw : 80/tcp, 443/tcp, ${SSH_PORT}/tcp (depuis SSH_ADMIN_IPS)"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 80/tcp comment 'ACME + redirection HTTPS (ne jamais fermer)'
ufw allow 443/tcp comment 'HTTPS'
_old_ifs=$IFS; IFS=','
for ip in $SSH_ADMIN_IPS; do
  ip=$(printf '%s' "$ip" | tr -d ' ')
  [ -n "$ip" ] || continue
  ufw allow from "$ip" to any port "$SSH_PORT" proto tcp comment 'SSH admin'
done
IFS=$_old_ifs
ufw --force enable
ufw status verbose

# --- 3. Mises à jour de sécurité automatiques --------------------------------------------
log "mises à jour de sécurité automatiques"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
systemctl enable --now fail2ban >/dev/null 2>&1 || true

log "terminé"
cat <<EOF
Hôte durci. Vérifications à faire MAINTENANT, depuis une NOUVELLE session (ne pas fermer
celle-ci avant d'avoir confirmé) :
  - ssh -p ${SSH_PORT} <user>@<hôte>            doit fonctionner par clé
  - ssh -o PubkeyAuthentication=no ...          doit être refusé (mot de passe désactivé)
  - ufw status                                  80, 443 ouverts ; SSH restreint à SSH_ADMIN_IPS
  - age --version && rclone --version           les deux doivent répondre (requis par backup.sh)

Étapes qui restent, et qui n'appartiennent pas à ce script :
  1. Provisionnement du VPS (NVMe, LTS) -- compte hébergeur.
  4. DNS -- enregistrements A babana.cm / api. / admin. (+ sous-domaines de recette), et
     ATTENDRE la propagation avant deploy.sh (Caddy échoue sur un nom non résolu).
Puis : infra/production/deploy.sh
EOF
