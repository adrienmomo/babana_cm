# Utilitaires partagés entre les contrôleurs authentifiés (L1-05, L4-03) -- tout endpoint du
# catalogue C-01 hors /auth/*, qui s'authentifient par le corps de la requête (voir auth.py),
# porte l'en-tête Authorization: Bearer <accessToken> (docs/contracts/http-api.md).
from __future__ import annotations

import json

from odoo import SUPERUSER_ID
from odoo.http import request

from ..services.access_token import ExpiredAccessToken, InvalidAccessToken, verify_access_token


class AuthenticationFailed(Exception):
    """Levée par authenticated_user() -- code du catalogue C-01 (UNAUTHORIZED ou TOKEN_EXPIRED)
    et statut HTTP déjà résolus, prêts pour _error_response()."""

    def __init__(self, code: str, status: int = 401):
        super().__init__(code)
        self.code = code
        self.status = status


def authenticated_user():
    """Vérifie l'en-tête Authorization: Bearer <accessToken> et retrouve le res.users
    correspondant, élevé sur SUPERUSER_ID comme les routes /auth/* (env.user vide sous
    uid=None casse des hooks internes -- code/docs/odoo-pitfalls.md). Lève
    AuthenticationFailed sinon ; ne renvoie jamais (env, user) partiellement valide."""
    header = request.httprequest.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise AuthenticationFailed("UNAUTHORIZED")
    token = header[len("Bearer "):].strip()
    if not token:
        raise AuthenticationFailed("UNAUTHORIZED")

    try:
        claims = verify_access_token(token)
    except ExpiredAccessToken as exc:
        raise AuthenticationFailed("TOKEN_EXPIRED") from exc
    except InvalidAccessToken as exc:
        raise AuthenticationFailed("UNAUTHORIZED") from exc

    env = request.env(user=SUPERUSER_ID)
    # "sub", pas "uid" (D23, AccessTokenClaimsSchema) -- claims.get("uid") a longtemps subsisté
    # ici alors que controllers/auth.py émettait déjà "sub" : c'est exactement le lecteur oublié
    # qui aurait reproduit le défaut réparé cette nuit (amoa/questions/REPONSES-2026-08-15.md
    # §1), avant même que le jeton n'atteigne le service temps réel.
    user = env["res.users"].sudo().search(
        [("babana_public_id", "=", claims.get("sub"))], limit=1
    )
    if not user:
        # Signature valide mais sub inconnu : compte supprimé après émission du jeton. Même
        # code que tout autre défaut d'authentification -- ne pas distinguer, même raison
        # qu'InvalidAccessToken (services/access_token.py).
        raise AuthenticationFailed("UNAUTHORIZED")
    return env, user


def json_response(payload, status=200):
    return request.make_response(
        json.dumps(payload),
        status=status,
        headers=[("Content-Type", "application/json")],
    )


def error_response(code, message, status):
    return json_response({"error": {"code": code, "message": message, "details": None}}, status)


def error_payload(code, message):
    return {"error": {"code": code, "message": message, "details": None}}


def parse_json_body():
    try:
        body = json.loads(request.httprequest.get_data(as_text=True) or "{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return body if isinstance(body, dict) else None


def idempotency_key():
    return request.httprequest.headers.get("Idempotency-Key") or None


def lookup_idempotent_response(key: str, endpoint: str):
    """(payload, status) déjà renvoyés pour cette clé sur cet endpoint, ou None (L4-03, critère
    6). Seules les transitions réellement APPLIQUÉES sont mises en cache (voir
    store_idempotent_response) : un échec métier (DRIVER_ALREADY_TAKEN, état invalide...) n'a
    jamais appliqué de transition, le rejouer est sans risque et parfois nécessaire -- les
    conditions qui ont fait échouer le premier appel peuvent avoir changé entre-temps."""
    record = request.env["babana.idempotency.record"].sudo().search(
        [("idempotency_key", "=", key), ("endpoint", "=", endpoint)], limit=1
    )
    if not record:
        return None
    return json.loads(record.response_body), record.response_status


def store_idempotent_response(key: str, endpoint: str, payload, status: int) -> None:
    request.env["babana.idempotency.record"].sudo().create(
        {
            "idempotency_key": key,
            "endpoint": endpoint,
            "response_status": status,
            "response_body": json.dumps(payload),
        }
    )
