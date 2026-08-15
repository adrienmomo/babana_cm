# Distance de référence auprès de l'API de routage (L2-05), avec cache par paire de zones.
#
# É8 -- ASSUMÉ ET DÉLIBÉRÉ : la distance et la durée renvoyées par ce point de calcul sont
# celles d'un itinéraire VOITURE. Ni Google ni Mapbox n'activent de routage deux-roues au
# Cameroun. Ne JAMAIS « corriger » en sommant les points GPS du tracé réellement parcouru --
# cela casserait la reproductibilité des factures (une facture doit rester rejouable à
# l'identique six mois plus tard, amoa/specs/L2-tarification.md, L2-05).
#
# D19 : on simule le fournisseur, jamais notre logique. GOOGLE_ROUTING_URL pointe vers
# mock-maps en développement (services/mocks/maps, L0-08), une vraie API de routage en
# production -- ce module ne contient aucune branche conditionnelle sur l'environnement.
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime

import requests
from odoo import fields

_logger = logging.getLogger(__name__)

DEFAULT_ROUTING_URL = "http://mock-maps:4001/route"
ROUTING_TIMEOUT_SECONDS = 5
# ~111 m à l'équateur pour 0.001° -- "de l'ordre de cent mètres" (L2-05).
GRID_DECIMALS = 3

ROUTE_CACHE_TTL_PARAM = "babana.route_cache_ttl_seconds"
ROUTE_CACHE_TTL_DEFAULT = 3 * 3600  # quelques heures (L2-05)

QUOTA_PARAM = "babana.routing_daily_quota"
QUOTA_DEFAULT = 5000
QUOTA_ALERT_RATIO_PARAM = "babana.routing_quota_alert_ratio"
QUOTA_ALERT_RATIO_DEFAULT = 0.8


class RouteUnavailable(Exception):
    """L'API de routage est indisponible -- à traduire en ROUTE_UNAVAILABLE (catalogue C-01) par
    le contrôleur (controllers/quote.py). Ne jamais dégrader en distance à vol d'oiseau : une
    estimation fausse est pire qu'une absence d'estimation (critère d'acceptation 3)."""


@dataclass(frozen=True)
class RouteResult:
    distance_meters: int
    duration_seconds: int
    polyline: str


def _round_to_grid(value: float) -> float:
    return round(value, GRID_DECIMALS)


def _time_bucket(at_datetime: datetime) -> int:
    return at_datetime.hour


def cache_key(*, origin, destination, vehicle_class: str, at_datetime: datetime) -> str:
    """Clé de cache (L2-05) : coordonnées arrondies à la grille, gamme, tranche horaire."""
    return "|".join(
        [
            f"{_round_to_grid(origin[0])},{_round_to_grid(origin[1])}",
            f"{_round_to_grid(destination[0])},{_round_to_grid(destination[1])}",
            vehicle_class,
            str(_time_bucket(at_datetime)),
        ]
    )


def get_reference_route(
    env, *, origin, destination, vehicle_class: str, at_datetime: datetime
) -> RouteResult:
    """Distance/durée de référence pour un couple de points (L2-05). Sert le cache
    (babana.route.cache) quand une entrée valide existe pour la même clé ; sinon appelle l'API de
    routage, pose une nouvelle entrée, et comptabilise l'appel pour le suivi de quota. Lève
    RouteUnavailable si l'API échoue -- jamais d'estimation dégradée silencieuse."""
    key = cache_key(
        origin=origin, destination=destination, vehicle_class=vehicle_class, at_datetime=at_datetime
    )
    cache_model = env["babana.route.cache"].sudo()
    cached = cache_model._get_fresh(key)
    if cached:
        return RouteResult(cached.distance_meters, cached.duration_seconds, cached.polyline or "")

    result = _fetch_from_api(origin=origin, destination=destination)

    ttl_seconds = int(
        env["ir.config_parameter"].sudo().get_param(ROUTE_CACHE_TTL_PARAM, ROUTE_CACHE_TTL_DEFAULT)
    )
    cache_model._store(
        key,
        distance_meters=result.distance_meters,
        duration_seconds=result.duration_seconds,
        polyline=result.polyline,
        ttl_seconds=ttl_seconds,
    )
    _record_quota_usage(env)
    return result


def _fetch_from_api(*, origin, destination) -> RouteResult:
    routing_url = os.environ.get("GOOGLE_ROUTING_URL", DEFAULT_ROUTING_URL)
    try:
        response = requests.get(
            routing_url,
            params={
                "originLat": origin[0],
                "originLng": origin[1],
                "destLat": destination[0],
                "destLng": destination[1],
            },
            timeout=ROUTING_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        data = response.json()
    except (requests.RequestException, ValueError) as exc:
        raise RouteUnavailable("API de routage indisponible") from exc

    try:
        return RouteResult(
            distance_meters=int(data["distanceMeters"]),
            duration_seconds=int(data["durationSeconds"]),
            polyline=data.get("polyline") or "",
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise RouteUnavailable("réponse de l'API de routage illisible") from exc


def _record_quota_usage(env) -> None:
    """Plafond de quota configurable, avec alerte quand il approche (L2-05, spécification). Le
    compteur du jour vit dans ir.config_parameter -- volume d'appels du pilote trop faible pour
    justifier un modèle dédié."""
    param_model = env["ir.config_parameter"].sudo()
    count_key = f"babana.routing_quota_count_{fields.Date.today().isoformat()}"
    count = int(param_model.get_param(count_key, 0)) + 1
    param_model.set_param(count_key, str(count))

    quota = int(param_model.get_param(QUOTA_PARAM, QUOTA_DEFAULT))
    alert_ratio = float(param_model.get_param(QUOTA_ALERT_RATIO_PARAM, QUOTA_ALERT_RATIO_DEFAULT))
    if quota > 0 and count >= quota * alert_ratio:
        _logger.warning(
            "Quota de routage à %s/%s appels aujourd'hui (seuil d'alerte %.0f%%).",
            count, quota, alert_ratio * 100,
        )
