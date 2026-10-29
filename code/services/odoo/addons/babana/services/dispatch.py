# La course part au chauffeur disponible le plus proche -- le serveur choisit, jamais le client
# (le choix par le client, D10, et la resélection manuelle après un refus, D11, sont retirés).
#
# Partage des rôles :
# - le service temps réel CHOISIT et RÉSERVE, en un seul geste atomique, le plus proche dans le
#   vivier : c'est lui qui connaît les positions (invariant 1), et le choix suivi d'une réservation
#   séparée laisserait deux courses prendre le même chauffeur (invariant 4) ;
# - « le plus proche » s'entend PAR LA ROUTE (demande produit du 26 octobre) : Odoo mesure la
#   distance routière des plus proches à vol d'oiseau (services/approach.py) et transmet ce
#   classement ; le script de réservation l'essaie dans l'ordre, puis se replie sur le vol
#   d'oiseau -- un routage indisponible dégrade le choix, jamais l'affectation ;
# - Odoo décide QUI ÉCARTER (les chauffeurs déjà sollicités dans le tour en cours), QUAND S'ARRÊTER
#   (babana.dispatch_max_attempts) et DANS QUEL RAYON chercher (babana.dispatch_radius_meters) --
#   des règles métier, réglables dans Paramètres > Babana (invariant 5).
#
# Un « tour » commence à chaque commande du client (ou « Réessayer ») ; après chaque refus ou
# expiration, le suivant est sollicité automatiquement, dans la même transaction que le refus, tant
# que le tour n'a pas atteint son maximum. Ensuite, ou s'il n'y a plus personne, la course reste
# `rejected` et le client reçoit `ride.unmatched` (au commit).
#
# Les écritures restent bornées par des événements métier (invariant 1) : une proposition par
# commande, puis au plus une par refus ou expiration, et jamais plus que le maximum par tour.
from __future__ import annotations

import logging

from odoo.exceptions import UserError
from odoo.service.model import PG_CONCURRENCY_EXCEPTIONS_TO_RETRY

from . import approach, realtime_client

_logger = logging.getLogger(__name__)

DISPATCH_RADIUS_PARAM = "babana.dispatch_radius_meters"
DISPATCH_RADIUS_DEFAULT = 5000
DISPATCH_MAX_ATTEMPTS_PARAM = "babana.dispatch_max_attempts"
DISPATCH_MAX_ATTEMPTS_DEFAULT = 3


def _positive_int_param(env, name: str, default: int) -> int:
    raw = env["ir.config_parameter"].sudo().get_param(name)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _current_round_rejections(ride):
    return ride.rejection_ids.sorted("id")[ride.dispatch_round_rejection_offset :]


def _client_user(env, ride):
    return env["res.users"].sudo().search([("partner_id", "=", ride.client_id.id)], limit=1)


def _reserve_and_propose(env, ride, *, exclude, idempotency_key, new_round):
    """Demande au service temps réel le plus proche (par la route) hors `exclude`, puis écrit la
    transition. Renvoie le chauffeur, ou un recordset vide si personne."""
    radius_meters = _positive_int_param(env, DISPATCH_RADIUS_PARAM, DISPATCH_RADIUS_DEFAULT)
    reservation = realtime_client.reserve_nearest_and_propose(
        ride=ride,
        client_user=_client_user(env, ride),
        radius_meters=radius_meters,
        exclude_driver_public_ids=exclude,
        idempotency_key=idempotency_key,
        preferred_driver_public_ids=_road_ranking(env, ride, radius_meters=radius_meters, exclude=exclude),
    )
    outcome = reservation.get("outcome")
    if outcome == "NO_DRIVER_AVAILABLE":
        return env["babana.driver"]
    if outcome != "PROPOSED":
        raise realtime_client.RealtimeUnavailable(f"réponse inattendue du service temps réel : {outcome!r}")

    driver = env["babana.driver"].sudo().search([("public_id", "=", reservation.get("driverId"))], limit=1)
    try:
        if not driver:
            raise realtime_client.RealtimeUnavailable("chauffeur réservé inconnu d'Odoo")
        ride.sudo().action_propose(by_partner=ride.client_id, driver=driver, new_round=new_round)
    except PG_CONCURRENCY_EXCEPTIONS_TO_RETRY:
        # D25 : Odoo rejoue la requête entière ; la réservation doit survivre au rejeu, qui la
        # retrouvera par la même clé d'idempotence -- la relâcher ici la perdrait.
        raise
    except Exception:
        # Transition refusée définitivement : sans compensation, le chauffeur resterait hors du
        # vivier jusqu'à l'expiration de la réservation, sans course nulle part (L3-06, critère 4).
        realtime_client.release_reservation(driver_public_id=reservation.get("driverId"))
        raise
    return driver


def _road_ranking(env, ride, *, radius_meters, exclude) -> list[str]:
    """Classement routier des candidats (services/approach.py). Vide si le service temps réel ne
    répond pas à la lecture : la réservation qui suit tranchera (et lèvera si la panne persiste)."""
    try:
        candidates = approach.road_ranked_candidates(
            env,
            pickup=(ride.pickup_latitude, ride.pickup_longitude),
            radius_meters=radius_meters,
            exclude_driver_public_ids=list(exclude),
        )
    except realtime_client.RealtimeUnavailable:
        _logger.warning("classement routier impossible pour la course %s : vol d'oiseau", ride.public_id)
        return []
    return [candidate.driver_public_id for candidate in candidates]


def propose_to_closest_driver(env, ride, *, by_partner, idempotency_key=None):
    """Commande du client (ou « Réessayer ») : ouvre un tour et propose la course au chauffeur
    disponible le plus proche. Renvoie ce chauffeur, ou un recordset vide si personne dans le
    rayon -- la course reste alors dans son état (requested ou rejected).

    L'appartenance est vérifiée AVANT tout appel au service temps réel. L'état, lui, ne l'est
    délibérément pas ici mais par la transition, APRÈS : sous le rejeu d'Odoo (D25), la tentative
    perdante de deux commandes concurrentes retrouve par sa clé le chauffeur que sa première
    tentative avait réservé -- c'est le refus de la transition qui le fait relâcher. Un contrôle
    d'état en amont court-circuiterait ce relâchement et laisserait ce chauffeur réservé, avec une
    proposition reçue, pour une course qui n'est pas la sienne."""
    from ..models.babana_ride_state import RideInvalidTransition

    ride = ride.sudo()
    if by_partner != ride.client_id:
        raise RideInvalidTransition("Ce client n'est pas partie à cette course.")

    # Clé stable à travers un rejeu Odoo de la même requête (D25) : celle du client s'il en a
    # fourni une, sinon la course et son nombre de refus -- inchangés par un rejeu, distincts d'un
    # tour à l'autre.
    key = idempotency_key or f"{ride.public_id}:round:{len(ride.rejection_ids)}"
    return _reserve_and_propose(env, ride, exclude=[], idempotency_key=key, new_round=True)


def handle_driver_rejection(env, ride, driver, *, reason, expired):
    """Refus ou expiration (canal interne, controllers/internal.py) : enregistre le refus, puis
    sollicite automatiquement le suivant du tour -- ou prévient le client qu'il n'y a plus personne.

    Le refus s'écrit quoi qu'il arrive ensuite : une panne du service temps réel pendant la
    recherche du suivant ne doit pas laisser la course bloquée en `proposed` sur un chauffeur qui a
    dit non. Le client est alors prévenu et peut réessayer."""
    ride = ride.sudo()
    ride.action_reject(by_driver=driver, reason=reason, expired=expired)

    max_attempts = _positive_int_param(env, DISPATCH_MAX_ATTEMPTS_PARAM, DISPATCH_MAX_ATTEMPTS_DEFAULT)
    round_rejections = _current_round_rejections(ride)
    next_driver = env["babana.driver"]
    if len(round_rejections) < max_attempts:
        try:
            next_driver = _reserve_and_propose(
                env,
                ride,
                exclude=round_rejections.mapped("driver_id.public_id"),
                # Stable à travers un rejeu (le refus vient d'être compté), distincte à chaque refus.
                idempotency_key=f"{ride.public_id}:auto:{len(ride.rejection_ids)}",
                new_round=False,
            )
        except (realtime_client.RealtimeUnavailable, UserError):
            # Service injoignable, ou chauffeur choisi refusé par la transition (suspendu entre-
            # temps, déjà pris -- la réservation a alors été relâchée) : le refus reste écrit.
            _logger.warning(
                "recherche du chauffeur suivant impossible pour la course %s -- le client est "
                "prévenu qu'aucun chauffeur n'est disponible.",
                ride.public_id,
            )

    if not next_driver:
        realtime_client.notify_ride_unmatched(
            env,
            ride_public_id=ride.public_id,
            client_user_public_id=ride._babana_client_public_id(),
        )
    return next_driver
