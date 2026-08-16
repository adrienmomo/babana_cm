# Sens Odoo -> temps réel (L3-17) : select-driver réserve et propose AVANT toute transition Odoo
# (D10 §C2a, L3-06) ; la fin de course efface le marqueur d'engagement (D26, L3-07). Authentifié
# par REALTIME_SHARED_SECRET -- même secret, même mécanisme que le canal interne prévu par L3-15
# (jamais construit ce soir, hors périmètre), pas un second à inventer.
#
# Sens temps réel -> Odoo (acceptation, refus, expiration) : PAS ici. Ce module ne porte que les
# appels dont Odoo est l'INITIATEUR -- voir controllers/internal.py pour l'autre sens, reçu plutôt
# qu'émis.
from __future__ import annotations

import logging
import os
import threading

import requests

_logger = logging.getLogger(__name__)

REALTIME_TIMEOUT_SECONDS = 5


class RealtimeUnavailable(Exception):
    """Le service temps réel est injoignable, ou répond de façon inattendue (L3-17). Ne se
    traduit JAMAIS en une transition Odoo appliquée -- controllers/ride.py n'appelle
    action_propose qu'après un succès explicite de reserve_and_propose (critère 4 : l'échec de
    l'appel au service temps réel ne laisse aucune transition Odoo appliquée)."""


def _base_url() -> str:
    return os.environ["REALTIME_INTERNAL_URL"]


def _headers() -> dict:
    return {
        "X-Realtime-Secret": os.environ["REALTIME_SHARED_SECRET"],
        "Content-Type": "application/json",
    }


def _post(path: str, payload: dict) -> dict:
    try:
        response = requests.post(
            f"{_base_url()}{path}", json=payload, headers=_headers(), timeout=REALTIME_TIMEOUT_SECONDS
        )
        response.raise_for_status()
        return response.json()
    except (requests.RequestException, ValueError) as exc:
        raise RealtimeUnavailable(f"appel au service temps réel {path} en échec") from exc


def reserve_and_propose(*, ride, driver, client_user, idempotency_key: str | None) -> dict:
    """Réserve le chauffeur et pose la proposition (L3-06, L3-07) -- avant toute transition Odoo
    (`controllers/ride.py::_select_driver`).

    **Le piège du rejeu (D25), tranché ici** : Odoo rejoue la requête HTTP entière sur conflit de
    sérialisation PostgreSQL, donc cet appel s'exécute deux fois pour une seule action cliente si
    `action_propose` échoue APRÈS que cet appel a déjà réussi. `idempotency_key` est ce qui
    protège : celle du client si l'app mobile en a fourni une (L4-03, `Idempotency-Key`), sinon
    une clé composite course + chauffeur -- les deux stables d'une exécution à l'autre du MÊME
    rejeu Odoo, puisque ni l'une ni l'autre ne dépend d'un état de base de données que le rejeu
    remettrait à zéro. Le service temps réel (`reservation/idempotency.ts`) rejoue la réponse de
    la première exécution pour cette clé plutôt que de retenter la réservation.

    Renvoie `{"outcome": "PROPOSED", "expiresAt": ...}`, `{"outcome": "DRIVER_ALREADY_TAKEN"}` ou
    `{"outcome": "DRIVER_NOT_IN_LAST_LIST"}` (précondition C-03, critère 8) -- jamais une
    exception pour un résultat métier, seulement pour une vraie panne de transport
    (RealtimeUnavailable)."""
    key = idempotency_key or f"{ride.public_id}:{driver.public_id}"
    return _post(
        "/internal/reservations",
        {
            "idempotencyKey": key,
            "rideId": ride.public_id,
            "driverId": driver.public_id,
            "clientUserId": client_user.babana_public_id,
            "origin": {"latitude": ride.pickup_latitude, "longitude": ride.pickup_longitude},
            "destination": {"latitude": ride.dropoff_latitude, "longitude": ride.dropoff_longitude},
            "amount": ride.estimated_amount,
            "distanceMeters": round((ride.reference_distance_km or 0.0) * 1000),
        },
    )


def release_reservation(*, driver_public_id: str) -> None:
    """Compensation (L3-06 critère 4, câblée par cette tâche) : la réservation a réussi côté
    temps réel mais la transition Odoo qui devait suivre a échoué (`action_propose` a levé --
    chauffeur suspendu entre-temps, course déjà annulée, ...). Sans cet appel, le chauffeur
    resterait hors du pool jusqu'à l'expiration de la réservation, sans course correspondante nulle
    part.

    Prend un identifiant public (`str`), pas un recordset `babana.driver` -- appelable depuis un
    fil d'exécution séparé (voir `notify_cancellation_async` ci-dessous), où un recordset lié au
    curseur de la transaction appelante ne serait pas sûr à utiliser.

    Best-effort, volontairement : la vraie erreur métier a déjà été déterminée par l'appelant
    (`_select_driver`) au moment où celui-ci appelle cette fonction -- une seconde panne du
    service temps réel ici ne doit jamais la masquer ni en ajouter une nouvelle. Le filet de
    dernier recours reste l'expiration naturelle de la réservation côté Redis (L3-06, critère 5)."""
    try:
        _post("/internal/reservations/release", {"driverId": driver_public_id})
    except RealtimeUnavailable:
        _logger.warning(
            "échec du relâchement de la réservation pour le chauffeur %s -- elle expirera "
            "d'elle-même (L3-06, critère 5).",
            driver_public_id,
        )


def clear_engagement(*, driver_public_id: str) -> None:
    """Fin de course (L3-17, critère 6) : efface le marqueur d'engagement côté temps réel --
    sans lui, le chauffeur ne revient jamais dans le pool (D26, l'engagement n'expire jamais tout
    seul, délibérément). Même remarque que release_reservation sur `driver_public_id`.

    Best-effort, même raisonnement que release_reservation ci-dessus : la fin de course reste
    appliquée côté Odoo même si cet appel échoue. La réconciliation périodique
    (`driver/reconcile.ts`, critère 7) reste le filet si ce message ne parvient jamais au service
    temps réel."""
    try:
        _post("/internal/engagement/clear", {"driverId": driver_public_id})
    except RealtimeUnavailable:
        _logger.warning(
            "échec de l'effacement de l'engagement pour le chauffeur %s -- la réconciliation "
            "périodique corrigera l'écart (L3-17, critère 7).",
            driver_public_id,
        )


def notify_cancellation_async(driver_public_id: str) -> None:
    """Annulation (L3-17) : relâche la réservation ET efface l'engagement, en tâche de fond.

    Contrairement à `reserve_and_propose` (qui gate la transition, donc doit être attendu) et à
    `clear_engagement` appelé depuis `_complete_ride` (où rien d'autre ne se dispute la latence),
    la réponse de `/cancel` n'a besoin d'attendre ni l'un ni l'autre : la transition Odoo est déjà
    appliquée quand cette fonction est appelée, et retarder la réponse au client le temps de deux
    appels HTTP internes n'apporterait rien -- seulement une latence perceptible sans bénéfice
    pour lui. Fil démon (`daemon=True`) : ne doit jamais empêcher le processus de se terminer, et
    n'a besoin d'aucune synchronisation avec le fil appelant (best-effort des deux côtés)."""
    threading.Thread(
        target=lambda: (release_reservation(driver_public_id=driver_public_id), clear_engagement(driver_public_id=driver_public_id)),
        daemon=True,
    ).start()
