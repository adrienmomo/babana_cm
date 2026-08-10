# Contrôleur d'authentification Google (L1-01, D4). Seul endpoint public du contrat C-01 --
# aucun autre n'expose auth='none'.
from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
import time
import uuid

import jwt
from odoo import SUPERUSER_ID, http
from odoo.http import request

from ..services.google_identity import InvalidGoogleToken, verify_google_id_token

_logger = logging.getLogger(__name__)

ACCESS_TOKEN_TTL_SECONDS = 3600


def _json_response(payload, status=200):
    return request.make_response(
        json.dumps(payload),
        status=status,
        headers=[("Content-Type", "application/json")],
    )


def _error_response(code, message, status):
    return _json_response({"error": {"code": code, "message": message, "details": None}}, status)


class AuthController(http.Controller):
    # readonly=False explicite : les routes auth='none' sont readonly par défaut depuis Odoo 18
    # (support des répliques de lecture), et cet endpoint crée un utilisateur au premier appel.
    # Sans ce paramètre, la création échoue silencieusement avec ReadOnlySqlTransaction --
    # trouvé en implémentant L1-01.
    @http.route(
        "/api/v1/auth/google",
        type="http",
        auth="none",
        methods=["POST"],
        csrf=False,
        readonly=False,
    )
    def google_auth(self, **_kwargs):
        try:
            return self._google_auth()
        except Exception:
            _logger.exception("erreur interne dans POST /api/v1/auth/google")
            return _error_response("INTERNAL_ERROR", "erreur interne", 500)

    def _google_auth(self):
        try:
            body = json.loads(request.httprequest.get_data(as_text=True) or "{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            return _error_response("VALIDATION_ERROR", "corps JSON invalide", 400)

        if not isinstance(body, dict):
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

        # auth='none' lie la requête à uid=None (ir_http._auth_method_none) : env.user y est un
        # recordset vide, ce que plusieurs hooks internes d'Odoo (hr, mail) n'acceptent pas dans
        # leurs propres surcharges de create()/write(). .sudo() seul ne change pas env.uid --
        # nécessaire de rebasculer sur un utilisateur réel avant toute écriture.
        env = request.env(user=SUPERUSER_ID)
        user = env["res.users"]._babana_find_or_create_from_google(
            sub=claims["sub"],
            email=claims.get("email"),
            name=claims.get("name"),
            role=role,
        )

        session = _issue_session(user, picture=claims.get("picture"))
        return _json_response(session, 200)


def _issue_session(user, *, picture=None):
    """Émet une session minimale (L1-01). L1-02, qui suit dans ce lot, remplace ce mécanisme
    par babana.token : rotation à chaque renouvellement, révocation de famille sur réutilisation
    d'un jeton déjà consommé. Ici, un seul jeton de renouvellement actif, stocké haché sur
    res.users (champ-pont, amoa/questions/L1-01.md).
    """
    jwt_secret = os.environ["JWT_SECRET"]
    now = int(time.time())
    access_claims = {
        "uid": user.babana_public_id,
        "role": user.babana_role,
        "iat": now,
        "exp": now + ACCESS_TOKEN_TTL_SECONDS,
        "jti": uuid.uuid4().hex,
    }
    access_token = jwt.encode(access_claims, jwt_secret, algorithm="HS256")

    refresh_token = secrets.token_urlsafe(32)
    user.sudo().write(
        {"babana_refresh_token_hash": hashlib.sha256(refresh_token.encode()).hexdigest()}
    )

    user_payload = {
        "id": user.babana_public_id,
        "role": user.babana_role,
        "displayName": user.name,
        "photoUrl": picture,
        # Champ-pont : toujours faux tant que L1-04 (res.partner) et L1-09 (OTP) n'existent pas.
        "phoneVerified": False,
    }
    if user.babana_role == "driver":
        user_payload["driverStatus"] = user.babana_driver_state

    return {
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "expiresIn": ACCESS_TOKEN_TTL_SECONDS,
        "user": user_payload,
    }
