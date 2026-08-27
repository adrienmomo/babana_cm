# Endpoints du cycle de vie de la course (L4-03, C-01 ride.ts). Traduit HTTP en appel de méthode
# de transition, rien de plus (invariant 3) -- toute condition métier vit dans
# babana_ride_state.py ; une condition écrite ici serait contournée par le back-office, qui
# appelle les méthodes de transition directement.
#
# D31 (amoa/questions/REPONSES-2026-08-18.md §3) : accept et reject n'ont plus de route ici.
# Acceptation et refus n'ont qu'un chemin d'écriture -- proposal.accept / proposal.reject en temps
# réel (C-02), résolus atomiquement côté service temps réel puis écrits dans Odoo par le canal
# interne (controllers/internal.py::driver_accepted/driver_rejected) -- jamais un second chemin
# HTTP public qui ignorerait la réservation. rateRide reste hors de portée (babana.rating, L4-09,
# hors de ce lot).
from __future__ import annotations

import logging
from datetime import timedelta

from odoo import http
from odoo.exceptions import UserError
from odoo.http import request
from odoo.service.model import PG_CONCURRENCY_EXCEPTIONS_TO_RETRY

from . import _common
from ..models.babana_ride_state import RideInvalidTransition
from ..services import realtime_client

_logger = logging.getLogger(__name__)

# readonly=False explicite : auth='none' est en lecture seule par défaut depuis Odoo 18
# (code/docs/odoo-pitfalls.md) -- les cinq endpoints ci-dessous écrivent tous.
_ROUTE = {"type": "http", "auth": "none", "methods": ["POST"], "csrf": False, "readonly": False}


def _summary(ride) -> dict:
    return {
        "id": ride.public_id,
        "state": ride.state,
        "origin": {"latitude": ride.pickup_latitude, "longitude": ride.pickup_longitude},
        "destination": {"latitude": ride.dropoff_latitude, "longitude": ride.dropoff_longitude},
        # final_amount une fois completed ; jusque-là l'estimé gelé à la création (L2-04/
        # L4-03R), pas 0 -- corrigé en implémentant L4-03R (createRideResponseExample, C-01,
        # montre déjà amount=1200 sur une course à l'état 'requested').
        "amount": round(ride.final_amount or ride.estimated_amount or 0),
        "currency": "XAF",
        "createdAt": _common.iso_datetime(ride.create_date),
        "assignedDriverId": ride.driver_id.public_id if ride.driver_id else None,
    }


def _map_user_error(message: str) -> tuple[str, int]:
    """Les deux UserError "littérales" que les méthodes de transition peuvent lever en dehors
    de RideInvalidTransition, documentées comme telles à leur point de levée
    (babana_ride_state.py) précisément pour cette traduction (L4-02R2, L4-02.md)."""
    if message == "DRIVER_ALREADY_TAKEN":
        return "DRIVER_ALREADY_TAKEN", 409
    if message == "SETTLEMENT_AMOUNT_MISMATCH":
        # 409, pas 400 : la forme de la requête est valide, c'est son contenu qui ne correspond
        # plus au dû calculé côté serveur -- même famille que DRIVER_ALREADY_TAKEN (ce que
        # l'appelant croyait vrai a changé entre-temps), pas une erreur de saisie.
        return "SETTLEMENT_AMOUNT_MISMATCH", 409
    if "chauffeur approuvé" in message:
        return "DRIVER_NOT_APPROVED", 403
    return "VALIDATION_ERROR", 400


class RideController(http.Controller):
    def _dispatch(self, endpoint: str, handler):
        try:
            # C-01R (amoa/questions/C-01.md) : réservation atomique de la clé d'idempotence
            # AVANT tout appel à `handler`, pas une lecture de cache suivie d'une exécution
            # conditionnelle -- voir _common.claim_idempotency_slot pour la fenêtre de
            # concurrence que l'ancienne version laissait ouverte.
            payload, status = _common.run_idempotent(endpoint, handler)
            return _common.json_response(payload, status)
        except _common.AuthenticationFailed as exc:
            return _common.error_response(exc.code, "authentification requise", exc.status)
        except RideInvalidTransition as exc:
            return _common.error_response("RIDE_INVALID_TRANSITION", str(exc), 409)
        except UserError as exc:
            code, status = _map_user_error(str(exc))
            return _common.error_response(code, str(exc), status)
        except PG_CONCURRENCY_EXCEPTIONS_TO_RETRY:
            # D25 (amoa/questions/REPONSES-2026-08-16.md, amoa/questions/L4-02.md point 5) :
            # SerializationFailure (et ses cousines LockNotAvailable, DeadlockDetected) ne sont
            # PAS des erreurs métier -- ni ici, ni dans babana_ride_state.py::_lock_for_update,
            # qui les laisse volontairement remonter telles quelles. Les avaler ici en
            # INTERNAL_ERROR les cacherait à `odoo.service.model.retrying`, qui enveloppe déjà
            # tout appel de contrôleur et rejoue la requête entière avec un curseur neuf --
            # exactement le rejeu "depuis un instantané neuf" que D25 demande, à un niveau où il
            # peut réellement fonctionner (sous REPEATABLE READ, rejouer dans la même
            # transaction ne rafraîchit jamais l'instantané -- vérifié empiriquement).
            raise
        except Exception:
            _logger.exception("erreur interne dans %s", endpoint)
            return _common.error_response("INTERNAL_ERROR", "erreur interne", 500)

    def _find_ride(self, env, ride_id):
        return env["babana.ride"].sudo().search([("public_id", "=", ride_id)], limit=1)

    # --- POST /rides (createRide, L4-03R) ------------------------------------------------------

    @http.route("/api/v1/rides", **_ROUTE)
    def create_ride(self, **_kwargs):
        return self._dispatch("createRide", self._create_ride)

    def _create_ride(self):
        env, user = _common.authenticated_user()
        body = _common.parse_json_body()
        quote_id = (body or {}).get("quoteId")
        if not quote_id:
            return _common.error_payload("VALIDATION_ERROR", "quoteId est requis"), 400

        # Un client ne peut référencer que sa propre estimation -- traité comme "introuvable",
        # pas comme un défaut d'appartenance distinct : le catalogue de createRide (C-01) ne
        # prévoit que QUOTE_EXPIRED et QUOTE_NOT_FOUND, pas de RIDE_NOT_OWNED équivalent pour
        # une estimation.
        quote = env["babana.quote"].sudo().search(
            [("public_id", "=", quote_id), ("client_id", "=", user.partner_id.id)], limit=1
        )
        if not quote:
            return _common.error_payload("QUOTE_NOT_FOUND", "estimation inconnue"), 404
        if quote.is_expired():
            return _common.error_payload(
                "QUOTE_EXPIRED", "l'estimation a expiré ; en redemander une"
            ), 410

        # La course référence l'estimation plutôt que de recalculer (L2-04, L4-03R) : c'est ce
        # qui garantit que le client paie ce qu'on lui a montré. Rien n'est recalculé ici.
        ride = env["babana.ride"].sudo().action_request(
            {
                "client_id": user.partner_id.id,
                "pickup_latitude": quote.pickup_latitude,
                "pickup_longitude": quote.pickup_longitude,
                "dropoff_latitude": quote.dropoff_latitude,
                "dropoff_longitude": quote.dropoff_longitude,
                "pickup_zone_id": quote.pickup_zone_id.id,
                "dropoff_zone_id": quote.dropoff_zone_id.id,
                "quote_id": quote.id,
                "currency_id": quote.currency_id.id,
                "estimated_amount": quote.amount,
                "reference_distance_km": quote.distance_meters / 1000.0,
                "estimated_duration_minutes": quote.eta_seconds / 60.0,
                "fare_rule_id": quote.fare_rule_id.id,
                "fare_rule_snapshot": quote.fare_rule_snapshot,
                "promotion_code": quote.promo_code,
                "discount_amount": quote.discount_amount,
            }
        )
        return _summary(ride), 201

    # --- POST /rides/{id}/select-driver -------------------------------------------------------

    @http.route("/api/v1/rides/<string:ride_id>/select-driver", **_ROUTE)
    def select_driver(self, ride_id, **_kwargs):
        return self._dispatch("selectDriver", lambda: self._select_driver(ride_id))

    def _select_driver(self, ride_id):
        env, user = _common.authenticated_user()
        ride = self._find_ride(env, ride_id)
        if not ride:
            return _common.error_payload("RIDE_NOT_FOUND", "course inconnue"), 404
        if ride.client_id != user.partner_id:
            return _common.error_payload("RIDE_NOT_OWNED", "cette course n'appartient pas à l'appelant"), 403

        body = _common.parse_json_body()
        driver_id = (body or {}).get("driverId")
        driver = (
            env["babana.driver"].sudo().search([("public_id", "=", driver_id)], limit=1)
            if driver_id
            else env["babana.driver"]
        )
        if not driver:
            return _common.error_payload("VALIDATION_ERROR", "driverId inconnu ou manquant"), 400

        # Sens Odoo -> temps réel (L3-06, L3-17) : réserve et propose AVANT toute transition Odoo.
        # Le piège du rejeu (D25) est encaissé côté temps réel (reservation/idempotency.ts), par
        # la clé d'idempotence du client si l'app en a fourni une, sinon une clé composite
        # course+chauffeur -- toutes deux stables à travers un rejeu de CETTE requête par Odoo.
        reservation = realtime_client.reserve_and_propose(
            ride=ride, driver=driver, client_user=user, idempotency_key=_common.idempotency_key()
        )
        outcome = reservation.get("outcome")
        if outcome == "DRIVER_ALREADY_TAKEN":
            return _common.error_payload(
                "DRIVER_ALREADY_TAKEN", "ce chauffeur vient d'être réservé par une autre course"
            ), 409
        if outcome == "DRIVER_NOT_IN_LAST_LIST":
            # Précondition C-03 (critère 8) : un identifiant jamais montré à ce client -- même
            # réaction côté client que DRIVER_ALREADY_TAKEN (revenir à la sélection), aucun code
            # dédié dans le catalogue C-01 aujourd'hui (amoa/questions/L3-17.md §3).
            return _common.error_payload(
                "DRIVER_ALREADY_TAKEN", "ce chauffeur n'est pas dans la liste proposée à ce client"
            ), 409
        if outcome != "PROPOSED":
            return _common.error_payload("INTERNAL_ERROR", "réponse inattendue du service temps réel"), 500

        # Critère 4 : si la transition Odoo échoue DÉFINITIVEMENT à partir d'ici, la réservation
        # doit être relâchée -- sans quoi le chauffeur reste bloqué hors du pool sans course
        # correspondante.
        try:
            ride.sudo().action_propose(by_partner=user.partner_id, driver=driver)
        except PG_CONCURRENCY_EXCEPTIONS_TO_RETRY:
            # D25 : PAS un échec définitif -- Odoo va rejouer la requête entière avec un curseur
            # neuf. La réservation temps réel doit SURVIVRE à ce rejeu (c'est précisément ce que
            # l'idempotence de reserve_and_propose protège, clé stable à travers le rejeu) :
            # la relâcher ici la ferait disparaître avant que la tentative rejouée n'ait eu la
            # moindre chance de la réutiliser -- exactement l'inverse de ce que le piège central
            # de cette tâche demande d'éviter.
            raise
        except Exception:
            realtime_client.release_reservation(driver_public_id=driver.public_id)
            raise

        # Fenêtre informative seulement (L3, hors de ce lot, portera l'expiration réelle du
        # côté du service temps réel -- voir amoa/questions/L4-03.md). Paramétrable (invariant
        # 5), jamais codée en dur.
        window_seconds = int(
            env["ir.config_parameter"].sudo().get_param("babana.proposal_window_seconds", 30)
        )
        payload = _summary(ride)
        payload["proposalExpiresAt"] = _common.iso_datetime(
            ride.proposed_at + timedelta(seconds=window_seconds)
        )
        return payload, 200

    # --- POST /rides/{id}/start -----------------------------------------------------------------

    @http.route("/api/v1/rides/<string:ride_id>/start", **_ROUTE)
    def start_ride(self, ride_id, **_kwargs):
        return self._dispatch("startRide", lambda: self._start_ride(ride_id))

    def _start_ride(self, ride_id):
        env, user = _common.authenticated_user()
        ride, driver, error = self._find_ride_and_assigned_driver(env, user, ride_id)
        if error:
            return error
        ride.sudo().action_start(by_driver=driver)
        return _summary(ride), 200

    # --- POST /rides/{id}/complete (L4-03R) ----------------------------------------------------

    @http.route("/api/v1/rides/<string:ride_id>/complete", **_ROUTE)
    def complete_ride(self, ride_id, **_kwargs):
        return self._dispatch("completeRide", lambda: self._complete_ride(ride_id))

    def _complete_ride(self, ride_id):
        env, user = _common.authenticated_user()
        ride, driver, error = self._find_ride_and_assigned_driver(env, user, ride_id)
        if error:
            return error

        # La fin de course ne porte que la décision (J24, amoa/questions/L6-13.md) : le corps est
        # vide, l'app dit « terminée » et rien d'autre. Aucune lecture de body ici.
        #
        # `measurement` = le relevé de trajet accumulé par le service temps réel pendant la course
        # (L3-10). `None` pour l'instant : L3-10 (tâche suivante) branchera ici la lecture
        # synchrone de l'accumulation -- une lecture, jamais une écriture Redis, donc sans risque
        # D25/D32 (une transaction rejouée ou annulée n'aura rien modifié côté temps réel), même
        # exception assumée que `reserve_and_propose`. Tant que rien n'est mesuré, `trip_measured`
        # reste faux et l'écart de distance de L4-04 n'est pas armé (D30, D43).
        measurement = None

        # Le montant final se calcule sur la distance de référence (gelée à la création, L2-04),
        # jamais sur la distance parcourue -- voir babana.ride._babana_compute_final_amount.
        final_amount = ride._babana_compute_final_amount()
        ride.sudo().action_complete(
            by_driver=driver,
            final_amount=final_amount,
            measurement=measurement,
        )
        # Sens Odoo -> temps réel (L3-17, critère 6) : efface le marqueur d'engagement -- sans
        # lui, le chauffeur ne revient jamais dans le pool (D26). Après la transition, jamais
        # avant : la course doit être réellement terminée côté Odoo (source de vérité, D27) avant
        # que le service temps réel ne considère ce chauffeur de nouveau disponible.
        # 'completed', pas 'settled' (DRIVER_ACTIVE_STATES, babana_ride.py) : l'encaissement ne
        # bloque pas une nouvelle course. Au COMMIT, jamais pendant (D32) : voir la docstring de
        # clear_engagement (services/realtime_client.py) pour le raisonnement complet.
        realtime_client.clear_engagement(env, driver_public_id=driver.public_id)
        payload = _summary(ride)
        payload["measured"] = ride.trip_measured
        payload["distanceMeters"] = (
            round(ride.actual_distance_km * 1000) if ride.trip_measured else None
        )
        payload["durationSeconds"] = (
            round(ride.actual_duration_minutes * 60) if ride.trip_measured else None
        )
        return payload, 200

    # --- POST /rides/{id}/settle (L4-05) --------------------------------------------------------

    @http.route("/api/v1/rides/<string:ride_id>/settle", **_ROUTE)
    def settle_ride(self, ride_id, **_kwargs):
        return self._dispatch("settleRide", lambda: self._settle_ride(ride_id))

    def _settle_ride(self, ride_id):
        env, user = _common.authenticated_user()
        ride, driver, error = self._find_ride_and_assigned_driver(env, user, ride_id)
        if error:
            return error

        body = _common.parse_json_body() or {}
        amount_collected = body.get("amountCollected")
        if not isinstance(amount_collected, (int, float)) or amount_collected < 0:
            return _common.error_payload(
                "VALIDATION_ERROR", "amountCollected (nombre positif) est requis"
            ), 400

        # Toute la logique -- transition, mouvement de compte courant, contrôle de plafond -- vit
        # dans action_settle (invariant 3 : aucune règle métier dans le contrôleur). Un montant
        # qui ne correspond pas au dû lève SETTLEMENT_AMOUNT_MISMATCH, traduite ci-dessous
        # (_map_user_error ne la connaît pas : c'est un message littéral, pas une UserError
        # générique -- même patron que DRIVER_ALREADY_TAKEN).
        ride.sudo().action_settle(by_driver=driver, amount_collected=amount_collected)

        driver.invalidate_recordset()
        return {
            "rideId": ride.public_id,
            "state": "settled",
            "amountCollected": amount_collected,
            "driverCashBalance": driver.cash_balance,
        }, 200

    def _find_ride_and_assigned_driver(self, env, user, ride_id):
        """Commun à start/complete (D31 a retiré accept/reject d'ici -- StartRideErrors/
        CompleteRideErrors du contrat C-01 partagent tous DRIVER_NOT_IN_PROPOSAL pour le même cas :
        l'appelant n'est pas le chauffeur affecté). Renvoie (ride, driver, None) ou
        (None, None, (payload, status))."""
        ride = self._find_ride(env, ride_id)
        if not ride:
            return None, None, (_common.error_payload("RIDE_NOT_FOUND", "course inconnue"), 404)
        driver = user._babana_driver()
        if not driver or ride.driver_id != driver:
            return None, None, (
                _common.error_payload(
                    "DRIVER_NOT_IN_PROPOSAL",
                    "ce chauffeur n'est pas celui affecté à cette course",
                ),
                403,
            )
        return ride, driver, None

    # --- POST /rides/{id}/cancel ----------------------------------------------------------------

    @http.route("/api/v1/rides/<string:ride_id>/cancel", **_ROUTE)
    def cancel_ride(self, ride_id, **_kwargs):
        return self._dispatch("cancelRide", lambda: self._cancel_ride(ride_id))

    def _cancel_ride(self, ride_id):
        env, user = _common.authenticated_user()
        ride = self._find_ride(env, ride_id)
        if not ride:
            return _common.error_payload("RIDE_NOT_FOUND", "course inconnue"), 404

        driver = user._babana_driver()
        is_supervisor = user.sudo().has_group(
            "babana.group_babana_supervisor"
        ) or user.sudo().has_group("babana.group_babana_manager")
        if ride.client_id == user.partner_id:
            actor_role, actor_record = "client", user.partner_id
        elif driver and ride.driver_id == driver:
            actor_role, actor_record = "driver", driver
        elif is_supervisor:
            actor_role, actor_record = "supervisor", None
        else:
            return _common.error_payload(
                "RIDE_NOT_OWNED", "cette course n'appartient pas à l'appelant"
            ), 403

        reason = (_common.parse_json_body() or {}).get("reason")
        cancelled_driver = ride.driver_id  # action_cancel ne l'efface jamais (contrairement au refus)
        ride.sudo().action_cancel(actor_role=actor_role, actor_record=actor_record, reason=reason)

        # Sens Odoo -> temps réel (L3-17) : une annulation met fin à l'implication du chauffeur,
        # quel qu'ait été son état réel côté temps réel -- réservé ('proposed' annulé, critère 4
        # de L3-06 une couche plus haut) ou engagé ('assigned'/'in_progress' annulé, critère 6).
        # Les deux appels sont idempotents (sans effet si l'état visé n'existe pas) : plutôt que
        # de déterminer lequel s'applique, les deux nettoient ce qui doit l'être. En tâche de
        # fond (voir notify_cancellation_async) : la transition est déjà appliquée, rien n'oblige
        # le client à attendre ce nettoyage. Au COMMIT, jamais pendant (D32) : un appel parti
        # pendant la transaction aurait déjà modifié Redis pour une annulation qui, en cas de
        # rejeu ou d'échec au commit (D25), n'aurait pas eu lieu.
        if cancelled_driver:
            realtime_client.notify_cancellation_async(env, cancelled_driver.public_id)
        return _summary(ride), 200
