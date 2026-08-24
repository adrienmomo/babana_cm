# Bouton d'urgence (L8-04, C-01 incident.ts). Traduit HTTP en création d'un babana.incident,
# rien de plus (invariant 3) -- aucune décision métier ici, TOGETHER_STATES et la notification
# du contact d'urgence vivent dans le modèle (babana_incident.py).
from __future__ import annotations

import logging
from datetime import datetime, timezone

from odoo import http
from odoo.http import request
from odoo.service.model import PG_CONCURRENCY_EXCEPTIONS_TO_RETRY

from . import _common
from ..models.babana_ride import TOGETHER_STATES

_logger = logging.getLogger(__name__)

# readonly=False explicite : auth='none' est en lecture seule par défaut depuis Odoo 18
# (code/docs/odoo-pitfalls.md) -- cet endpoint écrit (création d'un babana.incident).
_ROUTE = {"type": "http", "auth": "none", "methods": ["POST"], "csrf": False, "readonly": False}


class IncidentController(http.Controller):
    def _dispatch(self, endpoint: str, handler):
        try:
            payload, status = _common.run_idempotent(endpoint, handler)
            return _common.json_response(payload, status)
        except _common.AuthenticationFailed as exc:
            return _common.error_response(exc.code, "authentification requise", exc.status)
        except PG_CONCURRENCY_EXCEPTIONS_TO_RETRY:
            raise
        except Exception:
            _logger.exception("erreur interne dans %s", endpoint)
            return _common.error_response("INTERNAL_ERROR", "erreur interne", 500)

    # --- POST /rides/{id}/incidents (triggerIncident, L8-04) -----------------------------------

    @http.route("/api/v1/rides/<string:ride_id>/incidents", **_ROUTE)
    def trigger_incident(self, ride_id, **_kwargs):
        return self._dispatch("triggerIncident", lambda: self._trigger_incident(ride_id))

    def _trigger_incident(self, ride_id):
        env, user = _common.authenticated_user()
        ride = env["babana.ride"].sudo().search([("public_id", "=", ride_id)], limit=1)
        if not ride:
            return _common.error_payload("RIDE_NOT_FOUND", "course inconnue"), 404

        driver = user._babana_driver()
        if ride.client_id == user.partner_id:
            trigger_actor = "client"
        elif driver and ride.driver_id == driver:
            trigger_actor = "driver"
        else:
            return _common.error_payload(
                "RIDE_NOT_OWNED", "cette course n'appartient pas à l'appelant"
            ), 403

        # "Pendant une course" (spécification) -- ni avant l'affectation (personne n'est encore
        # réuni), ni après un état terminal (ce n'est plus "pendant"). Voir TOGETHER_STATES.
        if ride.state not in TOGETHER_STATES:
            return _common.error_payload(
                "RIDE_NOT_ACTIVE", "cette course n'est pas actuellement en cours"
            ), 409

        body = _common.parse_json_body() or {}
        latitude = body.get("latitude")
        longitude = body.get("longitude")
        triggered_at = body.get("triggeredAt")
        if not isinstance(latitude, (int, float)) or not isinstance(longitude, (int, float)):
            return _common.error_payload(
                "VALIDATION_ERROR", "latitude et longitude sont requises"
            ), 400
        if not triggered_at:
            return _common.error_payload("VALIDATION_ERROR", "triggeredAt est requis"), 400
        try:
            # D40 : le contrat envoie un ISO suffixé (offset obligatoire, IsoDateTimeSchema) ;
            # Odoo stocke un datetime naïf, toujours en UTC par convention interne -- convertir
            # puis retirer le fuseau, jamais l'ignorer (un client dans un fuseau différent
            # d'UTC enverrait sinon une heure fausse). Premier point d'entrée de ce dépôt où une
            # date ISO arrive du client plutôt que d'en sortir (iso_datetime fait l'inverse).
            triggered_at_dt = datetime.fromisoformat(triggered_at.replace("Z", "+00:00"))
            if triggered_at_dt.tzinfo is not None:
                triggered_at_dt = triggered_at_dt.astimezone(timezone.utc)
            triggered_at_naive = triggered_at_dt.replace(tzinfo=None)
        except ValueError:
            return _common.error_payload(
                "VALIDATION_ERROR", "triggeredAt doit être une date ISO 8601 valide"
            ), 400

        incident = env["babana.incident"].sudo().create(
            {
                "ride_id": ride.id,
                "trigger_actor": trigger_actor,
                "trigger_user_id": user.id,
                "latitude": latitude,
                "longitude": longitude,
                "triggered_at": triggered_at_naive,
            }
        )

        return (
            {
                "id": incident.public_id,
                "status": incident.status,
                "position": {"latitude": incident.latitude, "longitude": incident.longitude},
                "triggeredAt": _common.iso_datetime(incident.triggered_at),
            },
            201,
        )
