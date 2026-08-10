#!/bin/sh
# Crée le compartiment babana-documents au premier démarrage, en accès privé (L0-01).
# Exécuté à l'intérieur du conteneur minio (monté en lecture seule sur /bootstrap.sh, voir
# infra/compose.yaml), invoqué par `make up` via `docker compose exec minio sh /bootstrap.sh`.
# Idempotent : "mb --ignore-existing" ne casse rien si le compartiment existe déjà.
set -eu

# L'alias "local" préconfiguré par l'image (utilisé par le healthcheck "mc ready local") n'a
# aucune identifiant : il suffit pour un ping mais pas pour créer un compartiment. On le
# reconfigure ici avec les identifiants racine, disponibles dans l'environnement du conteneur.
mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"

mc mb --ignore-existing local/babana-documents
mc anonymous set none local/babana-documents

echo "babana-documents : compartiment prêt, aucun accès anonyme (critère d'acceptation 5 de L0-01)."
