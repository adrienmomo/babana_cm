#!/bin/sh
# Recherche automatisée de secrets dans les fichiers suivis par git (L0-01, critère
# d'acceptation 4 ; invariant 5 : "aucun secret dans le dépôt, jamais"). Pas de dépendance
# nouvelle : grep suffit pour ce que ce dépôt a besoin de détecter ce soir.
#
# Usage : tools/secret-scan/scan.sh   (depuis n'importe quel répertoire du dépôt)
set -eu

cd "$(git rev-parse --show-toplevel)"

fail=0

# 1. Aucun fichier .env (le vrai, pas .env.example) ne doit jamais être suivi par git.
if git ls-files | grep -Eq '(^|/)\.env$'; then
  echo "ÉCHEC : un fichier .env est suivi par git :"
  git ls-files | grep -E '(^|/)\.env$'
  fail=1
fi

# 2. Blocs de clé privée (RSA, EC, OpenSSH, PGP, générique PKCS#8).
if git ls-files -z | xargs -0 grep -lE -- '-----BEGIN (RSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----' 2>/dev/null; then
  echo "ÉCHEC : bloc de clé privée trouvé dans les fichiers ci-dessus."
  fail=1
fi

# 3. Identifiants de clé d'accès AWS (utilisés par le format S3/MinIO en production).
if git ls-files -z | xargs -0 grep -lE -- 'AKIA[0-9A-Z]{16}' 2>/dev/null; then
  echo "ÉCHEC : identifiant de clé d'accès AWS trouvé dans les fichiers ci-dessus."
  fail=1
fi

# 4. Valeur à forte entropie assignée à une variable *_SECRET/*_PASSWORD/*_TOKEN/*_KEY,
# à l'exclusion des marqueurs de substitution volontairement factices utilisés dans ce dépôt
# (voir infra/env/.env.example) et des schémas de contrat qui nomment ces champs sans leur
# donner de valeur.
if git ls-files -z \
  | xargs -0 grep -nEi -- '(SECRET|PASSWORD|TOKEN|_KEY)[A-Z_]*[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9+/=_-]{20,}' 2>/dev/null \
  | grep -v -- 'dev-only-not-a-real-secret' \
  | grep -v -- 'dev-client-id.apps.googleusercontent.com' \
  | grep -v -- '\.env\.example:' \
  | grep -v -- '\.ts:' \
  | grep -v -- '\.md:'; then
  echo "ÉCHEC : valeur à forte entropie trouvée sur les lignes ci-dessus — vérifier qu'il ne s'agit pas d'un vrai secret."
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "OK — aucun secret détecté dans les fichiers suivis par git."
fi

exit "$fail"
