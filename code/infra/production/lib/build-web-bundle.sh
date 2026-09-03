#!/bin/sh
# Construction du bundle web du Client, isolée de deploy.sh pour rester testable sans docker ni
# dépôt git réel (L0-10, D59 -- amoa/01-architecture.md §9 sexies).
#
# Défaut du 13 septembre que ce fichier ferme : `deploy.sh` faisait `. infra/env/.env` (sans
# `set -a`), ce qui pose des variables de SHELL mais ne les transmet à AUCUN processus fils sans
# `export` explicite -- `npm run build:web -w @babana/client` tournait donc avec
# BABANA_MAPS_SEARCH_URL/BABANA_GOOGLE_WEB_CLIENT_ID/BABANA_GOOGLE_MAPS_API_KEY absentes de son
# environnement, quelle que soit leur valeur dans infra/env/.env. Preuve dans le dépôt (avant
# correction) : apps/client/dist-web/bundle.js contenait littéralement
# `MAPS_SEARCH_URL = false||undefined`.
#
# Double garde-fou, pas un seul :
#   1. `export` ci-dessous rend explicite ce que ce build a besoin de recevoir -- sert aussi
#      d'ancrage pour tools/config-coherence/scan.ts (scanDeliveredByShellExport), qui vérifie
#      mécaniquement que ces trois variables sont bien "livrées" quelque part.
#   2. Après le build, on grep le FICHIER PRODUIT (pas les variables d'environnement) pour
#      chacune des trois valeurs -- c'est le contrôle que le critère d'acceptation 6 de L0-10
#      exige : la preuve porte sur ce qui est réellement embarqué, pas sur ce qu'on a essayé de
#      transmettre. `deploy.sh` valide déjà, avant d'appeler cette fonction, que ces valeurs ne
#      sont ni vides ni un simulateur (D43).
#
# Usage : build_web_bundle <racine "code/"> [commande npm]
# Testé par test/config/build-web-bundle.test.sh, qui reproduit le défaut du 13 septembre (une
# variable posée mais non exportée) et vérifie qu'il est bien détecté, puis vérifie qu'une
# variable exportée passe.
set -eu

_BUILD_WEB_BUNDLE_VARS="BABANA_MAPS_SEARCH_URL BABANA_GOOGLE_WEB_CLIENT_ID BABANA_GOOGLE_MAPS_API_KEY"

build_web_bundle() {
  root_dir="$1"
  npm_bin="${2:-npm}"
  bundle_file="$root_dir/apps/client/dist-web/bundle.js"

  for name in $_BUILD_WEB_BUNDLE_VARS; do
    eval "value=\${$name:-}"
    if [ -z "$value" ]; then
      printf "ÉCHEC : %s absente ou vide au moment du build.\n" "$name" >&2
      return 1
    fi
  done

  # Le défaut du 13 septembre, exactement ici : poser une variable de SHELL (`. infra/env/.env`
  # sans `set -a`) ne la transmet à AUCUN processus fils tant qu'elle n'est pas explicitement
  # exportée. `export` ci-dessous est donc la ligne qui ferme L0-10, pas un détail de style --
  # c'est aussi l'ancrage que tools/config-coherence/scan.ts (scanDeliveredByShellExport)
  # reconnaît pour vérifier mécaniquement que ces trois variables sont "livrées" quelque part.
  export BABANA_MAPS_SEARCH_URL BABANA_GOOGLE_WEB_CLIENT_ID BABANA_GOOGLE_MAPS_API_KEY

  rm -f "$bundle_file"
  ( cd "$root_dir" && "$npm_bin" run build:web -w @babana/client ) || {
    printf "ÉCHEC : npm run build:web -w @babana/client a échoué.\n" >&2
    return 1
  }

  [ -f "$bundle_file" ] || {
    printf "ÉCHEC : le bundle attendu (%s) n'a pas été produit.\n" "$bundle_file" >&2
    return 1
  }

  for name in $_BUILD_WEB_BUNDLE_VARS; do
    eval "value=\${$name}"
    grep -qF -- "$value" "$bundle_file" || {
      printf "ÉCHEC : %s (=%s) absente du bundle produit (%s) -- livrée au build mais pas embarquée dans le fichier de sortie (L0-10, critère d'acceptation 6).\n" "$name" "$value" "$bundle_file" >&2
      return 1
    }
  done
}
