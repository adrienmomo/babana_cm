# Partage de trajet (L8-03, C-01 share.ts). Deux endpoints authentifiés, réservés au client --
# créer/reprendre un jeton, le révoquer. La page publique elle-même n'est jamais servie par
# Odoo (invariant 3 mis à part : elle n'a aucune règle métier à appliquer) -- voir
# services/realtime/src/share/ et controllers/internal.py::resolve_share pour le canal interne
# qui la nourrit.
from __future__ import annotations

import logging
import os

from odoo import http
from odoo.http import request

from . import _common
from ..models.babana_ride import TOGETHER_STATES

_logger = logging.getLogger(__name__)

_ROUTE = {"type": "http", "auth": "none", "methods": ["POST"], "csrf": False, "readonly": False}


def _share_base_url() -> str:
    # Apex, jamais un sous-domaine (spécification -- brièveté du lien collé dans un SMS).
    # BABANA_DOMAIN, même variable que le reste de la pile (infra/env/.env.example, D18).
    return f"https://{os.environ.get('BABANA_DOMAIN', 'babana.cm')}"


class ShareController(http.Controller):
    def _dispatch(self, endpoint: str, handler):
        try:
            payload, status = handler()
            return _common.json_response(payload, status)
        except _common.AuthenticationFailed as exc:
            return _common.error_response(exc.code, "authentification requise", exc.status)
        except Exception:
            _logger.exception("erreur interne dans %s", endpoint)
            return _common.error_response("INTERNAL_ERROR", "erreur interne", 500)

    def _find_owned_ride(self, env, user, ride_id):
        """Commun aux deux routes : le partage n'a de sens que déclenché par le client de la
        course (spécification, « le client déclenche le partage »), jamais le chauffeur --
        contrairement à l'incident (L8-04), symétrique entre les deux parties.

        D54 : lookup au nom de l'utilisateur. Un tiers total ne voit pas la course
        (RIDE_NOT_FOUND 404). Le chauffeur affecté, lui, la voit (branche `driver_id.user_id`
        de la règle) : c'est pour lui que le RIDE_NOT_OWNED 403 explicite reste utile -- il
        peut voir la course sans avoir le droit de la partager."""
        ride = env["babana.ride"].with_user(user).search([("public_id", "=", ride_id)], limit=1)
        if not ride:
            return None, (_common.error_payload("RIDE_NOT_FOUND", "course inconnue"), 404)
        if ride.sudo().client_id != user.partner_id:
            return None, (
                _common.error_payload(
                    "RIDE_NOT_OWNED", "cette course n'appartient pas à l'appelant"
                ),
                403,
            )
        return ride.sudo(), None

    # --- POST /rides/{id}/share (createRideShare) ----------------------------------------------

    @http.route("/api/v1/rides/<string:ride_id>/share", **_ROUTE)
    def create_share(self, ride_id, **_kwargs):
        return self._dispatch("createRideShare", lambda: self._create_share(ride_id))

    def _create_share(self, ride_id):
        env, user = _common.authenticated_user()
        ride, error = self._find_owned_ride(env, user, ride_id)
        if error:
            return error

        if ride.state not in TOGETHER_STATES:
            return _common.error_payload(
                "RIDE_NOT_ACTIVE", "cette course n'est pas actuellement en cours"
            ), 409

        share = env["babana.ride.share"].sudo().action_get_or_create(ride)
        return (
            {
                "token": share.token,
                "url": f"{_share_base_url()}/s/{share.token}",
                "expiresAt": None,
            },
            201,
        )

    # --- POST /rides/{id}/share/revoke (revokeRideShare) --------------------------------------

    @http.route("/api/v1/rides/<string:ride_id>/share/revoke", **_ROUTE)
    def revoke_share(self, ride_id, **_kwargs):
        return self._dispatch("revokeRideShare", lambda: self._revoke_share(ride_id))

    def _revoke_share(self, ride_id):
        env, user = _common.authenticated_user()
        ride, error = self._find_owned_ride(env, user, ride_id)
        if error:
            return error

        shares = env["babana.ride.share"].sudo().search(
            [("ride_id", "=", ride.id), ("revoked_at", "=", False)]
        )
        shares.action_revoke()
        return {"revoked": True}, 200
