# Endpoint de cotation (L2-04, C-01 quote.ts). Résout les zones, sélectionne la règle
# tarifaire, obtient la distance de référence (L2-05), calcule (L2-03), applique le facteur de
# correction d'ETA (L10-03, hors de ce lot -- voir amoa/questions/L2-04.md pour la valeur
# provisoire retenue en attendant). Aucune règle métier ici au-delà de cet assemblage : le calcul
# lui-même vit dans services/pricing.py (invariant 3).
from __future__ import annotations

import dataclasses
import json
import logging
from datetime import timedelta

from odoo import fields, http

from . import _common
from ..services import approach, routing
from ..models.babana_quote import QUOTE_VALIDITY_DEFAULT, QUOTE_VALIDITY_PARAM
from ..services.dispatch import DISPATCH_RADIUS_DEFAULT, DISPATCH_RADIUS_PARAM, _positive_int_param
from ..services.pricing import compute_fare, round_breakdown_for_wire

_logger = logging.getLogger(__name__)

_ROUTE = {"type": "http", "auth": "none", "methods": ["POST"], "csrf": False, "readonly": False}

# Paramètre et repli de validité d'une estimation : déclarés avec le modèle (models/babana_quote.py),
# que la page Paramètres > Babana lit aussi -- un modèle n'importe jamais un contrôleur.

# Facteur de correction de l'ETA voiture -> deux-roues (É8). L10-03, qui calibrera sa vraie
# valeur sur données de pilote, est hors de ce lot -- 1.0 (aucune correction) est un défaut
# explicitement provisoire (D21), paramétrable (invariant 5), pas un calcul inventé ici. Voir
# amoa/questions/L2-04.md.
ETA_CORRECTION_FACTOR_PARAM = "babana.eta_correction_factor"
ETA_CORRECTION_FACTOR_DEFAULT = 1.0


class QuoteController(http.Controller):
    @http.route("/api/v1/quote", **_ROUTE)
    def quote(self, **_kwargs):
        try:
            payload, status = self._quote()
            return _common.json_response(payload, status)
        except _common.AuthenticationFailed as exc:
            return _common.error_response(exc.code, "authentification requise", exc.status)
        except routing.RouteUnavailable as exc:
            return _common.error_response("ROUTE_UNAVAILABLE", str(exc), 503)
        except Exception:
            _logger.exception("erreur interne dans POST /api/v1/quote")
            return _common.error_response("INTERNAL_ERROR", "erreur interne", 500)

    def _quote(self):
        env, user = _common.authenticated_user()
        body = _common.parse_json_body() or {}

        origin, destination, vehicle_class, error = self._validate(body)
        if error:
            return error

        now = fields.Datetime.now()

        pickup_zone = env["babana.zone"].sudo().resolve_point(
            latitude=origin[0], longitude=origin[1]
        )
        dropoff_zone = env["babana.zone"].sudo().resolve_point(
            latitude=destination[0], longitude=destination[1]
        )

        # La zone de DÉPART détermine la règle, pas la zone d'arrivée (services/pricing.py,
        # documenté ici comme le demande L2-07).
        rule = env["babana.fare.rule"].sudo()._find_applicable_rule(
            zone=pickup_zone, vehicle_class=vehicle_class, at_datetime=now
        )

        route = routing.get_reference_route(
            env, origin=origin, destination=destination, vehicle_class=vehicle_class,
            at_datetime=now,
        )

        # Prise en charge : distance routière MOYENNE des chauffeurs disponibles, dans le rayon où
        # l'affectation les chercherait -- mesurée maintenant et gelée avec l'estimation.
        approach_estimate = approach.average_approach(
            env,
            pickup=origin,
            radius_meters=_positive_int_param(env, DISPATCH_RADIUS_PARAM, DISPATCH_RADIUS_DEFAULT),
        )

        rounding_step = env["babana.fare.rule"].sudo()._default_rounding_step()
        rule_input = rule._pricing_input()
        # promoCode : babana.promotion (L2-06) n'existe pas encore -- un code fourni reste sans
        # effet (promo_applied=False), jamais une erreur (critère d'acceptation 5). Voir
        # amoa/questions/L2-04.md.
        promo_code = body.get("promoCode")
        promo_applied = False
        breakdown = compute_fare(
            rule_input,
            route.distance_meters,
            rounding_step=rounding_step,
            approach_distance_m=approach_estimate.distance_meters,
        )

        eta_factor = float(
            env["ir.config_parameter"].sudo().get_param(
                ETA_CORRECTION_FACTOR_PARAM, ETA_CORRECTION_FACTOR_DEFAULT
            )
        )
        eta_seconds = round(route.duration_seconds * eta_factor)
        # « Moto à ~N min » : même correction voiture -> deux-roues que la durée du trajet (É8).
        pickup_eta_seconds = (
            round(approach_estimate.nearest_duration_seconds * eta_factor)
            if approach_estimate.nearest_duration_seconds is not None
            else None
        )

        validity_seconds = int(
            env["ir.config_parameter"].sudo().get_param(
                QUOTE_VALIDITY_PARAM, QUOTE_VALIDITY_DEFAULT
            )
        )
        expires_at = now + timedelta(seconds=validity_seconds)

        breakdown_dict = dataclasses.asdict(breakdown)
        quote = env["babana.quote"].sudo().create(
            {
                "client_id": user.partner_id.id,
                "pickup_latitude": origin[0],
                "pickup_longitude": origin[1],
                "dropoff_latitude": destination[0],
                "dropoff_longitude": destination[1],
                "pickup_zone_id": pickup_zone.id,
                "dropoff_zone_id": dropoff_zone.id,
                "vehicle_class": vehicle_class,
                "distance_meters": route.distance_meters,
                "duration_seconds": route.duration_seconds,
                "approach_distance_meters": approach_estimate.distance_meters,
                "approach_driver_count": approach_estimate.driver_count,
                "eta_seconds": eta_seconds,
                "fare_rule_id": rule.id,
                "fare_rule_snapshot": json.dumps(breakdown_dict),
                "amount": breakdown.total,
                "promo_code": promo_code,
                "promo_applied": promo_applied,
                "discount_amount": breakdown.discount_amount,
                "expires_at": expires_at,
            }
        )

        wire_breakdown = round_breakdown_for_wire(breakdown)
        return {
            "quoteId": quote.public_id,
            "amount": round(breakdown.total),
            "currency": "XAF",
            "breakdown": wire_breakdown,
            "distanceMeters": route.distance_meters,
            "approachDistanceMeters": approach_estimate.distance_meters,
            "etaSeconds": eta_seconds,
            "pickupEtaSeconds": pickup_eta_seconds,
            "promoApplied": promo_applied,
            "expiresAt": _common.iso_datetime(expires_at),
            # Le compte à rebours de l'app part de cette durée, pas de l'horloge du téléphone --
            # souvent fausse sur un terminal d'entrée de gamme (« Valable 1476 min », 26 octobre).
            "validForSeconds": validity_seconds,
        }, 200

    def _validate(self, body):
        origin = self._parse_latlng(body.get("origin"))
        destination = self._parse_latlng(body.get("destination"))
        if origin is None or destination is None:
            return None, None, None, (
                _common.error_payload("VALIDATION_ERROR", "origin et destination sont requis"), 400
            )

        vehicle_class = body.get("vehicleClass", "standard")
        if vehicle_class not in ("standard", "premium"):
            return None, None, None, (
                _common.error_payload(
                    "VALIDATION_ERROR", "vehicleClass doit valoir 'standard' ou 'premium'"
                ), 400,
            )

        return origin, destination, vehicle_class, None

    @staticmethod
    def _parse_latlng(value):
        if not isinstance(value, dict):
            return None
        try:
            latitude = float(value["latitude"])
            longitude = float(value["longitude"])
        except (KeyError, TypeError, ValueError):
            return None
        if not (-90 <= latitude <= 90) or not (-180 <= longitude <= 180):
            return None
        return latitude, longitude
