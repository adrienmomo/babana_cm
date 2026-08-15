# Endpoints du cycle de vie de la course (L4-03, C-01 ride.ts). Traduit HTTP en appel de méthode
# de transition, rien de plus (invariant 3) -- toute condition métier vit dans
# babana_ride_state.py ; une condition écrite ici serait contournée par le back-office, qui
# appelle les méthodes de transition directement.
#
# Sept endpoints ce soir (L4-03R, J5) : createRide et completeRide s'ajoutent aux cinq de L4-03
# (amoa/questions/L4-03.md), débloqués par babana.quote (L2-04) et par la consolidation de fin
# de course (L4-04, babana.ride._babana_compute_final_amount). settleRide et rateRide restent
# hors de portée -- ils dépendent respectivement du compte courant chauffeur (L4-05/L5-01,
# logique financière sous revue humaine) et de babana.rating (L4-09), aucun des deux dans ce lot.
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
        # final_amount une fois completed ; jusque-là l'estimé gelé à la création (L2-04/
        # L4-03R), pas 0 -- corrigé en implémentant L4-03R (createRideResponseExample, C-01,
        # montre déjà amount=1200 sur une course à l'état 'requested').
        "amount": round(ride.final_amount or ride.estimated_amount or 0),
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

    # --- POST /rides (createRide, L4-03R) ------------------------------------------------------

    @http.route("/api/v1/rides", **_ROUTE)
    def create_ride(self, **_kwargs):
        return self._dispatch("createRide", self._create_ride)

    def _create_ride(self):
        env, user = _common.authenticated_user()
        body = _common.parse_json_body()
        quote_id = (body or {}).get("quoteId")
        if not quote_id:
            return _common.error_payload("VALIDATION_ERROR", "quoteId est requis"), 400

        # Un client ne peut référencer que sa propre estimation -- traité comme "introuvable",
        # pas comme un défaut d'appartenance distinct : le catalogue de createRide (C-01) ne
        # prévoit que QUOTE_EXPIRED et QUOTE_NOT_FOUND, pas de RIDE_NOT_OWNED équivalent pour
        # une estimation.
        quote = env["babana.quote"].sudo().search(
            [("public_id", "=", quote_id), ("client_id", "=", user.partner_id.id)], limit=1
        )
        if not quote:
            return _common.error_payload("QUOTE_NOT_FOUND", "estimation inconnue"), 404
        if quote.is_expired():
            return _common.error_payload(
                "QUOTE_EXPIRED", "l'estimation a expiré ; en redemander une"
            ), 410

        # La course référence l'estimation plutôt que de recalculer (L2-04, L4-03R) : c'est ce
        # qui garantit que le client paie ce qu'on lui a montré. Rien n'est recalculé ici.
        ride = env["babana.ride"].sudo().action_request(
            {
                "client_id": user.partner_id.id,
                "pickup_latitude": quote.pickup_latitude,
                "pickup_longitude": quote.pickup_longitude,
                "dropoff_latitude": quote.dropoff_latitude,
                "dropoff_longitude": quote.dropoff_longitude,
                "pickup_zone_id": quote.pickup_zone_id.id,
                "dropoff_zone_id": quote.dropoff_zone_id.id,
                "quote_id": quote.id,
                "currency_id": quote.currency_id.id,
                "estimated_amount": quote.amount,
                "reference_distance_km": quote.distance_meters / 1000.0,
                "estimated_duration_minutes": quote.eta_seconds / 60.0,
                "fare_rule_id": quote.fare_rule_id.id,
                "fare_rule_snapshot": quote.fare_rule_snapshot,
                "promotion_code": quote.promo_code,
                "discount_amount": quote.discount_amount,
            }
        )
        return _summary(ride), 201

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

    # --- POST /rides/{id}/complete (L4-03R) ----------------------------------------------------

    @http.route("/api/v1/rides/<string:ride_id>/complete", **_ROUTE)
    def complete_ride(self, ride_id, **_kwargs):
        return self._dispatch("completeRide", lambda: self._complete_ride(ride_id))

    def _complete_ride(self, ride_id):
        env, user = _common.authenticated_user()
        ride, driver, error = self._find_ride_and_assigned_driver(env, user, ride_id)
        if error:
            return error

        body = _common.parse_json_body() or {}
        distance_meters, duration_seconds, polyline, error = self._validate_complete_body(body)
        if error:
            return error

        # Consolidation (L4-04) : le montant final se calcule sur la distance de référence
        # (gelée à la création, L2-04), jamais sur la distance parcourue transmise ici -- voir
        # babana.ride._babana_compute_final_amount. Le tracé, la distance et la durée parcourues
        # sont écrits en une seule opération par action_complete (L4-02), pas recalculés ici.
        final_amount = ride._babana_compute_final_amount()
        ride.sudo().action_complete(
            by_driver=driver,
            actual_distance_km=distance_meters / 1000.0,
            actual_duration_minutes=duration_seconds / 60.0,
            track_polyline=polyline,
            final_amount=final_amount,
        )
        payload = _summary(ride)
        payload["distanceMeters"] = round(ride.actual_distance_km * 1000)
        payload["durationSeconds"] = round(ride.actual_duration_minutes * 60)
        return payload, 200

    @staticmethod
    def _validate_complete_body(body):
        distance_meters = body.get("distanceMeters")
        duration_seconds = body.get("durationSeconds")
        polyline = body.get("polyline")
        if (
            not isinstance(distance_meters, (int, float)) or distance_meters < 0
            or not isinstance(duration_seconds, (int, float)) or duration_seconds < 0
            or not isinstance(polyline, str) or not polyline
        ):
            return None, None, None, (
                _common.error_payload(
                    "VALIDATION_ERROR",
                    "distanceMeters, durationSeconds (entiers positifs) et polyline (non vide) "
                    "sont requis",
                ), 400,
            )
        return distance_meters, duration_seconds, polyline, None

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
