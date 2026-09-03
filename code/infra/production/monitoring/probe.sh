#!/bin/sh
# Sonde EXTERNE (L0-07, étape 8). À faire tourner depuis une AUTRE machine que l'hôte de
# production -- une sonde hébergée sur la machine qu'elle surveille est muette exactement quand
# elle serait utile (amoa/04-monorepo-et-services.md §9).
#
#   */2 * * * *  DOMAIN=babana.cm ALERT_CMD='curl -s -X POST https://...' sh probe.sh
#
# Ne teste QUE ce qui se voit du dehors, sans SSH : les trois hôtes répondent, et les
# certificats n'expirent pas bientôt. Le disque, le vol de CPU, l'âge de la dernière sauvegarde
# et la file d'attente Odoo (L3-12) demandent un accès à l'hôte -> probe-host.sh.
#
# Sortie : une ligne par contrôle (OK / ALERTE). Code de sortie non nul s'il y a au moins une
# alerte. Si ALERT_CMD est défini, il est appelé une fois par alerte avec le message en $1.
set -u

# D61 étendue (amoa/01-architecture.md §9 octies, 16 septembre 2026) : `${DOMAIN:-babana.cm}`
# était le troisième repli de ce genre trouvé ce soir-là (après controllers/share.py et le
# maillon manquant de BABANA_DOMAIN vers le conteneur odoo) -- une sonde de RECETTE qui oublie de
# poser DOMAIN surveillerait silencieusement la PRODUCTION, en pensant surveiller staging. Même
# discipline que SSH_TARGET dans probe-host.sh ci-contre, jamais un repli plausible.
: "${DOMAIN:?DOMAIN obligatoire -- ex. babana.cm ou staging.babana.cm}"
CERT_WARN_DAYS="${CERT_WARN_DAYS:-14}"
ALERT_CMD="${ALERT_CMD:-}"
fail=0

alert() {
  printf 'ALERTE - %s\n' "$1"
  fail=1
  [ -n "$ALERT_CMD" ] && sh -c "$ALERT_CMD" _ "babana probe: $1" >/dev/null 2>&1 || true
}
ok() { printf 'OK    - %s\n' "$1"; }

# --- Disponibilité des trois hôtes -------------------------------------------------
for host in "$DOMAIN" "api.$DOMAIN" "admin.$DOMAIN"; do
  # admin. répond 403 hors liste : c'est une réponse SAINE (le serveur est debout).
  code=$(curl -sk -o /dev/null -m 10 -w '%{http_code}' "https://$host/" || echo 000)
  case "$code" in
    000) alert "$host injoignable (timeout ou DNS)" ;;
    5*)  alert "$host répond HTTP $code" ;;
    *)   ok "$host répond HTTP $code" ;;
  esac
done

# GET /web/health précis sur api.
code=$(curl -sk -o /dev/null -m 10 -w '%{http_code}' "https://api.$DOMAIN/web/health" || echo 000)
[ "$code" = "200" ] && ok "api.$DOMAIN/web/health 200" || alert "api.$DOMAIN/web/health = $code"
code=$(curl -sk -o /dev/null -m 10 -w '%{http_code}' "https://api.$DOMAIN/rt/health" || echo 000)
[ "$code" = "200" ] && ok "api.$DOMAIN/rt/health 200" || alert "api.$DOMAIN/rt/health = $code"

# --- Expiration des certificats -------------------------------------------------
now=$(date -u +%s)
for host in "$DOMAIN" "api.$DOMAIN" "admin.$DOMAIN"; do
  end=$(printf 'Q\n' | openssl s_client -connect "$host:443" -servername "$host" 2>/dev/null \
        | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [ -z "$end" ]; then
    alert "$host : impossible de lire le certificat"
    continue
  fi
  end_s=$(date -u -d "$end" +%s 2>/dev/null || date -u -j -f '%b %d %T %Y %Z' "$end" +%s 2>/dev/null || echo 0)
  days=$(( (end_s - now) / 86400 ))
  if [ "$end_s" = "0" ]; then
    alert "$host : date d'expiration du certificat illisible ($end)"
  elif [ "$days" -lt "$CERT_WARN_DAYS" ]; then
    alert "$host : certificat expire dans $days j (seuil $CERT_WARN_DAYS)"
  else
    ok "$host : certificat valide $days j"
  fi
done

exit "$fail"
