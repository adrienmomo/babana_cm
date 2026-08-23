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
from ..services import routing
from ..services.pricing import FareRuleInput, compute_fare

_logger = logging.getLogger(__name__)

_ROUTE = {"type": "http", "auth": "none", "methods": ["POST"], "csrf": False, "readonly": False}

QUOTE_VALIDITY_PARAM = "babana.quote_validity_seconds"
QUOTE_VALIDITY_DEFAULT = 300  # 5 minutes -- "de l'ordre de quelques minutes" (L2-04).

# Facteur de correction de l'ETA voiture -> deux-roues (É8). L10-03, qui calibrera sa vraie
# valeur sur données de pilote, est hors de ce lot -- 1.0 (aucune correction) est un défaut
# explicitement provisoire (D21), paramétrable (invariant 5), pas un calcul inventé ici. Voir
# amoa/questions/L2-04.md.
ETA_CORRECTION_FACTOR_PARAM = "babana.eta_correction_factor"
ETA_CORRECTION_FACTOR_DEFAULT = 1.0


def _round_breakdown_for_wire(breakdown) -> dict:
    """XAF n'a pas de sous-unité (packages/contracts/src/http/common.ts, MoneyAmountSchema) :
    chaque composante doit voyager en entier. Arrondir composante par composante indépendamment
    casserait l'identité « la somme des composantes égale le total » (L2-03, critère 4) dès que
    l'une d'elles porte une partie fractionnaire de FCFA (ex. distance_km non entier) -- rounding
    (déjà chargé d'absorber l'arrondi au pas configuré côté pur) absorbe ici en plus l'arrondi
    entier d'affichage, pour que l'identité reste exacte sur ce qui est effectivement montré au
    client. Le détail brut (float), lui, reste stocké tel quel dans fare_rule_snapshot."""
    base = round(breakdown.base_fare)
    distance = round(breakdown.distance_fare)
    surge = round(breakdown.surge_amount)
    discount = round(breakdown.discount_amount)
    floor = round(breakdown.floor_amount)
    total = round(breakdown.total)
    rounding = total - (base + distance + surge - discount + floor)
    return {
        "baseFare": base,
        "distanceFare": distance,
        "surgeAmount": surge,
        "discountAmount": discount,
        "floorAmount": floor,
        "roundingAmount": rounding,
        "minimumFareApplied": breakdown.minimum_fare_applied,
    }


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

        rounding_step = env["babana.fare.rule"].sudo()._default_rounding_step()
        rule_input = FareRuleInput(
            base_fare=rule.base_fare,
            price_per_km=rule.price_per_km,
            minimum_fare=rule.minimum_fare,
            surge_multiplier=rule.surge_multiplier,
        )
        # promoCode : babana.promotion (L2-06) n'existe pas encore -- un code fourni reste sans
        # effet (promo_applied=False), jamais une erreur (critère d'acceptation 5). Voir
        # amoa/questions/L2-04.md.
        promo_code = body.get("promoCode")
        promo_applied = False
        breakdown = compute_fare(rule_input, route.distance_meters, rounding_step=rounding_step)

        eta_factor = float(
            env["ir.config_parameter"].sudo().get_param(
                ETA_CORRECTION_FACTOR_PARAM, ETA_CORRECTION_FACTOR_DEFAULT
            )
        )
        eta_seconds = round(route.duration_seconds * eta_factor)

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

        wire_breakdown = _round_breakdown_for_wire(breakdown)
        return {
            "quoteId": quote.public_id,
            "amount": round(breakdown.total),
            "currency": "XAF",
            "breakdown": wire_breakdown,
            "distanceMeters": route.distance_meters,
            "etaSeconds": eta_seconds,
            "promoApplied": promo_applied,
            "expiresAt": _common.iso_datetime(expires_at),
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
