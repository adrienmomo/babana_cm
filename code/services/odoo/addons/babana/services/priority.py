# Priorité des chauffeurs à l'affectation (demande du 19 novembre, amoa/questions/PRIORITE-2026-11-19.md).
# Remplace l'ordre « le plus proche par la route » de D78 pour les chauffeurs proches du client.
#
# Trois composantes, plafonnées ensemble à babana.priority_max_total (120) :
# - points de course : compteur STOCKÉ sur le chauffeur (babana.driver.ride_points), 100 au départ,
#   −1 à chaque proposition expirée, +1 à chaque course terminée, borné à [0, 100]. Le plafond rend
#   le compteur dépendant de l'ordre des événements : il ne se recalcule pas depuis deux comptes,
#   il est tenu à jour par les deux transitions qui écrivent déjà (invariant 1) ;
# - nouveau chauffeur : +10 pendant les 30 jours qui suivent l'approbation (approved_at) ;
# - note : moyenne des avis CLIENTS, lissée par 50 notes imaginaires de 5 ; strictement au-dessus
#   de 4,5 -> 10, strictement au-dessus de 4 -> 5, sinon 0.
#
# Ordre de sollicitation (rank_candidates, resserré le 19 novembre au soir) : un chauffeur à moins
# de babana.priority_closest_radius_meters (500 m, à vol d'oiseau) du client passe d'abord -- le plus
# proche d'entre eux en premier, la priorité ne joue pas : il est déjà là. Sinon, dans chaque cercle
# de recherche, le plus prioritaire ; à égalité, le plus proche par la route quand il a été mesuré,
# puis à vol d'oiseau. Le choix final et la réservation restent un seul script Redis (invariant 4).
#
# Tous les nombres sont des réglages (invariant 5), Paramètres > Babana > Priorité des chauffeurs.
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from odoo import fields

RIDE_POINTS_MAX_PARAM = "babana.priority_ride_points_max"
RIDE_POINTS_MAX_DEFAULT = 100
MISS_PENALTY_PARAM = "babana.priority_miss_penalty"
MISS_PENALTY_DEFAULT = 1
COMPLETION_REWARD_PARAM = "babana.priority_completion_reward"
COMPLETION_REWARD_DEFAULT = 1
NEW_DRIVER_POINTS_PARAM = "babana.priority_new_driver_points"
NEW_DRIVER_POINTS_DEFAULT = 10
NEW_DRIVER_DAYS_PARAM = "babana.priority_new_driver_days"
NEW_DRIVER_DAYS_DEFAULT = 30
STAR_HIGH_THRESHOLD_PARAM = "babana.priority_star_high_threshold"
STAR_HIGH_THRESHOLD_DEFAULT = 4.5
STAR_HIGH_POINTS_PARAM = "babana.priority_star_high_points"
STAR_HIGH_POINTS_DEFAULT = 10
STAR_MID_THRESHOLD_PARAM = "babana.priority_star_mid_threshold"
STAR_MID_THRESHOLD_DEFAULT = 4.0
STAR_MID_POINTS_PARAM = "babana.priority_star_mid_points"
STAR_MID_POINTS_DEFAULT = 5
STAR_PRIOR_COUNT_PARAM = "babana.priority_star_prior_count"
STAR_PRIOR_COUNT_DEFAULT = 50
STAR_PRIOR_VALUE_PARAM = "babana.priority_star_prior_value"
STAR_PRIOR_VALUE_DEFAULT = 5
MAX_TOTAL_PARAM = "babana.priority_max_total"
MAX_TOTAL_DEFAULT = 120
# En deçà, le plus proche gagne, quelle que soit sa priorité.
CLOSEST_RADIUS_PARAM = "babana.priority_closest_radius_meters"
CLOSEST_RADIUS_DEFAULT = 500
# Chauffeurs du cercle lus pour le classement : tous, en pratique ; la borne évite qu'un cercle
# très peuplé ne fasse lire toute la flotte à chaque commande.
CANDIDATE_LIMIT_PARAM = "babana.priority_candidate_limit"
CANDIDATE_LIMIT_DEFAULT = 50
# Reconstitution des points de course et de leur journal à l'installation
# (babana.driver._babana_rebuild_ride_points_once) : faite une fois par base.
RIDE_POINTS_REBUILT_PARAM = "babana.priority_ride_points_journal_rebuilt"


def _raw(env, name):
    raw = env["ir.config_parameter"].sudo().get_param(name)
    # Paramètre absent : get_param renvoie False, et int(False) vaudrait 0 (vu le 31 octobre).
    return None if raw is False or raw is None or raw == "" else raw


def _int_param(env, name: str, default: int, *, minimum: int = 0) -> int:
    raw = _raw(env, name)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if value >= minimum else default


def _float_param(env, name: str, default: float) -> float:
    raw = _raw(env, name)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    return value if value >= 0 else default


def ride_points_max(env) -> int:
    return _int_param(env, RIDE_POINTS_MAX_PARAM, RIDE_POINTS_MAX_DEFAULT, minimum=1)


def miss_penalty(env) -> int:
    return _int_param(env, MISS_PENALTY_PARAM, MISS_PENALTY_DEFAULT)


def completion_reward(env) -> int:
    return _int_param(env, COMPLETION_REWARD_PARAM, COMPLETION_REWARD_DEFAULT)


def closest_radius_meters(env) -> int:
    return _int_param(env, CLOSEST_RADIUS_PARAM, CLOSEST_RADIUS_DEFAULT, minimum=1)


def candidate_limit(env) -> int:
    return _int_param(env, CANDIDATE_LIMIT_PARAM, CANDIDATE_LIMIT_DEFAULT, minimum=1)


def clamp_ride_points(env, value: int) -> int:
    return max(0, min(ride_points_max(env), value))


@dataclass(frozen=True)
class Priority:
    ride_points: int
    ride_points_max: int
    new_driver_points: int
    new_driver_points_max: int
    # Fin du bonus « nouveau » ; None : pas de date d'approbation.
    new_driver_until: datetime | None
    star_points: int
    star_points_max: int
    # Moyenne lissée (avec les notes imaginaires) qui décide des points de note.
    star_average: float
    total: int
    max_total: int


def smoothed_star_average(env, *, rating_sum: float, rating_count: int) -> float:
    prior_count = _int_param(env, STAR_PRIOR_COUNT_PARAM, STAR_PRIOR_COUNT_DEFAULT)
    prior_value = _float_param(env, STAR_PRIOR_VALUE_PARAM, STAR_PRIOR_VALUE_DEFAULT)
    count = prior_count + rating_count
    if count == 0:
        return 0.0
    return (prior_count * prior_value + rating_sum) / count


def star_points(env, average: float) -> int:
    high_threshold = _float_param(env, STAR_HIGH_THRESHOLD_PARAM, STAR_HIGH_THRESHOLD_DEFAULT)
    mid_threshold = _float_param(env, STAR_MID_THRESHOLD_PARAM, STAR_MID_THRESHOLD_DEFAULT)
    # « Au-dessus » est strict : 4,5 pile donne les points du palier inférieur.
    if average > high_threshold:
        return _int_param(env, STAR_HIGH_POINTS_PARAM, STAR_HIGH_POINTS_DEFAULT)
    if average > mid_threshold:
        return _int_param(env, STAR_MID_POINTS_PARAM, STAR_MID_POINTS_DEFAULT)
    return 0


def _rating_totals(env, drivers) -> dict[int, tuple[float, int]]:
    groups = env["babana.rating"].sudo()._read_group(
        [("driver_id", "in", drivers.ids)], ["driver_id"], ["rating:sum", "__count"]
    )
    return {driver.id: (total or 0.0, count) for driver, total, count in groups}


def compute(drivers, *, now: datetime | None = None) -> dict[int, Priority]:
    """Priorité de chaque chauffeur de `drivers`, par identifiant. Une lecture des avis pour tout
    le lot. `now` : l'instant de référence du bonus « nouveau » (maintenant par défaut)."""
    env = drivers.env
    now = now or fields.Datetime.now()
    ratings = _rating_totals(env, drivers)
    points_max = ride_points_max(env)
    new_points = _int_param(env, NEW_DRIVER_POINTS_PARAM, NEW_DRIVER_POINTS_DEFAULT)
    new_days = _int_param(env, NEW_DRIVER_DAYS_PARAM, NEW_DRIVER_DAYS_DEFAULT)
    high_points = _int_param(env, STAR_HIGH_POINTS_PARAM, STAR_HIGH_POINTS_DEFAULT)
    max_total = _int_param(env, MAX_TOTAL_PARAM, MAX_TOTAL_DEFAULT, minimum=1)

    result = {}
    for driver in drivers.sudo():
        ride = max(0, min(points_max, driver.ride_points))
        until = driver.approved_at + timedelta(days=new_days) if driver.approved_at else None
        newcomer = new_points if until and now < until else 0
        rating_sum, rating_count = ratings.get(driver.id, (0.0, 0))
        average = smoothed_star_average(env, rating_sum=rating_sum, rating_count=rating_count)
        stars = star_points(env, average)
        result[driver.id] = Priority(
            ride_points=ride,
            ride_points_max=points_max,
            new_driver_points=newcomer,
            new_driver_points_max=new_points,
            new_driver_until=until,
            star_points=stars,
            star_points_max=high_points,
            star_average=average,
            total=min(max_total, ride + newcomer + stars),
            max_total=max_total,
        )
    return result


@dataclass(frozen=True)
class Candidate:
    driver_public_id: str
    beeline_meters: float
    # Distance routière mesurée (services/approach.py), ou None.
    road_meters: int | None = None


def rank_candidates(env, candidates: list[Candidate]) -> list[str]:
    """Ordre de sollicitation des `candidates` (identifiants publics) : à moins du rayon « le plus
    proche gagne », par distance ; au-delà, par priorité décroissante. Distance : par la route si
    elle a été mesurée, puis à vol d'oiseau -- c'est aussi le départage à priorité égale. Un
    candidat inconnu d'Odoo est laissé de côté : le repli à vol d'oiseau du script de réservation
    existe."""
    by_public_id = {
        driver.public_id: driver
        for driver in env["babana.driver"].sudo().search(
            [("public_id", "in", [candidate.driver_public_id for candidate in candidates])]
        )
    }
    priorities = compute(env["babana.driver"].sudo().browse([d.id for d in by_public_id.values()]))
    closest_radius = closest_radius_meters(env)

    def proximity(candidate: Candidate):
        measured = candidate.road_meters is not None
        return (0 if measured else 1, candidate.road_meters if measured else 0, candidate.beeline_meters)

    closest, others = [], []
    for candidate in candidates:
        driver = by_public_id.get(candidate.driver_public_id)
        if not driver:
            continue
        (closest if candidate.beeline_meters < closest_radius else others).append(
            (candidate, priorities[driver.id].total)
        )
    closest.sort(key=lambda entry: proximity(entry[0]))
    others.sort(key=lambda entry: (-entry[1], *proximity(entry[0])))
    return [candidate.driver_public_id for candidate, _total in closest + others]


@dataclass(frozen=True)
class StarTier:
    # Note lissée strictement au-dessus de laquelle le palier est acquis.
    above: float
    points: int
    # Le palier dont les points sont comptés : le plus haut dépassé, un seul -- les paliers ne
    # s'additionnent pas.
    applied: bool


@dataclass(frozen=True)
class StarDetail:
    points: int
    points_max: int
    smoothed_average: float
    rating_count: int
    # Moyenne des seuls avis réels ; None sans avis.
    rating_average: float | None
    prior_count: int
    prior_value: float
    tiers: list[StarTier]


def star_detail(driver) -> StarDetail:
    """Comment les points de note du chauffeur se calculent : ses avis, les notes imaginaires de
    départ, la moyenne lissée et les paliers -- ce qu'affiche « Ma priorité › Note des clients »,
    sans la liste des avis."""
    env = driver.env
    rating_sum, rating_count = _rating_totals(env, driver).get(driver.id, (0.0, 0))
    average = smoothed_star_average(env, rating_sum=rating_sum, rating_count=rating_count)
    tiers = [
        StarTier(
            above=_float_param(env, STAR_HIGH_THRESHOLD_PARAM, STAR_HIGH_THRESHOLD_DEFAULT),
            points=_int_param(env, STAR_HIGH_POINTS_PARAM, STAR_HIGH_POINTS_DEFAULT),
            applied=False,
        ),
        StarTier(
            above=_float_param(env, STAR_MID_THRESHOLD_PARAM, STAR_MID_THRESHOLD_DEFAULT),
            points=_int_param(env, STAR_MID_POINTS_PARAM, STAR_MID_POINTS_DEFAULT),
            applied=False,
        ),
    ]
    applied_index = next((index for index, tier in enumerate(tiers) if average > tier.above), None)
    tiers = [StarTier(tier.above, tier.points, index == applied_index) for index, tier in enumerate(tiers)]
    return StarDetail(
        points=star_points(env, average),
        points_max=tiers[0].points,
        smoothed_average=average,
        rating_count=rating_count,
        rating_average=(rating_sum / rating_count) if rating_count else None,
        prior_count=_int_param(env, STAR_PRIOR_COUNT_PARAM, STAR_PRIOR_COUNT_DEFAULT),
        prior_value=_float_param(env, STAR_PRIOR_VALUE_PARAM, STAR_PRIOR_VALUE_DEFAULT),
        tiers=tiers,
    )
