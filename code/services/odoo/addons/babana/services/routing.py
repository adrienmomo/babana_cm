# Distance de référence auprès de l'API de routage (L2-05), avec cache par paire de zones.
#
# É8 -- ASSUMÉ ET DÉLIBÉRÉ : la distance et la durée renvoyées par ce point de calcul sont
# celles d'un itinéraire VOITURE. Ni Google ni Mapbox n'activent de routage deux-roues au
# Cameroun. Ne JAMAIS « corriger » en sommant les points GPS du tracé réellement parcouru --
# cela casserait la reproductibilité des factures (une facture doit rester rejouable à
# l'identique six mois plus tard, amoa/specs/L2-tarification.md, L2-05).
#
# D19 : on simule le fournisseur, jamais notre logique. GOOGLE_ROUTING_URL pointe vers
# mock-maps en développement (services/mocks/maps, L0-08, valeur posée par
# infra/compose.dev.yaml), une vraie API de routage en production -- ce module ne contient
# aucune branche conditionnelle sur l'environnement.
#
# D43 retournée (amoa/questions/REPONSES-2026-09-06.md §2) : plus de valeur par défaut vers le
# simulateur. Une adresse de fournisseur externe non configurée doit échouer bruyamment (comme
# GOOGLE_JWKS_URL, google_identity.py::_jwks_url), jamais retomber silencieusement sur mock-maps
# -- un défaut qui ne se verrait qu'en regardant le trafic réseau.
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime

import requests
from odoo import fields

_logger = logging.getLogger(__name__)

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
    """L'API de routage est indisponible ET aucune entrée de cache -- fraîche ou périmée (D24)
    -- n'existe pour ce trajet : à traduire en ROUTE_UNAVAILABLE (catalogue C-01) par le
    contrôleur (controllers/quote.py). Ne jamais dégrader en distance à vol d'oiseau : une
    estimation fausse est pire qu'une absence d'estimation (critère d'acceptation 3). Mais une
    entrée périmée n'est pas une estimation dégradée -- voir get_reference_route ci-dessous."""


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
    routage, pose une nouvelle entrée, et comptabilise l'appel pour le suivi de quota.

    Si l'API échoue (D24, amoa/questions/REPONSES-2026-08-15.md §5) : sert l'entrée PÉRIMÉE de
    la même clé si elle existe -- ce n'est pas une estimation dégradée, elle a été calculée par
    la vraie API sur les vrais points, seule sa fraîcheur a expiré, et un itinéraire de Douala ne
    change pas de longueur en trois heures. Journalisé, jamais silencieux. Lève RouteUnavailable
    seulement si rien n'a jamais été calculé pour ce trajet -- jamais d'estimation dégradée
    silencieuse dans ce cas (distance à vol d'oiseau, critère d'acceptation 3)."""
    key = cache_key(
        origin=origin, destination=destination, vehicle_class=vehicle_class, at_datetime=at_datetime
    )
    cache_model = env["babana.route.cache"].sudo()
    cached = cache_model._get_fresh(key)
    if cached:
        return RouteResult(cached.distance_meters, cached.duration_seconds, cached.polyline or "")

    try:
        result = _fetch_from_api(origin=origin, destination=destination)
    except RouteUnavailable:
        stale = cache_model._get_any(key)
        if not stale:
            raise
        _logger.warning(
            "API de routage indisponible : repli sur l'entrée de cache périmée %s "
            "(expirée depuis %s, D24).",
            key, stale.expires_at,
        )
        return RouteResult(stale.distance_meters, stale.duration_seconds, stale.polyline or "")

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


def _routing_url() -> str:
    """Adresse de l'API de routage -- plus de repli implicite vers mock-maps si la variable est
    absente (D43 retournée). Non configurée, on échoue ici plutôt que d'appeler silencieusement
    un simulateur (ou pire, un fournisseur réel) avec un destinataire différent de l'attendu."""
    url = os.environ.get("GOOGLE_ROUTING_URL")
    if not url:
        raise RuntimeError("GOOGLE_ROUTING_URL n'est pas configurée")
    return url


def _fetch_from_api(*, origin, destination) -> RouteResult:
    routing_url = _routing_url()
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
    justifier un modèle dédié.

    Incrémenté en UNE instruction SQL (UPSERT), jamais par une lecture ORM (get_param) suivie
    d'une écriture (set_param) : c'est exactement cette dernière forme qui, sous
    REPEATABLE READ, réécrit une ligne globale à chaque cotation et produit le
    SerializationFailure que L4-11 a trouvé sur les courses -- ici rejoué à chaque estimation
    (amoa/questions/REPONSES-2026-08-15.md §4). Le suivi d'un quota ne doit jamais faire échouer
    une cotation. Une seule instruction UPDATE (via l'UPSERT) verrouille la ligne le temps de la
    modifier plutôt que de détecter un conflit au commit : les appels concurrents se sérialisent
    par attente de verrou, aucun n'échoue."""
    param_model = env["ir.config_parameter"].sudo()
    count_key = f"babana.routing_quota_count_{fields.Date.today().isoformat()}"
    # flush avant de s'appuyer sur la contrainte SQL "key_uniq" (ON CONFLICT) -- même règle que
    # code/docs/odoo-pitfalls.md : tout code qui s'appuie sur une contrainte au niveau base doit
    # provoquer le vidage avant de la déclencher.
    param_model.flush_model(["key", "value"])
    env.cr.execute(
        """
        INSERT INTO ir_config_parameter (key, value)
        VALUES (%s, '1')
        ON CONFLICT (key) DO UPDATE
        SET value = (ir_config_parameter.value::integer + 1)::text
        RETURNING value::integer
        """,
        (count_key,),
    )
    count = env.cr.fetchone()[0]
    # ir.config_parameter.get_param() est mis en cache par clé (ormcache) ; create()/write()/
    # unlink() de ce modèle invalident ce cache via env.registry.clear_cache() -- notre INSERT
    # brut le contourne, donc on invalide nous-mêmes, au même endroit que le ferait l'ORM.
    env.registry.clear_cache()

    quota = int(param_model.get_param(QUOTA_PARAM, QUOTA_DEFAULT))
    alert_ratio = float(param_model.get_param(QUOTA_ALERT_RATIO_PARAM, QUOTA_ALERT_RATIO_DEFAULT))
    if quota > 0 and count >= quota * alert_ratio:
        _logger.warning(
            "Quota de routage à %s/%s appels aujourd'hui (seuil d'alerte %.0f%%).",
            count, quota, alert_ratio * 100,
        )
