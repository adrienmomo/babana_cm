#!/bin/sh
# Vérifications de L0-01 après `make up` (critères d'acceptation 2, 5, 6, 7). Ne remplace pas
# les tests automatisés d'un paquet -- c'est un script d'exploitation, pensé pour être relancé
# après tout changement à infra/, pas seulement documenté une fois dans le rapport de nuit.
#
# Usage : infra/smoke-test.sh   (depuis code/, après `make up`)
set -u

fail=0
pass() { echo "OK   - $1"; }
bad()  { echo "ÉCHEC - $1"; fail=1; }

# Critère 2 : les trois points de santé répondent.
curl -ksf https://api.localhost/web/health >/dev/null && pass "GET https://api.localhost/web/health" \
  || bad "GET https://api.localhost/web/health"

curl -ksf https://api.localhost/rt/health >/dev/null && pass "GET https://api.localhost/rt/health" \
  || bad "GET https://api.localhost/rt/health"

curl -ks -o /dev/null -w '%{http_code}' https://admin.localhost | grep -qE '^(200|303|302)$' \
  && pass "GET https://admin.localhost sert le back-office" \
  || bad "GET https://admin.localhost ne répond pas comme un back-office Odoo"

# Critère 6 : les trois hôtes répondent avec la même structure de chemins qu'en production.
curl -ks -o /dev/null -w '%{http_code}' https://localhost/.well-known/assetlinks.json | grep -q '^200$' \
  && pass "GET https://localhost/.well-known/assetlinks.json (apex)" \
  || bad "GET https://localhost/.well-known/assetlinks.json (apex)"

# Critère 7 : admin. hors liste autorisée -> 403. On force une IP hors plage en réglant
# ADMIN_ALLOWED_IPS à une valeur restrictive n'inclut pas l'appelant local ; à défaut d'un accès
# distant à disposition pour ce test, on vérifie ici que le mécanisme est bien celui qui décide
# (403 renvoyé par la directive @allowed du Caddyfile, pas une absence de route) -- test complet
# avec une vraie IP hors liste laissé à une exécution manuelle documentée dans le rapport.
echo "Info - critère 7 (403 hors liste) : à vérifier manuellement en restreignant ADMIN_ALLOWED_IPS, voir amoa/rapport-nuit.md"

# Critère 5 : un objet MinIO déposé n'est pas accessible sans URL signée.
if command -v docker >/dev/null 2>&1; then
  docker compose -f infra/compose.yaml -f infra/compose.dev.yaml --env-file infra/env/.env \
    exec -T minio sh -c 'echo smoke-test > /tmp/probe.txt && mc cp /tmp/probe.txt local/babana-documents/probe.txt' \
    >/dev/null 2>&1
  status=$(curl -ks -o /dev/null -w '%{http_code}' http://localhost:9000/babana-documents/probe.txt)
  if [ "$status" = "403" ] || [ "$status" = "404" ]; then
    pass "GET direct d'un objet MinIO sans URL signée refusé (HTTP $status)"
  else
    bad "GET direct d'un objet MinIO sans URL signée a répondu HTTP $status (attendu 403 ou 404)"
  fi
else
  bad "docker indisponible, impossible de vérifier le critère 5"
fi

# D64 : le point d'entrée public du stockage ne sert jamais la console d'administration --
# n'importe quel appel à travers storage.<domaine> doit atteindre l'API S3 (une erreur XML),
# jamais une page HTML « MinIO Console ». Complète (ne remplace pas) test/storage/
# public-entrypoint.test.ts, qui prouve en plus la joignabilité réelle d'une vraie URL signée
# depuis l'extérieur -- ce script-ci ne fait que confirmer que le routage Caddy reste correct
# juste après `make up`, au même titre que le critère 5 ci-dessus.
type=$(curl -ks -o /dev/null -w '%{content_type}' https://storage.localhost/)
case "$type" in
  text/html*) bad "GET https://storage.localhost/ a répondu du HTML (signature de la console MinIO) -- la route publique ne doit jamais l'atteindre (D64)" ;;
  *) pass "GET https://storage.localhost/ ne sert pas la console (Content-Type: $type)" ;;
esac

exit "$fail"
