# Distance d'approche ROUTIÈRE des chauffeurs disponibles jusqu'au point de prise en charge
# (demande produit du 26 octobre, D-suivant proposée). Deux usages, une seule mesure :
#
# - l'estimation (controllers/quote.py) : la prise en charge est facturée sur la distance MOYENNE
#   des chauffeurs disponibles, mesurée au moment où le prix est montré et gelée avec lui -- le
#   client paie ce qu'il a vu, jamais l'approche du chauffeur finalement affecté, inconnue alors ;
# - l'affectation (services/dispatch.py) : la course part au plus proche PAR LA ROUTE, pas à vol
#   d'oiseau. Le classement est transmis au service temps réel, qui garde seul le choix ET la
#   réservation dans un script Lua (invariant 4) : un classé déjà pris entre-temps est passé.
#
# Le service temps réel fournit les positions (il est le seul à les connaître, invariant 1) ;
# Odoo mesure les distances avec la même API de routage que la cotation, mais SANS son cache
# (routing.measure_route) : sa grille de ~100 m confondrait deux chauffeurs voisins. É8
# s'applique : ce sont des distances voiture.
#
# Échantillon borné (babana.approach_sample_size) : les N plus proches à vol d'oiseau seulement,
# un appel de routage par chauffeur et par estimation ne se paie pas sur tout le vivier.
from __future__ import annotations

import logging
from dataclasses import dataclass

from . import realtime_client, routing

_logger = logging.getLogger(__name__)

APPROACH_SAMPLE_SIZE_PARAM = "babana.approach_sample_size"
APPROACH_SAMPLE_SIZE_DEFAULT = 5
# Repli quand personne n'est mesurable à l'estimation (aucun chauffeur dans le rayon, service
# temps réel injoignable) : une valeur paramétrable, jamais zéro en silence. Provisoire (D21).
DEFAULT_APPROACH_DISTANCE_PARAM = "babana.default_approach_distance_meters"
DEFAULT_APPROACH_DISTANCE_DEFAULT = 1500


@dataclass(frozen=True)
class RoadCandidate:
    driver_public_id: str
    road_distance_meters: int
    road_duration_seconds: int = 0


@dataclass(frozen=True)
class ApproachEstimate:
    distance_meters: int
    # Nombre de chauffeurs dont la moyenne est faite ; 0 = valeur de repli.
    driver_count: int
    # Durée routière brute (modèle voiture, É8) du plus proche par la route -- l'affichage
    # « Moto à ~N min » avant de commander. None : personne de mesurable.
    nearest_duration_seconds: int | None = None


def _positive_int_param(env, name: str, default: int) -> int:
    raw = env["ir.config_parameter"].sudo().get_param(name)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _road_route(env, *, driver: dict, pickup):
    """Itinéraire chauffeur -> prise en charge (distance et durée), ou None s'il n'est pas mesurable.

    Dans un savepoint : le compteur de quota est une ligne partagée, et un conflit d'écriture ici
    ne doit jamais faire échouer la transaction de la course -- il retire seulement ce chauffeur
    du classement routier. Aucun enregistrement au commit n'a lieu
    dans ce bloc (D33)."""
    try:
        with env.cr.savepoint():
            # Jamais le cache de la cotation : sa grille confond deux chauffeurs voisins
            # (routing.measure_route).
            route = routing.measure_route(
                env, origin=(float(driver["latitude"]), float(driver["longitude"])), destination=pickup
            )
        return route
    except Exception:  # noqa: BLE001 -- best effort, le repli à vol d'oiseau existe
        _logger.warning(
            "distance d'approche non mesurable pour le chauffeur %s", driver.get("driverId"), exc_info=True
        )
        return None


def road_ranked_candidates(
    env,
    *,
    pickup: tuple[float, float],
    radius_meters: int,
    exclude_driver_public_ids: list[str],
) -> list[RoadCandidate]:
    """Les plus proches disponibles, classés par distance ROUTIÈRE croissante (à égalité, l'ordre
    à vol d'oiseau). Un chauffeur dont la distance n'est pas mesurable est omis : le script de
    réservation le retrouvera par son repli à vol d'oiseau. Lève RealtimeUnavailable."""
    drivers = realtime_client.fetch_nearby_drivers(
        origin=pickup,
        radius_meters=radius_meters,
        limit=_positive_int_param(env, APPROACH_SAMPLE_SIZE_PARAM, APPROACH_SAMPLE_SIZE_DEFAULT),
        exclude_driver_public_ids=exclude_driver_public_ids,
    )
    ranked = []
    for driver in drivers:
        route = _road_route(env, driver=driver, pickup=pickup)
        if route is not None:
            ranked.append(RoadCandidate(driver["driverId"], route.distance_meters, route.duration_seconds))
    # sorted() est stable : à distance routière égale, l'ordre à vol d'oiseau du service temps réel.
    return sorted(ranked, key=lambda candidate: candidate.road_distance_meters)


def average_approach(env, *, pickup: tuple[float, float], radius_meters: int) -> ApproachEstimate:
    """Distance routière MOYENNE des chauffeurs disponibles jusqu'au point de prise en charge --
    l'entrée de la prise en charge de compute_fare. Ne lève jamais : sans aucune mesure, la
    valeur de repli paramétrée (babana.default_approach_distance_meters)."""
    try:
        candidates = road_ranked_candidates(
            env,
            pickup=pickup,
            radius_meters=radius_meters,
            exclude_driver_public_ids=[],
        )
    except realtime_client.RealtimeUnavailable:
        _logger.warning("service temps réel injoignable : distance d'approche de repli à l'estimation")
        candidates = []
    if not candidates:
        return ApproachEstimate(
            distance_meters=_positive_int_param(
                env, DEFAULT_APPROACH_DISTANCE_PARAM, DEFAULT_APPROACH_DISTANCE_DEFAULT
            ),
            driver_count=0,
        )
    total = sum(candidate.road_distance_meters for candidate in candidates)
    return ApproachEstimate(
        distance_meters=round(total / len(candidates)),
        driver_count=len(candidates),
        nearest_duration_seconds=candidates[0].road_duration_seconds,
    )
