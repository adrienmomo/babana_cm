# Sens Odoo -> temps réel (L3-17) : select-driver réserve et propose AVANT toute transition Odoo
# (D10 §C2a, L3-06) ; la fin de course efface le marqueur d'engagement (D26, L3-07). Authentifié
# par REALTIME_SHARED_SECRET -- même secret, même mécanisme que le canal interne prévu par L3-15
# (jamais construit, hors périmètre), pas un second à inventer.
#
# D32 (amoa/questions/REPONSES-2026-08-18.md §4) : tout appel d'ici déclenché APRÈS une transition
# Odoo (clear_engagement, notify_cancellation_async) part au commit de la transaction appelante,
# jamais pendant -- voir leurs docstrings. Seul reserve_and_propose fait exception, et le reste :
# il PRÉCÈDE délibérément la transition, puisque c'est son résultat qui l'autorise (controllers/
# ride.py::_select_driver) ; c'est pour cela que son idempotence (D25) a été construite.
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


def _clear_engagement_now(driver_public_id: str) -> None:
    """L'appel HTTP réel, best-effort : la fin de course reste appliquée côté Odoo même si cet
    appel échoue, la réconciliation périodique (`driver/reconcile.ts`, critère 7) reste le filet.

    Jamais appelée directement depuis un contrôleur -- toujours derrière un point d'accroche au
    commit (D32) : `clear_engagement()` ci-dessous pour la fin de course, ou le fil de fond de
    `notify_cancellation_async()` (déjà après le commit, voir sa docstring)."""
    try:
        _post("/internal/engagement/clear", {"driverId": driver_public_id})
    except RealtimeUnavailable:
        _logger.warning(
            "échec de l'effacement de l'engagement pour le chauffeur %s -- la réconciliation "
            "périodique corrigera l'écart (L3-17, critère 7).",
            driver_public_id,
        )


def clear_engagement(env, *, driver_public_id: str) -> None:
    """Fin de course (L3-17, critère 6) : efface le marqueur d'engagement côté temps réel --
    sans lui, le chauffeur ne revient jamais dans le pool (D26, l'engagement n'expire jamais tout
    seul, délibérément).

    **D32** (amoa/questions/REPONSES-2026-08-18.md §4) : appelée au COMMIT de la transaction
    Odoo, jamais pendant -- même défaut que `notify_cancellation_async` avant sa correction, en
    plus doux (la réconciliation le rattrape en vingt secondes ; pour l'annulation, il n'y a que
    le TTL de réservation, quarante-cinq secondes, et rien du tout pour l'engagement). Prend
    `env` explicitement : c'est `env.cr.postcommit` qui porte le point d'accroche, pas un détail
    laissé à la discrétion de chaque appelant."""
    env.cr.postcommit.add(lambda: _clear_engagement_now(driver_public_id=driver_public_id))


def notify_cancellation_async(env, driver_public_id: str) -> None:
    """Annulation (L3-17, D32) : relâche la réservation ET efface l'engagement, en tâche de fond
    -- déclenchée au COMMIT de la transaction Odoo, jamais pendant.

    **D32** (amoa/questions/REPONSES-2026-08-18.md §4) : ce fil démon a longtemps démarré pendant
    la transaction d'annulation. Il répond correctement à la question de la latence -- la réponse
    de `/cancel` n'a besoin d'attendre ni le relâchement ni l'effacement, la transition Odoo est
    déjà appliquée quand cette fonction est appelée. Il ne répond pas du tout à celle de
    l'atomicité : si la transaction échoue au commit (D25, rejouée ou finalement annulée), Redis
    avait déjà été modifié pour une annulation qui n'a pas eu lieu -- le chauffeur revient au pool
    avec une course toujours vivante. `env.cr.postcommit` est le point d'accroche qu'Odoo fournit
    pour ça : le fil démon ne le remplace pas, il n'a jamais répondu à la même question.

    `env.cr.postcommit.add(...)` n'exécute son callback qu'après un COMMIT réellement réussi --
    jamais après un ROLLBACK (`sql_db.py::Cursor.rollback` vide `postcommit` sans l'exécuter) --
    et jamais dans un test `TransactionCase`/`HttpCase` dont la transaction n'est jamais vraiment
    commitée (`TestCursor.commit` : "TestCursor ignores post-commit hooks by default")."""
    env.cr.postcommit.add(
        lambda: threading.Thread(
            target=lambda: (release_reservation(driver_public_id=driver_public_id), _clear_engagement_now(driver_public_id=driver_public_id)),
            daemon=True,
        ).start()
    )
