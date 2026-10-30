# Historique et factures du client (L6-10, version minimale de démonstration, 30 octobre ;
# contrat C-01 history.ts). Trois routes : la liste paginée des courses terminées, la facture
# d'une course encaissée, et son renvoi par email.
#
# Lecture au nom de l'utilisateur (D54) : la règle d'enregistrement `babana.ride` décide de ce que
# le client voit -- une course qui ne lui appartient pas revient vide (RIDE_NOT_FOUND), jamais
# « interdite ». Rien n'est recalculé : le détail tarifaire est celui gelé à la création de la
# course (fare_rule_snapshot), le montant celui encaissé (L6-10, critère 4).
from __future__ import annotations

import json
import logging

from odoo import http

from . import _common
from ..services.pricing import FareBreakdown, round_breakdown_for_wire

_logger = logging.getLogger(__name__)

_GET_ROUTE = {"type": "http", "auth": "none", "methods": ["GET"], "csrf": False}
# readonly=False explicite : auth='none' est en lecture seule par défaut depuis Odoo 18
# (code/docs/odoo-pitfalls.md) -- l'envoi écrit le compte rendu sur la facture.
_POST_ROUTE = {"type": "http", "auth": "none", "methods": ["POST"], "csrf": False, "readonly": False}

HISTORY_PAGE_SIZE_PARAM = "babana.ride_history_page_size"
HISTORY_PAGE_SIZE_DEFAULT = 20

# Courses terminées seulement : une course en cours se suit sur son propre écran, une course
# refusée faute de chauffeur n'a jamais eu lieu.
_HISTORY_STATES = ("completed", "settled", "cancelled")


def _page_size(env) -> int:
    raw = env["ir.config_parameter"].sudo().get_param(HISTORY_PAGE_SIZE_PARAM)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return HISTORY_PAGE_SIZE_DEFAULT
    return value if value > 0 else HISTORY_PAGE_SIZE_DEFAULT


def _amount(ride) -> int:
    return round(ride.final_amount or ride.estimated_amount or 0)


def _wire_breakdown(ride) -> dict:
    if ride.fare_rule_snapshot:
        return round_breakdown_for_wire(FareBreakdown(**json.loads(ride.fare_rule_snapshot)))
    # Course créée hors du vrai flux /quote -> /rides (tests) : une seule composante portant le
    # montant, pour que la somme reste exacte (même dégradation que la facture, L4-06).
    return {
        "baseFare": _amount(ride), "approachFare": 0, "distanceFare": 0, "surgeAmount": 0,
        "discountAmount": 0, "floorAmount": 0, "roundingAmount": 0, "minimumFareApplied": False,
    }


def _distance_meters(ride):
    if ride.trip_measured and ride.actual_distance_km:
        return round(ride.actual_distance_km * 1000)
    if ride.reference_distance_km:
        return round(ride.reference_distance_km * 1000)
    return None


class RideHistoryController(http.Controller):
    def _run(self, endpoint, handler, *args):
        try:
            payload, status = handler(*args)
            return _common.json_response(payload, status)
        except _common.AuthenticationFailed as exc:
            return _common.error_response(exc.code, "authentification requise", exc.status)
        except Exception:
            _logger.exception("erreur interne dans %s", endpoint)
            return _common.error_response("INTERNAL_ERROR", "erreur interne", 500)

    # --- GET /rides (rideHistory) ---------------------------------------------------------------

    @http.route("/api/v1/rides", **_GET_ROUTE)
    def ride_history(self, cursor=None, **_kwargs):
        return self._run("GET /api/v1/rides", self._ride_history, cursor)

    def _ride_history(self, cursor):
        env, user = _common.authenticated_user()
        rides = env["babana.ride"].with_user(user)
        domain = [("client_id", "=", user.partner_id.id), ("state", "in", _HISTORY_STATES)]
        if cursor:
            # Curseur = identifiant public de la dernière course de la page précédente : la suite
            # commence strictement après elle dans l'ordre (date de demande décroissante, puis id
            # décroissant pour départager deux courses de la même seconde).
            anchor = rides.search([("public_id", "=", cursor)], limit=1)
            if not anchor:
                return _common.error_payload("VALIDATION_ERROR", "curseur inconnu"), 400
            domain += [
                "|",
                ("requested_at", "<", anchor.requested_at),
                "&", ("requested_at", "=", anchor.requested_at), ("id", "<", anchor.id),
            ]
        size = _page_size(env)
        # Par date de la course, jamais par identifiant : une course antidatée (jeu de démonstration)
        # ou reprise n'est pas créée dans l'ordre chronologique (défaut vu le 30 octobre).
        # Un de plus que la page : savoir s'il reste une suite sans seconde requête.
        found = rides.search(domain, order="requested_at desc, id desc", limit=size + 1)
        page = found[:size]
        return {
            "rides": [
                {
                    "id": ride.public_id,
                    "reference": ride.reference,
                    "requestedAt": _common.iso_datetime(ride.requested_at),
                    "pickupLabel": ride.pickup_label or None,
                    "dropoffLabel": ride.dropoff_label or None,
                    "dropoff": {"latitude": ride.dropoff_latitude, "longitude": ride.dropoff_longitude},
                    "amount": _amount(ride),
                    "status": ride.state,
                    "invoiceAvailable": ride.state == "settled" and bool(ride.sudo().invoice_id),
                }
                for ride in page
            ],
            "nextCursor": page[-1].public_id if len(found) > size else None,
        }, 200

    # --- GET /rides/{id}/invoice (rideInvoice) -------------------------------------------------

    def _invoiced_ride(self, env, user, ride_id):
        ride = env["babana.ride"].with_user(user).search(
            [("public_id", "=", ride_id), ("client_id", "=", user.partner_id.id)], limit=1
        )
        if not ride:
            return None, (_common.error_payload("RIDE_NOT_FOUND", "course inconnue"), 404)
        if ride.state != "settled" or not ride.sudo().invoice_id:
            return None, (
                _common.error_payload("INVOICE_NOT_AVAILABLE", "seule une course encaissée a une facture"),
                409,
            )
        return ride, None

    @http.route("/api/v1/rides/<string:ride_id>/invoice", **_GET_ROUTE)
    def ride_invoice(self, ride_id, **_kwargs):
        return self._run("GET /api/v1/rides/{id}/invoice", self._ride_invoice, ride_id)

    def _ride_invoice(self, ride_id):
        env, user = _common.authenticated_user()
        ride, error = self._invoiced_ride(env, user, ride_id)
        if error:
            return error
        # sudo() ciblé sur la facture et le chauffeur : l'appartenance vient d'être établie au nom
        # du client ; account.move et hr.employee ne sont pas des modèles qu'un client lit.
        invoice = ride.sudo().invoice_id
        driver_name = ride.sudo().driver_id.employee_id.name or None
        return {
            "rideId": ride.public_id,
            "reference": ride.reference,
            "invoiceNumber": invoice.name,
            "invoiceDate": invoice.invoice_date.isoformat(),
            "rideDate": _common.iso_datetime(ride.requested_at or ride.create_date),
            "pickupLabel": ride.pickup_label or None,
            "dropoffLabel": ride.dropoff_label or None,
            "distanceMeters": _distance_meters(ride),
            # Prénom seulement : le client l'a vu pendant la course, rien de plus.
            "driverName": driver_name.split()[0] if driver_name else None,
            "amount": _amount(ride),
            "currency": "XAF",
            "breakdown": _wire_breakdown(ride),
            "paymentMethod": "cash",
            "email": ride.sudo().client_id.email or None,
        }, 200

    # --- POST /rides/{id}/invoice/email (sendInvoiceEmail) -------------------------------------

    @http.route("/api/v1/rides/<string:ride_id>/invoice/email", **_POST_ROUTE)
    def send_invoice_email(self, ride_id, **_kwargs):
        return self._run("POST /api/v1/rides/{id}/invoice/email", self._send_invoice_email, ride_id)

    def _send_invoice_email(self, ride_id):
        env, user = _common.authenticated_user()
        ride, error = self._invoiced_ride(env, user, ride_id)
        if error:
            return error
        email = ride.sudo().client_id.email
        if not email:
            return _common.error_payload("CLIENT_EMAIL_MISSING", "aucune adresse email connue"), 409
        # Même chemin que l'envoi automatique et le bouton du back-office (D57) : ne lève jamais,
        # laisse un compte rendu sur la facture (invoice_email_state). Ne lève pas non plus ici :
        # l'échec doit rester écrit (D60), la réponse le dit au client.
        _mail, failure = ride.sudo()._babana_attempt_invoice_email()
        if failure:
            return _common.error_payload("INVOICE_EMAIL_FAILED", failure), 502
        return {"sent": True, "email": email}, 200
