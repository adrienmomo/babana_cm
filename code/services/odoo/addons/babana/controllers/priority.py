# « Ma priorité » côté serveur (19 novembre, amoa/questions/PRIORITE-2026-11-19.md) : le journal
# des points de course et le détail des points de note du chauffeur connecté. Lecture seule ; l'app
# affiche, ne calcule rien (invariant 3). Le total et ses trois composantes voyagent déjà dans
# `GET /me` (`driverPriority`).
from __future__ import annotations

import logging

from odoo import http

from . import _common
from .history import _page_size
from ..services import priority

_logger = logging.getLogger(__name__)

_GET_ROUTE = {"type": "http", "auth": "none", "methods": ["GET"], "csrf": False, "readonly": True}


class DriverPriorityController(http.Controller):
    def _run(self, endpoint, handler, *args):
        try:
            env, user = _common.authenticated_user()
            driver = user._babana_driver()
            if not driver:
                raise _common.AuthenticationFailed("UNAUTHORIZED")
            payload, status = handler(env, driver.sudo(), *args)
            return _common.json_response(payload, status)
        except _common.AuthenticationFailed as exc:
            return _common.error_response(exc.code, "authentification requise", exc.status)
        except Exception:
            _logger.exception("erreur interne dans %s", endpoint)
            return _common.error_response("INTERNAL_ERROR", "erreur interne", 500)

    # --- GET /drivers/me/priority/ride-points (driverRidePointsLog) ------------------------------
    # Le journal du chauffeur, du plus récent au plus ancien, par pages (babana.ride_history_page_size).
    # Curseur = identifiant de la dernière ligne de la page précédente. Jamais le client.

    @http.route("/api/v1/drivers/me/priority/ride-points", **_GET_ROUTE)
    def ride_points(self, cursor=None, **_kwargs):
        return self._run("GET /api/v1/drivers/me/priority/ride-points", self._ride_points, cursor)

    def _ride_points(self, env, driver, cursor):
        Movement = env["babana.driver.priority.movement"].sudo()
        domain = [("driver_id", "=", driver.id)]
        if cursor:
            anchor = Movement.search(domain + [("id", "=", int(cursor) if str(cursor).isdigit() else 0)], limit=1)
            if not anchor:
                return _common.error_payload("VALIDATION_ERROR", "curseur inconnu"), 400
            domain += [
                "|",
                ("occurred_at", "<", anchor.occurred_at),
                "&", ("occurred_at", "=", anchor.occurred_at), ("id", "<", anchor.id),
            ]
        size = _page_size(env)
        found = Movement.search(domain, limit=size + 1)
        page = found[:size]
        return {
            "ridePoints": driver.ride_points,
            "ridePointsMax": priority.ride_points_max(env),
            "entries": [
                {
                    "id": str(movement.id),
                    "kind": movement.kind,
                    "delta": movement.delta,
                    "balanceAfter": movement.balance_after,
                    "occurredAt": _common.iso_datetime(movement.occurred_at),
                    "rideReference": movement.ride_id.reference if movement.ride_id else None,
                    "pickupLabel": (movement.ride_id.pickup_label or None) if movement.ride_id else None,
                    "dropoffLabel": (movement.ride_id.dropoff_label or None) if movement.ride_id else None,
                }
                for movement in page
            ],
            "nextCursor": str(page[-1].id) if len(found) > size else None,
        }, 200

    # --- GET /drivers/me/priority/stars (driverStarPoints) ---------------------------------------
    # Comment les points de note se calculent, sans la liste des avis.

    @http.route("/api/v1/drivers/me/priority/stars", **_GET_ROUTE)
    def stars(self, **_kwargs):
        return self._run("GET /api/v1/drivers/me/priority/stars", self._stars)

    def _stars(self, env, driver):
        detail = priority.star_detail(driver)
        return {
            "starPoints": detail.points,
            "starPointsMax": detail.points_max,
            "smoothedAverage": round(detail.smoothed_average, 2),
            "ratingCount": detail.rating_count,
            "ratingAverage": round(detail.rating_average, 1) if detail.rating_average is not None else None,
            "priorCount": detail.prior_count,
            "priorValue": detail.prior_value,
            "tiers": [{"above": tier.above, "points": tier.points, "applied": tier.applied} for tier in detail.tiers],
        }, 200
