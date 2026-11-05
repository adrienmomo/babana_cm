#!/bin/sh
# L0-07 -- infra/production/bootstrap.sh sur Ubuntu 24.04 (amoa/questions/DEVSERVER-2026-11-05.md §2).
#
# Ubuntu 24.04 démarre SSH par activation de socket : le port d'écoute appartient à `ssh.socket`,
# régénéré depuis sshd_config par `sshd-socket-generator` au `daemon-reload`. Un `systemctl reload
# ssh` ne le change pas. L'ancien script écrivait `Port ${SSH_PORT}`, rechargeait `ssh`, puis
# activait ufw en n'autorisant QUE le nouveau port : sshd restait sur 22, fermé par ufw, et rien
# n'écoutait sur le nouveau port -- enfermé dehors, console de l'hébergeur pour seule issue.
#
# Ce test exécute le VRAI script, dans un conteneur ubuntu:24.04 (dash, /etc jetable), avec des
# doublures de systemctl / ss / ufw / apt-get / sshd qui reproduisent ce que l'examen du serveur
# a montré le 5 novembre (`systemctl cat ssh.socket ssh.service`) : en mode socket, seul
# `daemon-reload` puis `restart ssh.socket` déplace le port. Après chaque exécution, il répond à
# la seule question qui compte : une NOUVELLE session SSH peut-elle encore s'ouvrir ?
#
# Usage : sh test/config/bootstrap.test.sh   (exige docker ; ne touche ni à la pile ni à git)
set -eu

if [ "${1:-}" != "--inner" ]; then
  SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
  CODE_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
  exec docker run --rm -v "$CODE_DIR:/w:ro" ubuntu:24.04 sh /w/test/config/bootstrap.test.sh --inner
fi

# ============================ dans le conteneur ===============================================
BOOTSTRAP=/w/infra/production/bootstrap.sh
FAKE=/fake
STATE=$FAKE/state
mkdir -p "$FAKE/bin"

# --- Doublures ---------------------------------------------------------------------------------
# Ports déclarés par la configuration sshd, comme les lit sshd-socket-generator. 22 si aucun.
cat > "$FAKE/bin/fake-config-ports" <<'EOF'
#!/bin/sh
ports=$(cat /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | awk '$1 == "Port" { print $2 }' | sort -u)
[ -n "$ports" ] && printf '%s\n' "$ports" || echo 22
EOF

cat > "$FAKE/bin/systemctl" <<'EOF'
#!/bin/sh
S=/fake/state
echo "systemctl $*" >> $S/calls
action=$1; for unit; do :; done   # unit = dernier argument (`enable --now fail2ban`)
mode=$(cat $S/mode)
case "$action" in
  is-enabled)
    if [ "$unit" = ssh.socket ] && [ "$mode" = socket ]; then echo enabled; exit 0; fi
    echo disabled; exit 1 ;;
  daemon-reload)
    # sshd-socket-generator : régénère les ListenStream de ssh.socket depuis sshd_config.
    if [ "$mode" = socket ] && [ -z "${FAKE_GENERATOR_BROKEN:-}" ]; then fake-config-ports > $S/generated; fi ;;
  restart|reload|start|try-restart)
    case "$mode:$unit" in
      socket:ssh.socket) [ "$action" = restart ] && cp $S/generated $S/listening ;;
      socket:*)          : ;;   # sshd reprend les descripteurs du socket : port inchangé
      classic:ssh|classic:sshd|classic:ssh.service|classic:sshd.service) fake-config-ports > $S/listening ;;
    esac ;;
  is-active)
    if [ "$unit" = fail2ban ] && [ -n "${FAKE_F2B_INACTIVE:-}" ]; then echo inactive; exit 3; fi
    echo active ;;
esac
exit 0
EOF

cat > "$FAKE/bin/service" <<'EOF'
#!/bin/sh
exec systemctl "$2" "$1"
EOF

cat > "$FAKE/bin/ss" <<'EOF'
#!/bin/sh
while read -r p; do printf 'LISTEN 0 4096 0.0.0.0:%s 0.0.0.0:*\n' "$p"; done < /fake/state/listening
EOF

# Règles ufw réduites à « port » (ouvert à tous) ou « port from IP ».
cat > "$FAKE/bin/ufw" <<'EOF'
#!/bin/sh
S=/fake/state
echo "ufw $*" >> $S/calls
case "$*" in
  "--force reset") : > $S/ufw_rules; echo 0 > $S/ufw_enabled ;;
  "--force enable") echo 1 > $S/ufw_enabled ;;
  default*|status*) : ;;
  "allow from "*) set -- $*; echo "${7%%/*} from $3" >> $S/ufw_rules ;;   # allow from IP to any port P
  allow*|limit*)  set -- $*; echo "${2%%/*}" >> $S/ufw_rules ;;
  *) echo "ufw (doublure) : commande inattendue : $*" >&2; exit 2 ;;
esac
EOF

for c in apt-get sshd; do printf '#!/bin/sh\necho "%s $*" >> /fake/state/calls\n' "$c" > "$FAKE/bin/$c"; done
chmod +x "$FAKE"/bin/*
export PATH="$FAKE/bin:$PATH"

# --- Outils du test ------------------------------------------------------------------------
fail=0
ok() { printf 'OK     %s\n' "$1"; }
ko() { printf 'ÉCHEC  %s\n' "$1" >&2; fail=1; }
check() { if eval "$2"; then ok "$1"; else ko "$1"; fi; }

fresh_host() {   # $1 = socket | classic
  rm -rf "$STATE" /etc/ssh/sshd_config.d /etc/fail2ban /root/.ssh
  mkdir -p "$STATE" /etc/ssh/sshd_config.d /etc/fail2ban/jail.d /root/.ssh
  echo "$1" > "$STATE/mode"
  echo 22 > "$STATE/listening"; echo 22 > "$STATE/generated"
  echo 0 > "$STATE/ufw_enabled"; : > "$STATE/ufw_rules"; : > "$STATE/calls"
  printf 'Include /etc/ssh/sshd_config.d/*.conf\nPermitRootLogin yes\n' > /etc/ssh/sshd_config
  echo 'ssh-ed25519 AAAA test@host' > /root/.ssh/authorized_keys
}

run_bootstrap() {   # variables passées en préfixe par l'appelant ; code de retour dans $rc
  rc=0
  SSH_LISTEN_WAIT_SECONDS=1 sh "$BOOTSTRAP" > "$STATE/out" 2>&1 || rc=$?
}

# Une NOUVELLE session SSH depuis $1 (adresse) peut-elle s'ouvrir ? Un port qui écoute ET que le
# pare-feu laisse passer.
can_login_from() {
  while read -r p; do
    [ "$(cat "$STATE/ufw_enabled")" = 0 ] && return 0
    grep -qx "$p" "$STATE/ufw_rules" && return 0
    grep -qx "$p from $1" "$STATE/ufw_rules" && return 0
  done < "$STATE/listening"
  return 1
}
listening() { grep -qx "$1" "$STATE/listening"; }
dropin() { cat /etc/ssh/sshd_config.d/*babana* 2>/dev/null; }

# --- 1. Changement de port, hôte à activation de socket, premier passage ------------------
fresh_host socket
SSH_ADMIN_IPS=any SSH_PORT=44646 run_bootstrap
check "1. premier passage : le script réussit (rc=$rc)" '[ "$rc" = 0 ]'
check "1. une nouvelle session SSH peut encore s'ouvrir (le défaut : enfermé dehors)" 'can_login_from 198.51.100.7'
check "1. sshd écoute sur 22 ET 44646 pendant la transition" 'listening 22 && listening 44646'
check "1. ufw laisse passer 22 et 44646" 'grep -qx 22 $STATE/ufw_rules && grep -qx 44646 $STATE/ufw_rules'
check "1. la prison fail2ban surveille 44646 (et 22 tant qu'il est ouvert)" 'grep -Eq "^port *= *.*44646" /etc/fail2ban/jail.d/*babana* 2>/dev/null && grep -Eq "^port *= *.*22" /etc/fail2ban/jail.d/*babana*'
check "1. le script dit comment confirmer le nouveau port" 'grep -q SSH_PORT_CONFIRMED=1 $STATE/out'

# --- 2. Second passage, après une session ouverte sur le nouveau port -------------------------
SSH_ADMIN_IPS=any SSH_PORT=44646 SSH_PORT_CONFIRMED=1 run_bootstrap
check "2. second passage : le script réussit (rc=$rc)" '[ "$rc" = 0 ]'
check "2. sshd n'écoute plus que sur 44646" 'listening 44646 && ! listening 22'
check "2. ufw a refermé 22" '! grep -q "^22\b" $STATE/ufw_rules'
check "2. une nouvelle session SSH peut s'ouvrir sur 44646" 'can_login_from 198.51.100.7'

# --- 3. Hôte sans activation de socket (Debian 12, Ubuntu 22.04) -----------------------------
fresh_host classic
SSH_ADMIN_IPS=any SSH_PORT=44646 run_bootstrap
check "3. hôte classique : 22 et 44646 écoutent, session possible" '[ "$rc" = 0 ] && listening 22 && listening 44646 && can_login_from 198.51.100.7'

# --- 4. Le port ne se met pas à écouter : on n'active surtout pas le pare-feu -----------------
fresh_host socket
FAKE_GENERATOR_BROKEN=1 SSH_ADMIN_IPS=any SSH_PORT=44646 run_bootstrap
check "4. port absent : le script échoue (rc=$rc)" '[ "$rc" != 0 ]'
check "4. port absent : ufw n'a pas été activé, la session reste possible" '[ "$(cat $STATE/ufw_enabled)" = 0 ] && can_login_from 198.51.100.7'

# --- 5. Sans SSH_ADMIN_IPS : refus, rien d'écrit ------------------------------------------
fresh_host socket
SSH_PORT=44646 run_bootstrap
check "5. SSH_ADMIN_IPS absente : refus avant toute écriture" '[ "$rc" != 0 ] && [ -z "$(dropin)" ]'

# --- 6. Par défaut, §9 : clé seule, port restreint ------------------------------------------
fresh_host socket
SSH_ADMIN_IPS=203.0.113.4 run_bootstrap
check "6. défaut : PasswordAuthentication no" 'dropin | grep -qx "PasswordAuthentication no"'
check "6. défaut : KbdInteractiveAuthentication no" 'dropin | grep -qx "KbdInteractiveAuthentication no"'
check "6. défaut : PermitRootLogin prohibit-password" 'dropin | grep -qx "PermitRootLogin prohibit-password"'
check "6. défaut : SSH réservé à SSH_ADMIN_IPS" 'grep -qx "22 from 203.0.113.4" $STATE/ufw_rules && ! grep -qx 22 $STATE/ufw_rules'
check "6. défaut : la session reste possible depuis l'adresse d'administration" 'can_login_from 203.0.113.4'

# --- 7. SSH_KEEP_PASSWORD_LOGIN=1 : le script ne touche pas aux mots de passe -----------------
fresh_host socket
SSH_ADMIN_IPS=any SSH_KEEP_PASSWORD_LOGIN=1 run_bootstrap
check "7. option : aucune directive de mot de passe ni de connexion root écrite" \
  '[ "$rc" = 0 ] && ! dropin | grep -Eq "^(PasswordAuthentication|KbdInteractiveAuthentication|ChallengeResponseAuthentication|PermitRootLogin) "'

# --- 8. fail2ban qui ne démarre pas : échec, pas un silence -----------------------------------
fresh_host socket
FAKE_F2B_INACTIVE=1 SSH_ADMIN_IPS=any run_bootstrap
check "8. fail2ban inactif : le script échoue (rc=$rc)" '[ "$rc" != 0 ]'

# --- 9. Aucune clé publique : refus AVANT d'écrire la configuration sshd ---------------------
fresh_host socket
rm -f /root/.ssh/authorized_keys
SSH_ADMIN_IPS=any run_bootstrap
check "9. sans clé : refus, et aucune configuration sshd laissée pour le prochain redémarrage" '[ "$rc" != 0 ] && [ -z "$(dropin)" ]'

[ "$fail" = 0 ] || { echo "--- dernière sortie de bootstrap.sh ---" >&2; cat "$STATE/out" >&2; exit 1; }
echo "bootstrap.test.sh : tout est vert"
