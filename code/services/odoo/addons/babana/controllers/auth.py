# Contrôleur d'authentification (L1-01, L1-02, D4). Trois routes publiques du contrat C-01 :
# elles s'authentifient par le jeton transmis dans le corps, jamais par l'en-tête Authorization
# (amoa/questions/L1-02.md -- /auth/refresh existe précisément pour le cas où l'accessToken en
# en-tête serait expiré).
from __future__ import annotations

import json
import logging
import os
import time
import uuid

import jwt
from odoo import SUPERUSER_ID, http
from odoo.http import request

from ..models.babana_token import TokenExpired, TokenNotFound, TokenReused
from ..services.google_identity import InvalidGoogleToken, verify_google_id_token

_logger = logging.getLogger(__name__)

ACCESS_TOKEN_TTL_SECONDS = 3600

# readonly=False explicite sur les trois routes : auth='none' est readonly par défaut depuis
# Odoo 18 (support des répliques de lecture), et les trois écrivent (création d'utilisateur,
# rotation ou révocation de jeton). Sans ce paramètre, l'écriture échoue silencieusement avec
# ReadOnlySqlTransaction -- trouvé en implémentant L1-01.
_PUBLIC_AUTH_ROUTE = {
    "type": "http",
    "auth": "none",
    "methods": ["POST"],
    "csrf": False,
    "readonly": False,
}


def _json_response(payload, status=200):
    return request.make_response(
        json.dumps(payload),
        status=status,
        headers=[("Content-Type", "application/json")],
    )


def _error_response(code, message, status):
    return _json_response({"error": {"code": code, "message": message, "details": None}}, status)


def _superuser_env():
    # auth='none' lie la requête à uid=None (ir_http._auth_method_none) : env.user y est un
    # recordset vide, ce que plusieurs hooks internes d'Odoo (hr, mail) n'acceptent pas dans
    # leurs propres surcharges de create()/write(). .sudo() seul ne change pas env.uid --
    # nécessaire de rebasculer sur un utilisateur réel avant toute écriture.
    return request.env(user=SUPERUSER_ID)


class AuthController(http.Controller):
    @http.route("/api/v1/auth/google", **_PUBLIC_AUTH_ROUTE)
    def google_auth(self, **_kwargs):
        try:
            return self._google_auth()
        except Exception:
            _logger.exception("erreur interne dans POST /api/v1/auth/google")
            return _error_response("INTERNAL_ERROR", "erreur interne", 500)

    def _google_auth(self):
        body = _parse_json_body()
        if body is None:
            return _error_response("VALIDATION_ERROR", "corps JSON invalide", 400)

        id_token = body.get("idToken")
        role = body.get("role")
        if not isinstance(id_token, str) or not id_token:
            return _error_response("VALIDATION_ERROR", "idToken manquant ou vide", 400)
        if role not in ("client", "driver"):
            return _error_response(
                "VALIDATION_ERROR", "role doit valoir 'client' ou 'driver'", 400
            )

        try:
            claims = verify_google_id_token(id_token)
        except InvalidGoogleToken as exc:
            _logger.info("jeton Google rejeté : %s", exc)
            return _error_response("INVALID_GOOGLE_TOKEN", "jeton Google invalide", 401)

        env = _superuser_env()
        user = env["res.users"]._babana_find_or_create_from_google(
            sub=claims["sub"],
            email=claims.get("email"),
            name=claims.get("name"),
            role=role,
        )

        refresh_token = env["babana.token"]._issue_family(user)
        session = _build_session(user, refresh_token, picture=claims.get("picture"))
        return _json_response(session, 200)

    @http.route("/api/v1/auth/refresh", **_PUBLIC_AUTH_ROUTE)
    def refresh(self, **_kwargs):
        try:
            return self._refresh()
        except Exception:
            _logger.exception("erreur interne dans POST /api/v1/auth/refresh")
            return _error_response("INTERNAL_ERROR", "erreur interne", 500)

    def _refresh(self):
        body = _parse_json_body()
        if body is None:
            return _error_response("VALIDATION_ERROR", "corps JSON invalide", 400)

        refresh_token = body.get("refreshToken")
        if not isinstance(refresh_token, str) or not refresh_token:
            return _error_response("VALIDATION_ERROR", "refreshToken manquant ou vide", 400)

        env = _superuser_env()
        try:
            user, new_refresh_token = env["babana.token"]._rotate(refresh_token)
        except TokenNotFound:
            return _error_response("UNAUTHORIZED", "jeton de renouvellement inconnu", 401)
        except TokenReused:
            _logger.warning("jeton de renouvellement réutilisé -- famille révoquée")
            return _error_response("TOKEN_REVOKED", "jeton de renouvellement révoqué", 401)
        except TokenExpired:
            return _error_response("TOKEN_EXPIRED", "jeton de renouvellement expiré", 401)

        session = _build_session(user, new_refresh_token)
        return _json_response(session, 200)

    @http.route("/api/v1/auth/logout", **_PUBLIC_AUTH_ROUTE)
    def logout(self, **_kwargs):
        try:
            return self._logout()
        except Exception:
            _logger.exception("erreur interne dans POST /api/v1/auth/logout")
            return _error_response("INTERNAL_ERROR", "erreur interne", 500)

    def _logout(self):
        body = _parse_json_body()
        if body is None:
            return _error_response("VALIDATION_ERROR", "corps JSON invalide", 400)

        refresh_token = body.get("refreshToken")
        if not isinstance(refresh_token, str) or not refresh_token:
            return _error_response("VALIDATION_ERROR", "refreshToken manquant ou vide", 400)

        _superuser_env()["babana.token"]._revoke(refresh_token)
        return _json_response({"revoked": True}, 200)


def _parse_json_body():
    try:
        body = json.loads(request.httprequest.get_data(as_text=True) or "{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return body if isinstance(body, dict) else None


def _issue_access_token(user) -> tuple[str, int]:
    jwt_secret = os.environ["JWT_SECRET"]
    now = int(time.time())
    claims = {
        "uid": user.babana_public_id,
        "role": user.babana_role,
        "iat": now,
        "exp": now + ACCESS_TOKEN_TTL_SECONDS,
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(claims, jwt_secret, algorithm="HS256"), ACCESS_TOKEN_TTL_SECONDS


def _build_session(user, refresh_token: str, *, picture=None) -> dict:
    access_token, expires_in = _issue_access_token(user)

    user_payload = {
        "id": user.babana_public_id,
        "role": user.babana_role,
        "displayName": user.name,
        "photoUrl": picture,
        "phoneVerified": False,
    }
    if user.babana_role == "client":
        # L1-04 : le vrai champ existe côté partenaire. Toujours faux tant que L1-09 (OTP,
        # hors de ce lot) ne l'écrit jamais -- mais ce n'est plus un champ-pont, c'est la valeur
        # réelle d'un champ qui n'a simplement jamais été mis à vrai.
        user_payload["phoneVerified"] = user.partner_id.babana_phone_verified
    if user.babana_role == "driver":
        user_payload["driverStatus"] = user.babana_driver_state
        # Champ-pont encore ouvert côté chauffeur : babana.driver.phone_verified (L1-03) existe,
        # mais rien ne relie aujourd'hui res.users à sa fiche babana.driver pour le lire ici sans
        # une recherche supplémentaire non justifiée tant que L1-09 ne l'alimente jamais.

    return {
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "expiresIn": expires_in,
        "user": user_payload,
    }
