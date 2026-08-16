# Déclaration de remise par le chauffeur (L5-04, C-01 remittance.ts). La validation par un
# superviseur est un flux back-office Odoo natif, hors de ce contrat mobile (remittance.ts,
# commentaire de tête) -- pas de route ici pour action_validate.
from __future__ import annotations

import logging

from odoo import http

from . import _common

_logger = logging.getLogger(__name__)

# readonly=False explicite : auth='none' est en lecture seule par défaut depuis Odoo 18
# (code/docs/odoo-pitfalls.md) -- cet endpoint écrit (crée une remise).
_ROUTE = {"type": "http", "auth": "none", "methods": ["POST"], "csrf": False, "readonly": False}

# CreateRemittanceResponseSchema (C-01) : trois valeurs publiques, pas les quatre internes de
# babana.cash.remittance.state -- 'draft' et 'declared' sont tous deux "en attente" du point de
# vue du chauffeur, 'disputed' s'expose comme 'rejected' (aucune des deux n'est un montant que le
# chauffeur peut réutiliser).
_PUBLIC_STATUS = {
    "draft": "pending",
    "declared": "pending",
    "validated": "validated",
    "disputed": "rejected",
}


class RemittanceController(http.Controller):
    @http.route("/api/v1/remittances", **_ROUTE)
    def create_remittance(self, **_kwargs):
        return self._dispatch("createRemittance", self._create_remittance)

    def _dispatch(self, endpoint: str, handler):
        # Même patron que RideController._dispatch (controllers/ride.py) : le réseau mobile est
        # intermittent (CLAUDE.md), une déclaration de remise doit pouvoir se rejouer sans en
        # créer une seconde (L5-07, critère 5 -- Idempotency-Key, C-01).
        try:
            key = _common.idempotency_key()
            if key:
                cached = _common.lookup_idempotent_response(key, endpoint)
                if cached is not None:
                    payload, status = cached
                    return _common.json_response(payload, status)

            payload, status = handler()

            if key and 200 <= status < 300:
                _common.store_idempotent_response(key, endpoint, payload, status)
            return _common.json_response(payload, status)
        except _common.AuthenticationFailed as exc:
            return _common.error_response(exc.code, "authentification requise", exc.status)
        except Exception:
            _logger.exception("erreur interne dans %s", endpoint)
            return _common.error_response("INTERNAL_ERROR", "erreur interne", 500)

    def _create_remittance(self):
        env, user = _common.authenticated_user()
        body = _common.parse_json_body() or {}
        amount = body.get("amount")
        if not isinstance(amount, (int, float)) or isinstance(amount, bool) or amount <= 0:
            return _common.error_payload("VALIDATION_ERROR", "amount (positif) est requis"), 400

        driver = user._babana_driver()
        if not driver:
            return _common.error_payload("UNAUTHORIZED", "compte non rattaché à un chauffeur"), 401
        if driver.state != "approved":
            return _common.error_payload(
                "DRIVER_NOT_APPROVED", "le dossier chauffeur n'est pas approuvé"
            ), 403

        remittance = env["babana.cash.remittance"].sudo().action_declare(
            driver=driver, declared_amount=amount
        )
        driver.invalidate_recordset(["cash_balance"])
        return (
            {
                "id": remittance.public_id,
                "amount": round(remittance.declared_amount),
                "status": _PUBLIC_STATUS[remittance.state],
                "driverCashBalance": round(driver.cash_balance),
            },
            201,
        )
