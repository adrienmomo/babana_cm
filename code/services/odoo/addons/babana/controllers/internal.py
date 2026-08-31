# Endpoints internes reçus du service temps réel (L3-17, sens temps réel -> Odoo). Symétrique de
# services/realtime_client.py (sens Odoo -> temps réel) : ce fichier-ci REÇOIT plutôt qu'il
# n'émet. Authentifié par X-Realtime-Secret (_common.authenticated_internal_call), jamais par le
# jeton d'accès d'un utilisateur -- ces appels n'ont pas d'utilisateur humain derrière eux.
#
# Jamais exposé publiquement : ni le domaine mobile, ni Caddy ne routent vers `/api/internal/*`
# (vérifié dans infra/caddy/Caddyfile), le secret partagé est une seconde barrière, indépendante
# du routage.
from __future__ import annotations

import logging
from datetime import timedelta

from odoo import SUPERUSER_ID, http
from odoo.exceptions import UserError
from odoo.http import request
from odoo.service.model import PG_CONCURRENCY_EXCEPTIONS_TO_RETRY

from . import _common
from ..services import push
from ..models.babana_ride import CLIENT_ACTIVE_STATES, DRIVER_ACTIVE_STATES
from ..models.babana_ride_state import RideInvalidTransition
from ..models.babana_ride_share import (
    SHARE_LINK_GRACE_MINUTES_FALLBACK,
    SHARE_LINK_GRACE_MINUTES_PARAM,
)

_logger = logging.getLogger(__name__)

# readonly=False explicite : auth='none' est en lecture seule par défaut depuis Odoo 18
# (code/docs/odoo-pitfalls.md) -- les deux premières routes écrivent une transition.
_WRITE_ROUTE = {"type": "http", "auth": "none", "methods": ["POST"], "csrf": False, "readonly": False}
# La réconciliation ne lit que -- pas de readonly=False ici, contrairement aux deux ci-dessus.
_READ_ROUTE = {"type": "http", "auth": "none", "methods": ["POST"], "csrf": False}


class InternalController(http.Controller):
    def _dispatch(self, endpoint: str, handler):
        try:
            _common.authenticated_internal_call()
            payload, status = handler()
            return _common.json_response(payload, status)
        except _common.AuthenticationFailed as exc:
            return _common.error_response(exc.code, "authentification requise", exc.status)
        except RideInvalidTransition as exc:
            return _common.error_response("RIDE_INVALID_TRANSITION", str(exc), 409)
        except UserError as exc:
            return _common.error_response("VALIDATION_ERROR", str(exc), 400)
        except PG_CONCURRENCY_EXCEPTIONS_TO_RETRY:
            # Même politique que controllers/ride.py::_dispatch (D25) : ne jamais attraper cette
            # famille d'exceptions ici, la laisser remonter jusqu'au rejeu d'Odoo. Ces routes
            # n'ont pas les mêmes préoccupations d'idempotence que select-driver -- accept/reject
            # sont idempotents par construction côté temps réel (resolve.lua ne résout qu'une
            # fois), un rejeu de driver-accepted/driver-rejected ré-exécute action_accept/
            # action_reject sur un état déjà transitionné et échoue proprement en
            # RIDE_INVALID_TRANSITION, jamais en double effet.
            raise
        except Exception:
            _logger.exception("erreur interne dans %s", endpoint)
            return _common.error_response("INTERNAL_ERROR", "erreur interne", 500)

    def _find_ride(self, env, ride_id):
        return env["babana.ride"].sudo().search([("public_id", "=", ride_id)], limit=1)

    def _find_driver(self, env, driver_id):
        if not driver_id:
            return env["babana.driver"]
        return env["babana.driver"].sudo().search([("public_id", "=", driver_id)], limit=1)

    # --- POST /internal/rides/{id}/driver-accepted (L3-17, sens temps réel -> Odoo) -----------

    @http.route("/api/internal/rides/<string:ride_id>/driver-accepted", **_WRITE_ROUTE)
    def driver_accepted(self, ride_id, **_kwargs):
        return self._dispatch("driverAccepted", lambda: self._driver_accepted(ride_id))

    def _driver_accepted(self, ride_id):
        env = request.env(user=SUPERUSER_ID)
        ride = self._find_ride(env, ride_id)
        if not ride:
            return _common.error_payload("RIDE_NOT_FOUND", "course inconnue"), 404

        body = _common.parse_json_body() or {}
        driver = self._find_driver(env, body.get("driverId"))
        if not driver:
            return _common.error_payload("VALIDATION_ERROR", "driverId inconnu ou manquant"), 400

        ride.sudo().action_accept(by_driver=driver)
        return {"ok": True}, 200

    # --- POST /internal/rides/{id}/driver-rejected (refus explicite ou expiration) ------------

    @http.route("/api/internal/rides/<string:ride_id>/driver-rejected", **_WRITE_ROUTE)
    def driver_rejected(self, ride_id, **_kwargs):
        return self._dispatch("driverRejected", lambda: self._driver_rejected(ride_id))

    def _driver_rejected(self, ride_id):
        env = request.env(user=SUPERUSER_ID)
        ride = self._find_ride(env, ride_id)
        if not ride:
            return _common.error_payload("RIDE_NOT_FOUND", "course inconnue"), 404

        body = _common.parse_json_body() or {}
        driver = self._find_driver(env, body.get("driverId"))
        if not driver:
            return _common.error_payload("VALIDATION_ERROR", "driverId inconnu ou manquant"), 400

        ride.sudo().action_reject(
            by_driver=driver, reason=body.get("reason"), expired=bool(body.get("expired"))
        )
        return {"ok": True}, 200

    # --- POST /internal/drivers/engaged (réconciliation, L3-17 critère 7) ---------------------

    @http.route("/api/internal/drivers/engaged", **_READ_ROUTE)
    def engaged_drivers(self, **_kwargs):
        return self._dispatch("engagedDrivers", self._engaged_drivers)

    def _engaged_drivers(self):
        """Odoo est la source de vérité (D27) : la liste des chauffeurs que le service temps réel
        doit considérer comme engagés (marqueur sans expiration, D26) est celle des courses
        `assigned`/`in_progress` -- pas `proposed`, qui reste protégée par la réservation à
        expiration (L3-06), pas par l'engagement.

        Porte `rideId` avec chaque chauffeur (D44, amoa/questions/REPONSES-2026-08-28.md §3) :
        un engagement réparé sans identifiant de course produit un état qu'aucune transition
        normale ne peut produire -- engagé, sans suivi possible. Odoo connaît cet identifiant
        (une seule course active par chauffeur, `assigned`/`in_progress`, jamais les deux à la
        fois), la réponse le porte donc pour que la réparation puisse l'écrire."""
        env = request.env(user=SUPERUSER_ID)
        rides = env["babana.ride"].sudo().search(
            [("state", "in", ["assigned", "in_progress"]), ("driver_id", "!=", False)]
        )
        return {
            "engaged": [
                {"driverId": ride.driver_id.public_id, "rideId": ride.public_id} for ride in rides
            ]
        }, 200

    # --- POST /internal/drivers/proposal-push (L7-04, sens temps réel -> Odoo) ----------------

    # _WRITE_ROUTE bien qu'aucune écriture n'ait lieu dans CETTE transaction : `notify_users_async`
    # programme un `cr.postcommit` (envoi + marquage `last_used_at` + désactivation des jetons
    # révoqués sur un fil de fond, curseur dédié) -- il ne se déclenche qu'après un COMMIT réussi,
    # et une route readonly ne l'offre pas de façon garantie. Rien de sensible dans la réponse ni
    # dans la notification (voir _proposal_push).
    @http.route("/api/internal/drivers/proposal-push", **_WRITE_ROUTE)
    def proposal_push(self, **_kwargs):
        return self._dispatch("proposalPush", self._proposal_push)

    def _proposal_push(self):
        """L7-04 : « la notification la plus critique du système ». Émise par le service temps réel
        EN PARALLÈLE de `proposal.new` (jamais à sa place, critère 1) -- ce contrôleur ne fait que
        résoudre le compte du chauffeur et confier l'envoi à l'unique émetteur FCM (services/
        push.py, L7-01). Le service temps réel n'a pas de client push à lui (invariant 1 : pas de
        PostgreSQL, donc pas la table des jetons).

        Asynchrone (`notify_users_async`) : un envoi lent ne doit jamais retarder la réservation
        côté temps réel, qui attend cette réponse HTTP (best-effort, mais attend quand même).

        Contenu MINIMAL et sans donnée sensible (spécification) : ni montant, ni départ, ni
        destination. Une notification peut arriver après l'expiration -- afficher un montant pour
        une course déjà attribuée serait trompeur -- et l'écran verrouillé est lisible par un
        tiers. Le détail vient de l'app une fois ouverte (revalidation par `session.synced`)."""
        env = request.env(user=SUPERUSER_ID)
        body = _common.parse_json_body() or {}
        driver = self._find_driver(env, body.get("driverId"))
        if not driver:
            return _common.error_payload("VALIDATION_ERROR", "driverId inconnu ou manquant"), 400
        if not driver.user_id:
            # Personne à joindre : pas une erreur d'appel du service temps réel, juste un chauffeur
            # sans compte `res.users`. Le message WebSocket reste le canal principal.
            return {"ok": True, "notified": False}, 200

        message = push.PushMessage(
            # L7-02 déplacera ces libellés dans des modèles traduisibles (règle du lot) ; d'ici là,
            # français en clair.
            title="Nouvelle course proposée",
            body="Ouvrez l'application pour répondre.",
            # Données de routage : ouvrent l'app sur l'écran de proposition (L6-12), qui revalide
            # ensuite auprès du serveur. `expiresAt` porte la véritable échéance pour un premier
            # compte à rebours avant même que la revalidation aboutisse.
            data={
                "type": "proposal",
                "rideId": body.get("rideId") or "",
                "expiresAt": body.get("expiresAt") or "",
            },
            high_priority=True,  # réveille l'appareil (L7-04)
            collapse_key="babana-proposal",  # une seule proposition à la fois : un renvoi remplace
        )
        push.notify_users_async(env, driver.user_id, message)
        return {"ok": True, "notified": True}, 200

    # --- POST /internal/session/active-ride (L3-11, resynchronisation à la reconnexion) -------

    @http.route("/api/internal/session/active-ride", **_READ_ROUTE)
    def active_ride(self, **_kwargs):
        return self._dispatch("activeRide", self._active_ride)

    def _active_ride(self):
        """Odoo est la source de vérité (D27) : le service temps réel ne garde aucune trace
        durable de l'état d'une course (invariant 1), il interroge ici l'état réel avant de
        répondre à `session.resync` (L3-11). `userId`/`role` identifient la connexion
        (`ConnectionContext`, ws/auth.ts) -- jamais un `driverId` seul, qui n'a pas de sens pour
        un client.

        Une course "active" est celle qui bloquerait une seconde course du même acteur
        (`CLIENT_ACTIVE_STATES`/`DRIVER_ACTIVE_STATES`, babana_ride.py -- la même liste que la
        contrainte "une seule course active", pas une nouvelle définition). À défaut, et
        seulement si `lastKnownRideId` est fourni, la course précise que le client croyait
        encore en cours est relue avec son état réel -- un client qui se reconnecte juste après
        que sa course est passée `completed` (donc hors des états "actifs", l'encaissement n'est
        pas bloquant) doit apprendre ce vrai état plutôt qu'un néant ambigu. Toujours vérifié par
        propriété : jamais l'état d'une course qui n'appartient pas à l'appelant.
        """
        env = request.env(user=SUPERUSER_ID)
        body = _common.parse_json_body() or {}
        user_public_id = body.get("userId")
        role = body.get("role")
        last_known_ride_id = body.get("lastKnownRideId")
        if not user_public_id or role not in ("client", "driver"):
            return _common.error_payload("VALIDATION_ERROR", "userId et role sont requis"), 400

        user = env["res.users"].sudo().search(
            [("babana_public_id", "=", user_public_id)], limit=1
        )
        if not user:
            return {"rideId": None, "state": None}, 200

        if role == "client":
            owner_domain = [("client_id", "=", user.partner_id.id)]
            active_states = CLIENT_ACTIVE_STATES
        else:
            driver = user._babana_driver()
            if not driver:
                return {"rideId": None, "state": None}, 200
            owner_domain = [("driver_id", "=", driver.id)]
            active_states = DRIVER_ACTIVE_STATES

        ride = env["babana.ride"].sudo().search(
            owner_domain + [("state", "in", list(active_states))], limit=1
        )
        if not ride and last_known_ride_id:
            ride = env["babana.ride"].sudo().search(
                owner_domain + [("public_id", "=", last_known_ride_id)], limit=1
            )
        if not ride:
            return {"rideId": None, "state": None}, 200
        return {"rideId": ride.public_id, "state": ride.state}, 200

    # --- POST /internal/share/resolve (L8-03, sens temps réel -> Odoo) ------------------------

    @http.route("/api/internal/share/resolve", **_READ_ROUTE)
    def resolve_share(self, **_kwargs):
        return self._dispatch("resolveShare", self._resolve_share)

    def _resolve_share(self):
        """Odoo possède le jeton et sa validité (D27) -- le service temps réel ne calcule
        jamais lui-même une expiration, il la redemande ici à chaque page publique servie
        (`GET /s/{token}`, services/realtime/src/share/handler.ts). `{"active": false}` couvre
        aussi bien un jeton inconnu qu'un jeton révoqué ou expiré -- jamais distingué, un visiteur
        de la page publique n'a aucune raison de savoir laquelle des trois s'applique.

        Liste blanche champ par champ (spécification, critère 2) : mêmes deux champs chauffeur
        que `internal_profiles.py::_project` (prénom, gamme), jamais un champ de plus -- jamais
        le nom complet, l'immatriculation, le montant, ni la moindre donnée sur le client."""
        env = request.env(user=SUPERUSER_ID)
        body = _common.parse_json_body() or {}
        token = body.get("token")
        if not token:
            return {"active": False}, 200

        share = env["babana.ride.share"].sudo().search([("token", "=", token)], limit=1)
        if not share or not share._is_active():
            return {"active": False}, 200

        ride = share.ride_id
        driver = ride.driver_id
        first_name = None
        if driver and driver.employee_id and driver.employee_id.name:
            first_name = driver.employee_id.name.split(" ")[0]
        motorcycle_class = driver.motorcycle_id.vehicle_class if driver and driver.motorcycle_id else None

        expires_at = None
        if ride.state in ("settled", "completed", "cancelled"):
            grace_minutes = int(
                env["ir.config_parameter"]
                .sudo()
                .get_param(SHARE_LINK_GRACE_MINUTES_PARAM, SHARE_LINK_GRACE_MINUTES_FALLBACK)
            )
            terminal_at = ride.completed_at or ride.cancelled_at
            if terminal_at:
                expires_at = terminal_at + timedelta(minutes=grace_minutes)

        return (
            {
                "active": True,
                "rideId": ride.public_id,
                # 'approach' | 'course', jamais le state Odoo brut -- même vocabulaire que
                # TrackingScreen.tsx (L6-09) côté client, pour la même raison : l'ETA affichée n'a
                # de sens qu'à l'approche (distance jusqu'au point de départ, voir
                # tracking/broadcast.ts), plus une fois la course commencée.
                "phase": "course" if ride.state == "in_progress" else "approach",
                "destination": {
                    "latitude": ride.dropoff_latitude,
                    "longitude": ride.dropoff_longitude,
                },
                "driverFirstName": first_name,
                "motorcycleClass": motorcycle_class,
                "expiresAt": _common.iso_datetime(expires_at),
            },
            200,
        )
