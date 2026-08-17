# Endpoints internes reçus du service temps réel (L3-17, sens temps réel -> Odoo). Symétrique de
# services/realtime_client.py (sens Odoo -> temps réel) : ce fichier-ci REÇOIT plutôt qu'il
# n'émet. Authentifié par X-Realtime-Secret (_common.authenticated_internal_call), jamais par le
# jeton d'accès d'un utilisateur -- ces appels n'ont pas d'utilisateur humain derrière eux.
#
# Jamais exposé publiquement : ni le domaine mobile, ni Caddy ne routent vers `/api/internal/*`
# (vérifié dans infra/caddy/Caddyfile), le secret partagé est une seconde barrière, indépendante
# du routage.
from __future__ import annotations

import logging

from odoo import SUPERUSER_ID, http
from odoo.exceptions import UserError
from odoo.http import request
from odoo.service.model import PG_CONCURRENCY_EXCEPTIONS_TO_RETRY

from . import _common
from ..models.babana_ride import CLIENT_ACTIVE_STATES, DRIVER_ACTIVE_STATES
from ..models.babana_ride_state import RideInvalidTransition

_logger = logging.getLogger(__name__)

# readonly=False explicite : auth='none' est en lecture seule par défaut depuis Odoo 18
# (code/docs/odoo-pitfalls.md) -- les deux premières routes écrivent une transition.
_WRITE_ROUTE = {"type": "http", "auth": "none", "methods": ["POST"], "csrf": False, "readonly": False}
# La réconciliation ne lit que -- pas de readonly=False ici, contrairement aux deux ci-dessus.
_READ_ROUTE = {"type": "http", "auth": "none", "methods": ["POST"], "csrf": False}


class InternalController(http.Controller):
    def _dispatch(self, endpoint: str, handler):
        try:
            _common.authenticated_internal_call()
            payload, status = handler()
            return _common.json_response(payload, status)
        except _common.AuthenticationFailed as exc:
            return _common.error_response(exc.code, "authentification requise", exc.status)
        except RideInvalidTransition as exc:
            return _common.error_response("RIDE_INVALID_TRANSITION", str(exc), 409)
        except UserError as exc:
            return _common.error_response("VALIDATION_ERROR", str(exc), 400)
        except PG_CONCURRENCY_EXCEPTIONS_TO_RETRY:
            # Même politique que controllers/ride.py::_dispatch (D25) : ne jamais attraper cette
            # famille d'exceptions ici, la laisser remonter jusqu'au rejeu d'Odoo. Ces routes
            # n'ont pas les mêmes préoccupations d'idempotence que select-driver -- accept/reject
            # sont idempotents par construction côté temps réel (resolve.lua ne résout qu'une
            # fois), un rejeu de driver-accepted/driver-rejected ré-exécute action_accept/
            # action_reject sur un état déjà transitionné et échoue proprement en
            # RIDE_INVALID_TRANSITION, jamais en double effet.
            raise
        except Exception:
            _logger.exception("erreur interne dans %s", endpoint)
            return _common.error_response("INTERNAL_ERROR", "erreur interne", 500)

    def _find_ride(self, env, ride_id):
        return env["babana.ride"].sudo().search([("public_id", "=", ride_id)], limit=1)

    def _find_driver(self, env, driver_id):
        if not driver_id:
            return env["babana.driver"]
        return env["babana.driver"].sudo().search([("public_id", "=", driver_id)], limit=1)

    # --- POST /internal/rides/{id}/driver-accepted (L3-17, sens temps réel -> Odoo) -----------

    @http.route("/api/internal/rides/<string:ride_id>/driver-accepted", **_WRITE_ROUTE)
    def driver_accepted(self, ride_id, **_kwargs):
        return self._dispatch("driverAccepted", lambda: self._driver_accepted(ride_id))

    def _driver_accepted(self, ride_id):
        env = request.env(user=SUPERUSER_ID)
        ride = self._find_ride(env, ride_id)
        if not ride:
            return _common.error_payload("RIDE_NOT_FOUND", "course inconnue"), 404

        body = _common.parse_json_body() or {}
        driver = self._find_driver(env, body.get("driverId"))
        if not driver:
            return _common.error_payload("VALIDATION_ERROR", "driverId inconnu ou manquant"), 400

        ride.sudo().action_accept(by_driver=driver)
        return {"ok": True}, 200

    # --- POST /internal/rides/{id}/driver-rejected (refus explicite ou expiration) ------------

    @http.route("/api/internal/rides/<string:ride_id>/driver-rejected", **_WRITE_ROUTE)
    def driver_rejected(self, ride_id, **_kwargs):
        return self._dispatch("driverRejected", lambda: self._driver_rejected(ride_id))

    def _driver_rejected(self, ride_id):
        env = request.env(user=SUPERUSER_ID)
        ride = self._find_ride(env, ride_id)
        if not ride:
            return _common.error_payload("RIDE_NOT_FOUND", "course inconnue"), 404

        body = _common.parse_json_body() or {}
        driver = self._find_driver(env, body.get("driverId"))
        if not driver:
            return _common.error_payload("VALIDATION_ERROR", "driverId inconnu ou manquant"), 400

        ride.sudo().action_reject(
            by_driver=driver, reason=body.get("reason"), expired=bool(body.get("expired"))
        )
        return {"ok": True}, 200

    # --- POST /internal/drivers/engaged (réconciliation, L3-17 critère 7) ---------------------

    @http.route("/api/internal/drivers/engaged", **_READ_ROUTE)
    def engaged_drivers(self, **_kwargs):
        return self._dispatch("engagedDrivers", self._engaged_drivers)

    def _engaged_drivers(self):
        """Odoo est la source de vérité (D27) : la liste des chauffeurs que le service temps réel
        doit considérer comme engagés (marqueur sans expiration, D26) est celle des courses
        `assigned`/`in_progress` -- pas `proposed`, qui reste protégée par la réservation à
        expiration (L3-06), pas par l'engagement."""
        env = request.env(user=SUPERUSER_ID)
        rides = env["babana.ride"].sudo().search(
            [("state", "in", ["assigned", "in_progress"]), ("driver_id", "!=", False)]
        )
        return {"driverIds": rides.mapped("driver_id.public_id")}, 200

    # --- POST /internal/session/active-ride (L3-11, resynchronisation à la reconnexion) -------

    @http.route("/api/internal/session/active-ride", **_READ_ROUTE)
    def active_ride(self, **_kwargs):
        return self._dispatch("activeRide", self._active_ride)

    def _active_ride(self):
        """Odoo est la source de vérité (D27) : le service temps réel ne garde aucune trace
        durable de l'état d'une course (invariant 1), il interroge ici l'état réel avant de
        répondre à `session.resync` (L3-11). `userId`/`role` identifient la connexion
        (`ConnectionContext`, ws/auth.ts) -- jamais un `driverId` seul, qui n'a pas de sens pour
        un client.

        Une course "active" est celle qui bloquerait une seconde course du même acteur
        (`CLIENT_ACTIVE_STATES`/`DRIVER_ACTIVE_STATES`, babana_ride.py -- la même liste que la
        contrainte "une seule course active", pas une nouvelle définition). À défaut, et
        seulement si `lastKnownRideId` est fourni, la course précise que le client croyait
        encore en cours est relue avec son état réel -- un client qui se reconnecte juste après
        que sa course est passée `completed` (donc hors des états "actifs", l'encaissement n'est
        pas bloquant) doit apprendre ce vrai état plutôt qu'un néant ambigu. Toujours vérifié par
        propriété : jamais l'état d'une course qui n'appartient pas à l'appelant.
        """
        env = request.env(user=SUPERUSER_ID)
        body = _common.parse_json_body() or {}
        user_public_id = body.get("userId")
        role = body.get("role")
        last_known_ride_id = body.get("lastKnownRideId")
        if not user_public_id or role not in ("client", "driver"):
            return _common.error_payload("VALIDATION_ERROR", "userId et role sont requis"), 400

        user = env["res.users"].sudo().search(
            [("babana_public_id", "=", user_public_id)], limit=1
        )
        if not user:
            return {"rideId": None, "state": None}, 200

        if role == "client":
            owner_domain = [("client_id", "=", user.partner_id.id)]
            active_states = CLIENT_ACTIVE_STATES
        else:
            driver = user._babana_driver()
            if not driver:
                return {"rideId": None, "state": None}, 200
            owner_domain = [("driver_id", "=", driver.id)]
            active_states = DRIVER_ACTIVE_STATES

        ride = env["babana.ride"].sudo().search(
            owner_domain + [("state", "in", list(active_states))], limit=1
        )
        if not ride and last_known_ride_id:
            ride = env["babana.ride"].sudo().search(
                owner_domain + [("public_id", "=", last_known_ride_id)], limit=1
            )
        if not ride:
            return {"rideId": None, "state": None}, 200
        return {"rideId": ride.public_id, "state": ride.state}, 200
