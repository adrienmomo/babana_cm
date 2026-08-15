# Endpoints du cycle de vie de la course (L4-03, C-01 ride.ts). Traduit HTTP en appel de méthode
# de transition, rien de plus (invariant 3) -- toute condition métier vit dans
# babana_ride_state.py ; une condition écrite ici serait contournée par le back-office, qui
# appelle les méthodes de transition directement.
#
# Cinq endpoints ce soir, pas les neuf de ride.ts/settlement.ts -- voir amoa/questions/L4-03.md
# pour ce qui manque et pourquoi (createRide a besoin de babana.quote/L2-04 ; completeRide de la
# consolidation L4-04 et d'un fare_rule_snapshot que rien ne pose encore avant L2-04/L2-05 ;
# settleRide du compte courant L4-05/L5-01 ; rateRide de babana.rating/L4-09). Les cinq
# transitions qui ne dépendent que de babana.ride/babana.driver, déjà là ce soir : select-driver,
# accept, reject, start, cancel.
from __future__ import annotations

import logging
from datetime import timedelta

from odoo import http
from odoo.exceptions import UserError
from odoo.http import request

from . import _common
from ..models.babana_ride_state import RideInvalidTransition

_logger = logging.getLogger(__name__)

# readonly=False explicite : auth='none' est en lecture seule par défaut depuis Odoo 18
# (code/docs/odoo-pitfalls.md) -- les cinq endpoints ci-dessous écrivent tous.
_ROUTE = {"type": "http", "auth": "none", "methods": ["POST"], "csrf": False, "readonly": False}


def _summary(ride) -> dict:
    return {
        "id": ride.public_id,
        "state": ride.state,
        "origin": {"latitude": ride.pickup_latitude, "longitude": ride.pickup_longitude},
        "destination": {"latitude": ride.dropoff_latitude, "longitude": ride.dropoff_longitude},
        # final_amount seul existe ce soir (amount estimé vient de L2-04/L2-05, hors de ce
        # lot) -- 0 tant que la course n'est pas completed, cohérent avec l'absence de tarif
        # avant ce stade plutôt qu'une valeur inventée.
        "amount": ride.final_amount or 0,
        "currency": "XAF",
        "createdAt": ride.create_date.isoformat() if ride.create_date else None,
        "assignedDriverId": ride.driver_id.public_id if ride.driver_id else None,
    }


def _map_user_error(message: str) -> tuple[str, int]:
    """Les deux UserError "littérales" que les méthodes de transition peuvent lever en dehors
    de RideInvalidTransition, documentées comme telles à leur point de levée
    (babana_ride_state.py) précisément pour cette traduction (L4-02R2, L4-02.md)."""
    if message == "DRIVER_ALREADY_TAKEN":
        return "DRIVER_ALREADY_TAKEN", 409
    if "chauffeur approuvé" in message:
        return "DRIVER_NOT_APPROVED", 403
    return "VALIDATION_ERROR", 400


class RideController(http.Controller):
    def _dispatch(self, endpoint: str, handler):
        try:
            key = _common.idempotency_key()
            if key:
                cached = _common.lookup_idempotent_response(key, endpoint)
                if cached is not None:
                    payload, status = cached
                    return _common.json_response(payload, status)

            payload, status = handler()

            if key and 200 <= status < 300:
                # Seules les transitions réellement appliquées sont mises en cache (voir
                # lookup_idempotent_response) -- un échec métier ici (RIDE_NOT_OWNED,
                # VALIDATION_ERROR, ...) n'a rien appliqué, le rejouer est sans risque.
                _common.store_idempotent_response(key, endpoint, payload, status)
            return _common.json_response(payload, status)
        except _common.AuthenticationFailed as exc:
            return _common.error_response(exc.code, "authentification requise", exc.status)
        except RideInvalidTransition as exc:
            return _common.error_response("RIDE_INVALID_TRANSITION", str(exc), 409)
        except UserError as exc:
            code, status = _map_user_error(str(exc))
            return _common.error_response(code, str(exc), status)
        except Exception:
            _logger.exception("erreur interne dans %s", endpoint)
            return _common.error_response("INTERNAL_ERROR", "erreur interne", 500)

    def _find_ride(self, env, ride_id):
        return env["babana.ride"].sudo().search([("public_id", "=", ride_id)], limit=1)

    # --- POST /rides/{id}/select-driver -------------------------------------------------------

    @http.route("/api/v1/rides/<string:ride_id>/select-driver", **_ROUTE)
    def select_driver(self, ride_id, **_kwargs):
        return self._dispatch("selectDriver", lambda: self._select_driver(ride_id))

    def _select_driver(self, ride_id):
        env, user = _common.authenticated_user()
        ride = self._find_ride(env, ride_id)
        if not ride:
            return _common.error_payload("RIDE_NOT_FOUND", "course inconnue"), 404
        if ride.client_id != user.partner_id:
            return _common.error_payload("RIDE_NOT_OWNED", "cette course n'appartient pas à l'appelant"), 403

        body = _common.parse_json_body()
        driver_id = (body or {}).get("driverId")
        driver = (
            env["babana.driver"].sudo().search([("public_id", "=", driver_id)], limit=1)
            if driver_id
            else env["babana.driver"]
        )
        if not driver:
            return _common.error_payload("VALIDATION_ERROR", "driverId inconnu ou manquant"), 400

        ride.sudo().action_propose(by_partner=user.partner_id, driver=driver)

        # Fenêtre informative seulement (L3, hors de ce lot, portera l'expiration réelle du
        # côté du service temps réel -- voir amoa/questions/L4-03.md). Paramétrable (invariant
        # 5), jamais codée en dur.
        window_seconds = int(
            env["ir.config_parameter"].sudo().get_param("babana.proposal_window_seconds", 30)
        )
        payload = _summary(ride)
        payload["proposalExpiresAt"] = (
            ride.proposed_at + timedelta(seconds=window_seconds)
        ).isoformat()
        return payload, 200

    # --- POST /rides/{id}/accept ----------------------------------------------------------------

    @http.route("/api/v1/rides/<string:ride_id>/accept", **_ROUTE)
    def accept_ride(self, ride_id, **_kwargs):
        return self._dispatch("acceptRide", lambda: self._accept_ride(ride_id))

    def _accept_ride(self, ride_id):
        env, user = _common.authenticated_user()
        ride, driver, error = self._find_ride_and_assigned_driver(env, user, ride_id)
        if error:
            return error
        ride.sudo().action_accept(by_driver=driver)
        return _summary(ride), 200

    # --- POST /rides/{id}/reject ----------------------------------------------------------------

    @http.route("/api/v1/rides/<string:ride_id>/reject", **_ROUTE)
    def reject_ride(self, ride_id, **_kwargs):
        return self._dispatch("rejectRide", lambda: self._reject_ride(ride_id))

    def _reject_ride(self, ride_id):
        env, user = _common.authenticated_user()
        ride, driver, error = self._find_ride_and_assigned_driver(env, user, ride_id)
        if error:
            return error
        reason = (_common.parse_json_body() or {}).get("reason")
        ride.sudo().action_reject(by_driver=driver, reason=reason)
        return _summary(ride), 200

    # --- POST /rides/{id}/start -----------------------------------------------------------------

    @http.route("/api/v1/rides/<string:ride_id>/start", **_ROUTE)
    def start_ride(self, ride_id, **_kwargs):
        return self._dispatch("startRide", lambda: self._start_ride(ride_id))

    def _start_ride(self, ride_id):
        env, user = _common.authenticated_user()
        ride, driver, error = self._find_ride_and_assigned_driver(env, user, ride_id)
        if error:
            return error
        ride.sudo().action_start(by_driver=driver)
        return _summary(ride), 200

    def _find_ride_and_assigned_driver(self, env, user, ride_id):
        """Commun à accept/reject/start (SelectDriverErrors/AcceptRideErrors/... du contrat C-01
        partagent tous DRIVER_NOT_IN_PROPOSAL pour le même cas : l'appelant n'est pas le
        chauffeur affecté). Renvoie (ride, driver, None) ou (None, None, (payload, status))."""
        ride = self._find_ride(env, ride_id)
        if not ride:
            return None, None, (_common.error_payload("RIDE_NOT_FOUND", "course inconnue"), 404)
        driver = user._babana_driver()
        if not driver or ride.driver_id != driver:
            return None, None, (
                _common.error_payload(
                    "DRIVER_NOT_IN_PROPOSAL",
                    "ce chauffeur n'est pas celui affecté à cette course",
                ),
                403,
            )
        return ride, driver, None

    # --- POST /rides/{id}/cancel ----------------------------------------------------------------

    @http.route("/api/v1/rides/<string:ride_id>/cancel", **_ROUTE)
    def cancel_ride(self, ride_id, **_kwargs):
        return self._dispatch("cancelRide", lambda: self._cancel_ride(ride_id))

    def _cancel_ride(self, ride_id):
        env, user = _common.authenticated_user()
        ride = self._find_ride(env, ride_id)
        if not ride:
            return _common.error_payload("RIDE_NOT_FOUND", "course inconnue"), 404

        driver = user._babana_driver()
        is_supervisor = user.sudo().has_group(
            "babana.group_babana_supervisor"
        ) or user.sudo().has_group("babana.group_babana_manager")
        if ride.client_id == user.partner_id:
            actor_role, actor_record = "client", user.partner_id
        elif driver and ride.driver_id == driver:
            actor_role, actor_record = "driver", driver
        elif is_supervisor:
            actor_role, actor_record = "supervisor", None
        else:
            return _common.error_payload(
                "RIDE_NOT_OWNED", "cette course n'appartient pas à l'appelant"
            ), 403

        reason = (_common.parse_json_body() or {}).get("reason")
        ride.sudo().action_cancel(actor_role=actor_role, actor_record=actor_record, reason=reason)
        return _summary(ride), 200
