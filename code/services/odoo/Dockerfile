FROM odoo:18

USER root

# Dépendances Python du module babana (L0-01) :
# - PyJWT[crypto] : vérification de signature des jetons d'identité Google, contre une URL de
#   jeu de clés configurable (GOOGLE_JWKS_URL) — mock-google-identity en développement (D19,
#   L0-08), Google en production. Choix retenu plutôt que la bibliothèque officielle
#   google-auth, dont l'API haut niveau ne permet pas de pointer vers une URL JWKS de test —
#   ce qui aurait exigé une branche conditionnelle, interdite par le principe directeur de D19.
#   L'extra [crypto] installe `cryptography`, dont babana_token.py importe directement AESGCM
#   depuis L1-02R (D37, 23 août) : pas de dépendance nouvelle, seulement un usage direct d'une
#   bibliothèque déjà tirée transitivement -- à signaler si elle cessait de l'être.
# - boto3 : client S3, compatible MinIO (L1-05).
# - requests : client HTTP sortant vers le service temps réel (REALTIME_INTERNAL_URL).
# --break-system-packages : la base Debian de l'image odoo:18 applique PEP 668
# (environnement "externally managed"). Sans issue plus propre dans un conteneur dédié à
# l'exécution d'Odoo seul (pas de venv Odoo officiel dans cette image) -- risque de conflit de
# paquets système écarté puisque rien d'autre n'y installe de paquets Python.
RUN pip install --no-cache-dir --break-system-packages \
    "PyJWT[crypto]>=2.8,<3" \
    "boto3>=1.34,<2" \
    "requests>=2.31,<3"

USER odoo
