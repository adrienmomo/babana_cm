# Sens Odoo -> temps réel (L3-17) : select-driver réserve et propose AVANT toute transition Odoo
# (D10 §C2a, L3-06) ; la fin de course efface le marqueur d'engagement (D26, L3-07). Authentifié
# par REALTIME_SHARED_SECRET -- même secret, même mécanisme que le canal interne prévu par L3-15
# (jamais construit, hors périmètre), pas un second à inventer.
#
# D32 (amoa/questions/REPONSES-2026-08-18.md §4) : tout appel d'ici déclenché APRÈS une transition
# Odoo (clear_engagement, notify_cancellation_async, notify_cash_limit_reached) part au commit de
# la transaction appelante, jamais pendant -- voir leurs docstrings. Seul reserve_and_propose fait
# exception, et le reste : il PRÉCÈDE délibérément la transition, puisque c'est son résultat qui
# l'autorise (controllers/ride.py::_select_driver) ; c'est pour cela que son idempotence (D25) a
# été construite.
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


def _notify_cash_limit_reached_now(driver_public_id: str) -> None:
    try:
        _post("/internal/drivers/cash-blocked", {"driverId": driver_public_id})
    except RealtimeUnavailable:
        _logger.warning(
            "échec du signalement de plafond d'encaisse pour le chauffeur %s -- il pourrait "
            "rester visible jusqu'à la prochaine tentative (L5-02).",
            driver_public_id,
        )


def notify_cash_limit_reached(env, *, driver_public_id: str) -> None:
    """Plafond d'encaisse franchi (D8, D28, L5-02) : signale au service temps réel qu'il doit
    retirer ce chauffeur du pool ET refuser toute acceptation déjà en vol pour lui -- les deux
    points de blocage que la spécification exige, tous deux obligatoires (une proposition émise
    juste avant le franchissement resterait sinon acceptable). Appelée par
    `babana_ride_state.py::action_settle`, APRÈS la sortie réussie de son savepoint -- jamais
    depuis `babana.driver._babana_apply_cash_limit` elle-même, qui se contente d'écrire
    `is_online` et de renvoyer si le plafond a été franchi (D33, amoa/questions/
    REPONSES-2026-08-19.md §2) : `cr.postcommit` ignore les savepoints, un appel enregistré à
    l'intérieur y survivrait même si ce savepoint précis était annulé.

    **D32** : au COMMIT, jamais pendant -- même raisonnement que `clear_engagement` : la
    disponibilité future de ce chauffeur ne doit changer côté temps réel que si le franchissement
    est réellement acté côté Odoo (une transaction d'encaissement rejouée ou annulée n'a pas fait
    franchir quoi que ce soit)."""
    env.cr.postcommit.add(lambda: _notify_cash_limit_reached_now(driver_public_id=driver_public_id))


def _notify_cash_limit_cleared_now(driver_public_id: str) -> None:
    try:
        _post("/internal/drivers/cash-unblocked", {"driverId": driver_public_id})
    except RealtimeUnavailable:
        _logger.warning(
            "échec du dé-blocage de plafond d'encaisse pour le chauffeur %s -- il resterait "
            "invisible jusqu'à la prochaine tentative (L5-04).",
            driver_public_id,
        )


def notify_cash_limit_cleared(env, *, driver_public_id: str) -> None:
    """Remise de caisse validée, le chauffeur repasse sous le plafond (D8, L5-04, critère
    d'acceptation 5) : symétrique de `notify_cash_limit_reached` -- retire la clé de blocage
    côté temps réel (`cash-guard.ts::unblockForCash`, exportée depuis L5-02 spécifiquement pour
    cet appel) et réintègre le chauffeur au pool géo-indexé s'il redevient éligible (même
    fonction que `clear_engagement`, `reintegrateIfEligible`, jamais un ajout inconditionnel).
    Ne remet jamais `is_online` à vrai côté temps réel ou Odoo -- le blocage retire une
    disponibilité, le lever n'en recrée pas une : le chauffeur redevient visible seulement s'il
    repasse en ligne lui-même.

    Appelée par `babana_cash_remittance.py::action_validate`, APRÈS la sortie réussie de son
    savepoint -- même discipline D33 que `notify_cash_limit_reached`.

    **D32** : au COMMIT, jamais pendant -- une validation rejouée ou finalement annulée n'a pas
    réellement fait repasser le chauffeur sous le plafond."""
    env.cr.postcommit.add(lambda: _notify_cash_limit_cleared_now(driver_public_id=driver_public_id))


def _notify_ride_started_now(*, ride_public_id: str, client_user_public_id: str, driver_public_id: str) -> None:
    try:
        _post(
            "/internal/rides/started",
            {
                "rideId": ride_public_id,
                "clientUserId": client_user_public_id,
                "driverId": driver_public_id,
            },
        )
    except RealtimeUnavailable:
        _logger.warning(
            "échec de la notification ride.started pour la course %s -- le client ne verra pas "
            "le démarrage tant qu'il ne resynchronise pas (L3-11, session.resync).",
            ride_public_id,
        )


def notify_ride_started(env, *, ride_public_id: str, client_user_public_id: str, driver_public_id: str) -> None:
    """Démarrage de course (L3-19, assigned -> in_progress) : pousse `ride.started` (C-02) au
    client déjà abonné (`ride.track`, L3-09) et au chauffeur -- même message, deux destinataires
    (spécification L3-19 : "c'est le même message poussé à deux abonnés différents", même
    raisonnement que `ride.cancelled`, server-to-client.ts). Best-effort, comme les autres appels
    de ce module : la transition Odoo reste appliquée même si cette notification échoue, il n'y a
    ici aucun état à réconcilier (contrairement à l'engagement) -- un client qui rate ce message
    précis retrouve l'état réel à sa prochaine resynchronisation (L3-11) ou à la diffusion
    suivante de `driver.position` qui, elle, continue sans interruption.

    **D32** : au COMMIT, jamais pendant -- une transition annulée ou rejouée (D25) ne doit pas
    avoir déjà annoncé au client que sa course avait démarré. **D33** : `action_start`
    (babana_ride_state.py) ne porte aujourd'hui aucun savepoint (vérifié dans le code, pas
    supposé) -- rien à protéger ici, l'appel est enregistré directement après l'écriture."""
    env.cr.postcommit.add(
        lambda: _notify_ride_started_now(
            ride_public_id=ride_public_id,
            client_user_public_id=client_user_public_id,
            driver_public_id=driver_public_id,
        )
    )


def _notify_ride_completed_now(
    *,
    ride_public_id: str,
    client_user_public_id: str,
    driver_public_id: str,
    distance_meters: int,
    duration_seconds: int,
    amount: float,
    breakdown: dict,
) -> None:
    try:
        _post(
            "/internal/rides/completed",
            {
                "rideId": ride_public_id,
                "clientUserId": client_user_public_id,
                "driverId": driver_public_id,
                "distanceMeters": distance_meters,
                "durationSeconds": duration_seconds,
                "amount": amount,
                "breakdown": breakdown,
            },
        )
    except RealtimeUnavailable:
        _logger.warning(
            "échec de la notification ride.completed pour la course %s -- le résumé de fin "
            "reste inatteignable pour ce client tant qu'il ne resynchronise pas (L3-11).",
            ride_public_id,
        )


def notify_ride_completed(
    env,
    *,
    ride_public_id: str,
    client_user_public_id: str,
    driver_public_id: str,
    distance_meters: int,
    duration_seconds: int,
    amount: float,
    breakdown: dict,
) -> None:
    """Fin de course (L3-19, in_progress -> completed) : pousse `ride.completed` (C-02, D41) au
    client et au chauffeur -- `breakdown` est le détail décomposé GELÉ à la création de la course
    (fare_rule_snapshot, L2-04), jamais recalculé (D41 : "le résumé de fin doit être ce que le
    serveur a écrit"), construit par l'appelant via `services.pricing.round_breakdown_for_wire`.

    Sans lien avec `clear_engagement` (L3-17, appelé séparément par le contrôleur après
    `action_complete`) : cette notification ne touche aucun état Redis, elle ne fait que pousser
    -- D31, "cet émetteur notifie, il ne transitionne rien". Elle ne dépend donc pas de l'ordre
    d'enregistrement des deux appels postcommit, contrairement à ce qu'aurait exigé une
    implémentation qui serait passée par la session de suivi (`tracking/session.ts`) pour
    retrouver les destinataires.

    **D32** : au COMMIT, jamais pendant. **D33** : `action_complete` ne porte aujourd'hui aucun
    savepoint (vérifié dans le code, pas supposé -- contrairement à ce que le lot de nuit
    supposait ; voir amoa/rapport-nuit-J19.md) -- rien à protéger, l'appel est enregistré
    directement après l'écriture."""
    env.cr.postcommit.add(
        lambda: _notify_ride_completed_now(
            ride_public_id=ride_public_id,
            client_user_public_id=client_user_public_id,
            driver_public_id=driver_public_id,
            distance_meters=distance_meters,
            duration_seconds=duration_seconds,
            amount=amount,
            breakdown=breakdown,
        )
    )
