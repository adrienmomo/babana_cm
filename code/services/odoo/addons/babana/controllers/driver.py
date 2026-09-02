# Bascule en ligne / hors ligne (L3-04, D7, C-01 driver.ts) et lecture du compte courant (C-01
# settlement.ts, GET /drivers/me/cash -- trou du découpage L5, comblé le 20 août,
# amoa/questions/REPONSES-2026-08-20.md §4). Odoo est la source de vérité de l'éligibilité
# (dossier approuvé, moto affectée, assurance valide, permis valide, plafond d'encaisse non
# atteint) -- ce contrôleur ne fait qu'appliquer les motifs de refus distincts renvoyés par
# babana_driver.py (invariant 3 : aucune règle métier ici, seulement leur traduction en réponse
# HTTP). Le service temps réel reçoit l'autorisation et applique l'insertion/le retrait dans le
# géo-index -- il ne décide de rien (L3-04, spécification).
from __future__ import annotations

import logging

from odoo import http

from . import _common

_logger = logging.getLogger(__name__)

# readonly=False explicite : auth='none' est en lecture seule par défaut depuis Odoo 18
# (code/docs/odoo-pitfalls.md) -- cet endpoint écrit (is_online).
_POST_ROUTE = {"type": "http", "auth": "none", "methods": ["POST"], "csrf": False, "readonly": False}

# GET /drivers/me/cash ne modifie rien -- readonly par défaut convient, pas d'override.
_GET_ROUTE = {"type": "http", "auth": "none", "methods": ["GET"], "csrf": False}


class DriverController(http.Controller):
    @http.route("/api/v1/drivers/me/cash", **_GET_ROUTE)
    def get_cash(self, **_kwargs):
        try:
            payload, status = self._get_cash()
            return _common.json_response(payload, status)
        except _common.AuthenticationFailed as exc:
            return _common.error_response(exc.code, "authentification requise", exc.status)
        except Exception:
            _logger.exception("erreur interne dans GET /api/v1/drivers/me/cash")
            return _common.error_response("INTERNAL_ERROR", "erreur interne", 500)

    def _get_cash(self):
        _env, user = _common.authenticated_user()
        driver = user._babana_driver()
        if not driver:
            return _common.error_payload("UNAUTHORIZED", "compte non rattaché à un chauffeur"), 401
        # D55 (amoa/questions/REPONSES-2026-09-08.md §3) : un chauffeur SUSPENDU garde la
        # lecture de son compte courant -- il doit de l'argent, lui retirer tout moyen de
        # savoir combien l'empêche de régulariser (le raisonnement de D29 retourné contre
        # nous). La suspension agit sur la disponibilité, jamais sur cette lecture. Un dossier
        # `pending`/`rejected` n'a jamais encaissé : DRIVER_NOT_APPROVED reste pour eux.
        if driver.state not in ("approved", "suspended"):
            return _common.error_payload(
                "DRIVER_NOT_APPROVED", "le dossier chauffeur n'est pas approuvé"
            ), 403

        driver = driver.sudo()
        return (
            {
                "balance": round(driver.cash_balance),
                "limit": round(driver.cash_limit),
                "collectedToday": round(driver._babana_cash_collected_today()),
            },
            200,
        )

    @http.route("/api/v1/drivers/me/availability", **_POST_ROUTE)
    def set_availability(self, **_kwargs):
        try:
            payload, status = self._set_availability()
            return _common.json_response(payload, status)
        except _common.AuthenticationFailed as exc:
            return _common.error_response(exc.code, "authentification requise", exc.status)
        except Exception:
            _logger.exception("erreur interne dans POST /api/v1/drivers/me/availability")
            return _common.error_response("INTERNAL_ERROR", "erreur interne", 500)

    def _set_availability(self):
        env, user = _common.authenticated_user()
        body = _common.parse_json_body() or {}
        online = body.get("online")
        if not isinstance(online, bool):
            return _common.error_payload("VALIDATION_ERROR", "online (booléen) est requis"), 400

        driver = user._babana_driver()
        if not driver:
            # Un jeton porte role='driver' uniquement si babana.driver existe (L1-03R,
            # controllers/auth.py:_issue_access_token) -- ne devrait jamais se produire, même
            # traitement que tout autre défaut d'authentification (voir _common.py).
            return _common.error_payload("UNAUTHORIZED", "compte non rattaché à un chauffeur"), 401

        if online:
            refusal = driver.sudo()._check_online_eligibility()
            if refusal:
                code, message = refusal
                return _common.error_payload(code, message), 403
            driver.sudo().write({"is_online": True})
            return {"online": True}, 200

        refusal = driver.sudo()._check_offline_allowed()
        if refusal:
            code, message = refusal
            return _common.error_payload(code, message), 409
        driver.sudo().write({"is_online": False})
        return {"online": False}, 200
