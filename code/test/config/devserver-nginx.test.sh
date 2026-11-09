#!/bin/sh
# Serveur de développement -- les configurations nginx de infra/devserver/nginx/ acceptées par le
# nginx que le serveur exécute vraiment : le paquet d'Ubuntu 24.04 (nginx 1.24).
#
# Constaté le 9 novembre, au premier `nginx -t` après l'émission du certificat :
# `unknown directive "http2"` -- la directive `http2 on;` n'existe que depuis nginx 1.25.1. Écrite
# sans jamais avoir été lue par un nginx, la configuration HTTPS n'avait été vérifiée par personne.
#
# Ce test fait ce que fait le serveur (README.md, étapes 6 à 8) : les deux sites liés dans
# sites-enabled, le dépôt à son chemin réel (/var/www/babana_cm, les `include` sont absolus), un
# certificat auto-signé à l'emplacement de celui de certbot, puis `nginx -t`.
#
# Usage : sh test/config/devserver-nginx.test.sh   (exige docker ; ne touche ni à la pile ni à git)
set -eu

if [ "${1:-}" != "--inner" ]; then
  SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
  CODE_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
  exec docker run --rm -v "$CODE_DIR:/var/www/babana_cm/code:ro" ubuntu:24.04 \
    sh /var/www/babana_cm/code/test/config/devserver-nginx.test.sh --inner
fi

# ============================ dans le conteneur ===============================================
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends nginx openssl >/dev/null
echo "nginx du paquet Ubuntu 24.04 : $(nginx -v 2>&1)"

LIVE=/etc/letsencrypt/live/babana-devserver
mkdir -p "$LIVE"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=api.babana.dev \
  -keyout "$LIVE/privkey.pem" -out "$LIVE/fullchain.pem" 2>/dev/null

NGINX_DIR=/var/www/babana_cm/code/infra/devserver/nginx
rm -f /etc/nginx/sites-enabled/*
ln -s "$NGINX_DIR/00-babana-http.conf" /etc/nginx/sites-enabled/
ln -s "$NGINX_DIR/10-babana-https.conf" /etc/nginx/sites-enabled/

if nginx -t 2>/tmp/nginx-t.log; then
  echo "ok -- nginx -t accepte 00-babana-http.conf et 10-babana-https.conf"
else
  cat /tmp/nginx-t.log
  echo "not ok -- nginx -t refuse la configuration du serveur de développement" >&2
  exit 1
fi
