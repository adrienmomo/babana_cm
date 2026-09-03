#!/bin/sh
# L0-10 -- preuve du défaut du 13 septembre ET de sa correction (critère d'acceptation 7).
#
# `deploy.sh` faisait `. infra/env/.env` (sans `set -a`) puis `npm run build:web -w
# @babana/client` directement : les trois variables de build (BABANA_MAPS_SEARCH_URL,
# BABANA_GOOGLE_WEB_CLIENT_ID, BABANA_GOOGLE_MAPS_API_KEY) restaient des variables de SHELL,
# jamais transmises au processus npm. Ce test :
#
#   1. reproduit ce chemin EXACT (sans passer par la bibliothèque corrigée) contre un faux `npm`
#      qui se comporte comme babel-plugin-transform-inline-environment-variables (une variable
#      absente de SON environnement s'inline en `undefined`, jamais en sa vraie valeur) --
#      et vérifie que le bundle produit est bien CASSÉ, comme celui trouvé dans le dépôt le 13
#      septembre ;
#   2. appelle `build_web_bundle` (infra/production/lib/build-web-bundle.sh, ce que `deploy.sh`
#      appelle réellement depuis ce soir) avec les MÊMES variables non exportées par l'appelant,
#      et vérifie que le bundle produit est cette fois CORRECT ;
#   3. vérifie que `build_web_bundle` échoue AVANT d'appeler npm si une variable est vide.
#
# Usage : sh test/config/build-web-bundle.test.sh   (depuis code/, ou n'importe où : le script se
# repère lui-même).
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
LIB="$REPO_ROOT/infra/production/lib/build-web-bundle.sh"

fail=0
note() { printf '%s\n' "$1"; }
ko() { printf 'ÉCHEC : %s\n' "$1" >&2; fail=1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- Faux "npm run build:web -w @babana/client" ------------------------------------------------
# Écrit un bundle qui reflète fidèlement les BABANA_* présentes dans SON PROPRE environnement --
# exactement ce que fait babel-plugin-transform-inline-environment-variables (une variable
# absente au moment du build s'inline en `undefined`, jamais en sa valeur du fichier .env). Ne
# lance ni webpack ni React Native : ce n'est pas ce que ce test vérifie (le bundle web réel se
# vérifie par ailleurs, `make client-web` + revue visuelle).
FAKE_NPM="$WORK/fake-npm.sh"
cat > "$FAKE_NPM" <<'EOF'
#!/bin/sh
set -eu
out="apps/client/dist-web/bundle.js"
mkdir -p "$(dirname "$out")"
: > "$out"
for name in BABANA_MAPS_SEARCH_URL BABANA_GOOGLE_WEB_CLIENT_ID BABANA_GOOGLE_MAPS_API_KEY; do
  eval "value=\${$name:-}"
  if [ -n "$value" ]; then
    printf 'var %s = "%s";\n' "$name" "$value" >> "$out"
  else
    printf 'var %s = false||undefined;\n' "$name" >> "$out"
  fi
done
EOF
chmod +x "$FAKE_NPM"

PROD_MAPS_SEARCH_URL="https://maps.googleapis.com/maps/api/place/textsearch/json"
PROD_GOOGLE_WEB_CLIENT_ID="123456-real.apps.googleusercontent.com"
PROD_GOOGLE_MAPS_API_KEY="test-maps-key"

# --- 1. Reproduction du défaut du 13 septembre --------------------------------------------------
# Les trois variables existent en tant que variables de SHELL (comme après `. infra/env/.env`
# sans `set -a`), JAMAIS exportées -- puis on appelle le faux npm directement, sans passer par
# build_web_bundle. C'est très exactement ce que faisait `infra/production/deploy.sh` avant
# aujourd'hui.
BEFORE_DIR="$WORK/before"
mkdir -p "$BEFORE_DIR"
(
  cd "$BEFORE_DIR"
  BABANA_MAPS_SEARCH_URL="$PROD_MAPS_SEARCH_URL"
  BABANA_GOOGLE_WEB_CLIENT_ID="$PROD_GOOGLE_WEB_CLIENT_ID"
  BABANA_GOOGLE_MAPS_API_KEY="$PROD_GOOGLE_MAPS_API_KEY"
  # Volontairement PAS de `export` ici -- reproduction fidèle du bug.
  "$FAKE_NPM"
)
BEFORE_BUNDLE="$BEFORE_DIR/apps/client/dist-web/bundle.js"
if [ ! -f "$BEFORE_BUNDLE" ]; then
  ko "reproduction du défaut : le faux build n'a produit aucun bundle."
elif grep -qF "$PROD_MAPS_SEARCH_URL" "$BEFORE_BUNDLE"; then
  ko "reproduction du défaut : le bundle 'avant' contient déjà la bonne valeur -- le harnais de test ne reproduit pas le bug (une variable de shell non exportée ne devrait jamais atteindre un processus fils)."
else
  note "OK : reproduit le défaut du 13 septembre -- le bundle 'avant correction' est cassé (BABANA_MAPS_SEARCH_URL absente), exactement comme apps/client/dist-web/bundle.js ce matin-là."
fi

# --- 2. build_web_bundle corrige le même scénario -----------------------------------------------
# Mêmes variables, non exportées par l'appelant non plus -- c'est build_web_bundle lui-même qui
# doit les exporter avant d'invoquer npm (voir infra/production/lib/build-web-bundle.sh).
AFTER_DIR="$WORK/after"
mkdir -p "$AFTER_DIR"
(
  cd "$AFTER_DIR"
  . "$LIB"
  BABANA_MAPS_SEARCH_URL="$PROD_MAPS_SEARCH_URL"
  BABANA_GOOGLE_WEB_CLIENT_ID="$PROD_GOOGLE_WEB_CLIENT_ID"
  BABANA_GOOGLE_MAPS_API_KEY="$PROD_GOOGLE_MAPS_API_KEY"
  build_web_bundle "$AFTER_DIR" "$FAKE_NPM"
)
AFTER_BUNDLE="$AFTER_DIR/apps/client/dist-web/bundle.js"
if [ ! -f "$AFTER_BUNDLE" ]; then
  ko "build_web_bundle n'a produit aucun bundle."
elif ! grep -qF "$PROD_MAPS_SEARCH_URL" "$AFTER_BUNDLE" || ! grep -qF "$PROD_GOOGLE_WEB_CLIENT_ID" "$AFTER_BUNDLE" || ! grep -qF "$PROD_GOOGLE_MAPS_API_KEY" "$AFTER_BUNDLE"; then
  ko "build_web_bundle : le bundle produit n'embarque pas les trois valeurs de production -- correction du 13 septembre non effective."
  cat "$AFTER_BUNDLE" >&2
else
  note "OK : build_web_bundle corrige le défaut -- les trois valeurs sont embarquées dans le bundle produit."
fi

# --- 3. build_web_bundle refuse une variable vide, AVANT d'appeler npm --------------------------
EMPTY_DIR="$WORK/empty"
mkdir -p "$EMPTY_DIR"
NPM_CALLED_MARKER="$WORK/npm-was-called"
rm -f "$NPM_CALLED_MARKER"
TATTLE_NPM="$WORK/tattle-npm.sh"
cat > "$TATTLE_NPM" <<EOF
#!/bin/sh
: > "$NPM_CALLED_MARKER"
EOF
chmod +x "$TATTLE_NPM"
set +e
(
  cd "$EMPTY_DIR"
  . "$LIB"
  BABANA_MAPS_SEARCH_URL=""
  BABANA_GOOGLE_WEB_CLIENT_ID="$PROD_GOOGLE_WEB_CLIENT_ID"
  BABANA_GOOGLE_MAPS_API_KEY="$PROD_GOOGLE_MAPS_API_KEY"
  build_web_bundle "$EMPTY_DIR" "$TATTLE_NPM"
)
empty_status=$?
set -e
if [ "$empty_status" -eq 0 ]; then
  ko "build_web_bundle a réussi avec BABANA_MAPS_SEARCH_URL vide -- devrait échouer (critère 5)."
elif [ -f "$NPM_CALLED_MARKER" ]; then
  ko "build_web_bundle a invoqué npm alors qu'une variable de build était vide."
else
  note "OK : build_web_bundle échoue avant d'invoquer npm quand une variable de build est vide."
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
note "test/config/build-web-bundle.test.sh : tous les cas passent."
