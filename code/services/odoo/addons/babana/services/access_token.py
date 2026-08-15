# Vérification du jeton d'accès applicatif (L1-02, C-01). Signature HS256, secret partagé
# JWT_SECRET -- le même mécanisme que le service temps réel (services/realtime/src/ws/token.ts) :
# aucun appel à Odoo n'est nécessaire pour vérifier ce jeton, ici comme là-bas.
#
# Distinct de google_identity.py (RS256, clés publiques Google) : le jeton d'accès babana est
# émis par nous (controllers/auth.py, _issue_access_token), pas par Google.
from __future__ import annotations

import os

import jwt


class InvalidAccessToken(Exception):
    """Jeton d'accès rejeté -- signature, ou expiré. À traduire par l'appelant en UNAUTHORIZED
    ou TOKEN_EXPIRED (catalogue C-01) selon le cas précis, voir ExpiredAccessToken ci-dessous."""


class ExpiredAccessToken(InvalidAccessToken):
    """Cas particulier d'InvalidAccessToken : la signature est valide, seule l'expiration a
    joué -- distingué parce que le catalogue C-01 sépare TOKEN_EXPIRED de UNAUTHORIZED."""


def verify_access_token(token: str) -> dict:
    """Décode et vérifie un jeton d'accès (L1-02). Lève ExpiredAccessToken ou
    InvalidAccessToken -- jamais la raison précise au-delà de ces deux cas, pour les mêmes
    raisons qu'InvalidGoogleToken (google_identity.py) : ne pas faciliter un tâtonnement."""
    secret = os.environ["JWT_SECRET"]
    try:
        return jwt.decode(token, secret, algorithms=["HS256"])
    except jwt.ExpiredSignatureError as exc:
        raise ExpiredAccessToken() from exc
    except jwt.InvalidTokenError as exc:
        raise InvalidAccessToken() from exc
