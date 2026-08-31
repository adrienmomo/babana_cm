# Jetons d'appareil pour la notification push (L7-01, contrat C-01 `devices.ts`). L'app appelle
# `POST /api/v1/devices` à la connexion et à chaque rotation du jeton signalée par Firebase ;
# `POST /api/v1/devices/deactivate` à la déconnexion volontaire d'un appareil. Authentifié par
# l'en-tête Bearer comme tout endpoint métier (_common.authenticated_user) -- l'acteur se déduit
# du jeton, jamais du corps (invariant 3).
from __future__ import annotations

import logging

from odoo import http

from . import _common

_logger = logging.getLogger(__name__)

# readonly=False explicite : auth='none' est en lecture seule par défaut depuis Odoo 18
# (code/docs/odoo-pitfalls.md) -- les deux routes écrivent (création ou désactivation d'un jeton).
_WRITE_ROUTE = {"type": "http", "auth": "none", "methods": ["POST"], "csrf": False, "readonly": False}

_PLATFORMS = ("android", "ios", "web")


class DevicesController(http.Controller):
    @http.route("/api/v1/devices", **_WRITE_ROUTE)
    def register(self, **_kwargs):
        try:
            return self._handle_register()
        except _common.AuthenticationFailed as exc:
            return _common.error_response(exc.code, "authentification requise", exc.status)
        except Exception:
            _logger.exception("erreur interne dans POST /api/v1/devices")
            return _common.error_response("INTERNAL_ERROR", "erreur interne", 500)

    def _handle_register(self):
        env, user = _common.authenticated_user()
        body = _common.parse_json_body()
        if body is None:
            return _common.error_response("VALIDATION_ERROR", "corps JSON invalide", 400)

        token = body.get("token")
        platform = body.get("platform")
        if not isinstance(token, str) or not token:
            return _common.error_response("VALIDATION_ERROR", "token manquant ou vide", 400)
        if platform not in _PLATFORMS:
            return _common.error_response(
                "VALIDATION_ERROR", "platform doit valoir 'android', 'ios' ou 'web'", 400
            )

        env["babana.device.token"].sudo()._register_token(user, token, platform)
        return _common.json_response({"registered": True}, 200)

    @http.route("/api/v1/devices/deactivate", **_WRITE_ROUTE)
    def deactivate(self, **_kwargs):
        try:
            return self._handle_deactivate()
        except _common.AuthenticationFailed as exc:
            return _common.error_response(exc.code, "authentification requise", exc.status)
        except Exception:
            _logger.exception("erreur interne dans POST /api/v1/devices/deactivate")
            return _common.error_response("INTERNAL_ERROR", "erreur interne", 500)

    def _handle_deactivate(self):
        env, user = _common.authenticated_user()
        body = _common.parse_json_body()
        if body is None:
            return _common.error_response("VALIDATION_ERROR", "corps JSON invalide", 400)

        token = body.get("token")
        if not isinstance(token, str) or not token:
            return _common.error_response("VALIDATION_ERROR", "token manquant ou vide", 400)

        # Idempotent : un jeton inconnu ou déjà désactivé répond quand même `deactivated: true`.
        env["babana.device.token"].sudo()._deactivate_for_user(user, token)
        return _common.json_response({"deactivated": True}, 200)
