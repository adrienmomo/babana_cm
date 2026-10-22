# Tests des endpoints du cycle de vie de la course (L4-03). Cinq endpoints sur huit du contrat
# -- voir amoa/questions/L4-03.md pour ce qui manque et pourquoi (createRide/complete/settle/
# rate dépendent de tâches non prévues cette nuit). Le critère 7 (« aucune condition métier dans
# le contrôleur ») n'est pas un comportement observable à l'exécution -- vérifié par construction
# (controllers/ride.py ne teste jamais un champ métier, seulement l'identité de l'appelant) et en
# revue, pas par un test ici.
#
# La course part au chauffeur disponible le plus proche (POST /rides/{id}/dispatch) : le service
# temps réel le choisit réellement dans son vivier (D26). Un chauffeur approuvé par simple RPC
# (_make_approved_driver) n'y est pas tant qu'il n'est pas réellement passé en ligne et n'a pas
# émis de position -- _realtime_ws.py le fait par le chemin réel (WebSocket), jamais par une
# écriture Redis directe.
#
# Chaque test a son propre point de prise en charge (_next_spot), à plus d'un kilomètre des
# autres, avec un rayon de recherche de quelques centaines de mètres : « le plus proche » est
# alors toujours le chauffeur du test, jamais un chauffeur resté en ligne d'un test précédent.
from __future__ import annotations

import itertools
import json
from datetime import timedelta
import os
import random
import uuid
from unittest.mock import patch

import requests

from odoo.tests.common import HttpCase, tagged

from ._realtime_ws import bring_driver_online
from ..services import realtime_client


def _mock_google_base_url() -> str:
    return os.environ.get("GOOGLE_MOCK_IDENTITY_URL", "http://mock-google-identity:4000")


def _realtime_internal_url() -> str:
    return os.environ.get("REALTIME_INTERNAL_URL", "http://realtime:3000")


def _first_allowed_audience() -> str:
    raw = os.environ.get("GOOGLE_OAUTH_CLIENT_IDS", "")
    first = raw.split(",")[0].strip()
    assert first, "GOOGLE_OAUTH_CLIENT_IDS doit être configurée pour exécuter ces tests"
    return first


def _mint_google_token(**overrides) -> str:
    payload = dict(overrides)
    if "aud" not in payload:
        payload["aud"] = _first_allowed_audience()
    response = requests.post(f"{_mock_google_base_url()}/token", json=payload, timeout=5)
    response.raise_for_status()
    return response.json()["id_token"]


# Rayon de recherche pendant ces tests (babana.dispatch_radius_meters) et points de prise en charge
# espacés d'environ 1,1 km : un chauffeur d'un autre test n'est jamais à portée. Base de longitude
# tirée par exécution : des chauffeurs d'une exécution précédente, encore positionnés, ne tombent
# pas sur les mêmes points.
_TEST_DISPATCH_RADIUS_METERS = 300
_SPOT_COUNTER = itertools.count()
_SPOT_LONGITUDE_BASE = 9.62 + random.random() * 0.03


def _next_spot() -> dict:
    index = next(_SPOT_COUNTER)
    return {
        "latitude": round(3.96 + (index % 15) * 0.01, 6),
        "longitude": round(_SPOT_LONGITUDE_BASE + (index // 15) * 0.01, 6),
    }


@tagged("post_install", "-at_install")
class TestRideController(HttpCase):
    def setUp(self):
        super().setUp()
        self._spot = _next_spot()
        self.env["ir.config_parameter"].sudo().set_param(
            "babana.dispatch_radius_meters", str(_TEST_DISPATCH_RADIUS_METERS)
        )

    @classmethod
    def _request_handler(cls, s, r, **kw):
        # Sens Odoo -> temps réel (L3-17) : dispatch et complete appellent réellement le
        # service temps réel pendant ces tests (contre la pile réelle, `make up`), pas un double
        # -- au même titre que mock-google-identity et mock-maps, déjà autorisés ici.
        if (
            r.url.startswith(_mock_google_base_url())
            or r.url.startswith(_realtime_internal_url())
            or "mock-maps" in r.url
        ):
            from odoo.tests.common import _super_send

            return _super_send(s, r, **kw)
        return super()._request_handler(s, r, **kw)

    # --- Fixtures : comptes réels via le vrai parcours d'inscription --------------------------

    def _sign_in(self, sub, role):
        token = _mint_google_token(sub=sub, email=f"{sub}@example.invalid")
        response = self.url_open(
            "/api/v1/auth/google",
            data=json.dumps({"idToken": token, "role": role}).encode(),
            headers={"Content-Type": "application/json"},
        )
        body = response.json()
        return body["accessToken"], body["user"]["id"]

    def _make_approved_driver(self, sub):
        access_token, public_user_id = self._sign_in(sub, "driver")
        user = self.env["res.users"].sudo().search([("babana_public_id", "=", public_user_id)])
        driver = user._babana_driver()

        for document_type in ("license", "id_card"):
            vals = {
                "driver_id": driver.id,
                "document_type": document_type,
                "storage_key": f"test/{document_type}.jpg",
                "verification_status": "verified",
            }
            if document_type == "license":
                vals["expires_on"] = "2030-01-01"
            self.env["babana.driver.document"].create(vals)
        moto = self.env["babana.motorcycle"].create(
            {"license_plate": f"LT-{uuid.uuid4().hex[:4].upper()}-BC"}
        )
        moto.write({"driver_id": driver.id})
        driver.invalidate_recordset()
        driver.action_approve(new_employee_name=f"Chauffeur {sub}")
        return access_token, driver

    def _make_dispatchable_driver(self, sub, meters_north=0):
        """Chauffeur approuvé, réellement en ligne et positionné (L3-01/L3-02/L3-04) au point de
        prise en charge du test (à `meters_north` mètres au nord) : c'est lui que la recherche du
        plus proche trouvera."""
        driver_token, driver = self._make_approved_driver(sub)
        bring_driver_online(
            driver_token, self._spot["latitude"] + meters_north / 111_000, self._spot["longitude"]
        )
        return driver_token, driver

    def _post(self, path, token, body=None, idempotency_key=None):
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return self.url_open(path, data=json.dumps(body or {}).encode(), headers=headers)

    def _accept_via_internal_channel(self, ride_public_id, driver_public_id):
        # D31 (amoa/questions/REPONSES-2026-08-18.md §3) : plus de route publique /accept -- le
        # seul chemin d'écriture réel est proposal.accept (temps réel) -> canal interne
        # (controllers/internal.py::driver_accepted). Ce fichier teste la couche REST du cycle de
        # vie (dispatch, start, complete, cancel) ; l'acceptation elle-même, câblée par
        # L3-17, n'a pas besoin d'un aller-retour WebSocket ici pour amener une course à
        # 'assigned' -- ce test-ci n'exerce pas le mécanisme d'acceptation, seulement ce qui vient
        # après (voir test_internal_controller.py pour l'acceptation elle-même, et L4-11 pour sa
        # preuve de concurrence).
        headers = {
            "Content-Type": "application/json",
            "X-Realtime-Secret": os.environ["REALTIME_SHARED_SECRET"],
        }
        return self.url_open(
            f"/api/internal/rides/{ride_public_id}/driver-accepted",
            data=json.dumps({"driverId": driver_public_id}).encode(),
            headers=headers,
        )

    def _make_ride(self, client_partner):
        return self.env["babana.ride"].action_request(
            {
                "client_id": client_partner.id,
                "pickup_latitude": self._spot["latitude"],
                "pickup_longitude": self._spot["longitude"],
                "dropoff_latitude": 4.06,
                "dropoff_longitude": 9.77,
            }
        )

    # --- L4-03R : POST /rides (createRide) et POST /rides/{id}/complete -----------------------

    _QUOTE_DESTINATION = {"latitude": 4.0270, "longitude": 9.7040}

    def _make_quote(self, client_token):
        response = self._post(
            "/api/v1/quote",
            client_token,
            {"origin": self._spot, "destination": self._QUOTE_DESTINATION},
        )
        self.assertEqual(response.status_code, 200)
        return response.json()["quoteId"]

    # --- Parcours nominal, jusqu'à in_progress --------------------------------------------------

    def test_full_happy_path_up_to_in_progress(self):
        client_token, client_public_id = self._sign_in("sub-ride-client", "client")
        client_user = self.env["res.users"].sudo().search(
            [("babana_public_id", "=", client_public_id)]
        )
        driver_token, driver = self._make_dispatchable_driver("sub-ride-driver")
        ride = self._make_ride(client_user.partner_id)

        select_response = self._post(f"/api/v1/rides/{ride.public_id}/dispatch", client_token)
        self.assertEqual(select_response.status_code, 200)
        select_body = select_response.json()
        self.assertEqual(select_body["state"], "proposed")
        self.assertEqual(select_body["assignedDriverId"], driver.public_id)
        self.assertTrue(select_body["proposalExpiresAt"])

        accept_response = self._accept_via_internal_channel(ride.public_id, driver.public_id)
        self.assertEqual(accept_response.status_code, 200)
        self.assertEqual(ride.state, "assigned")

        start_response = self._post(f"/api/v1/rides/{ride.public_id}/start", driver_token)
        self.assertEqual(start_response.status_code, 200)
        self.assertEqual(start_response.json()["state"], "in_progress")

    # --- « Sur place », attente, « client absent » --------------------------------------------

    def _assigned_ride_over_http(self, sub):
        client_token, client_public_id = self._sign_in(f"{sub}-client", "client")
        client_user = self.env["res.users"].sudo().search([("babana_public_id", "=", client_public_id)])
        driver_token, driver = self._make_dispatchable_driver(f"{sub}-driver")
        ride = self._make_ride(client_user.partner_id)
        self.assertEqual(
            self._post(f"/api/v1/rides/{ride.public_id}/dispatch", client_token).status_code,
            200,
        )
        self.assertEqual(self._accept_via_internal_channel(ride.public_id, driver.public_id).status_code, 200)
        return ride, client_token, driver_token

    def test_driver_arrived_returns_the_arrival_time_and_the_grace_period(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.no_show_grace_seconds", "300")
        ride, _client_token, driver_token = self._assigned_ride_over_http("sub-arrived")

        response = self._post(f"/api/v1/rides/{ride.public_id}/arrived", driver_token)

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["state"], "assigned")
        self.assertTrue(body["arrivedAt"].endswith("Z"))
        self.assertEqual(body["noShowGraceSeconds"], 300)
        self.assertTrue(ride.arrived_at)

    def test_the_client_cannot_declare_the_driver_arrived(self):
        ride, client_token, _driver_token = self._assigned_ride_over_http("sub-arrived-client")
        response = self._post(f"/api/v1/rides/{ride.public_id}/arrived", client_token)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "DRIVER_NOT_IN_PROPOSAL")

    def test_no_show_too_early_is_refused_with_its_own_code(self):
        ride, _client_token, driver_token = self._assigned_ride_over_http("sub-noshow-early")
        self._post(f"/api/v1/rides/{ride.public_id}/arrived", driver_token)

        response = self._post(f"/api/v1/rides/{ride.public_id}/cancel", driver_token, {"reason": "client_no_show"})

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "NO_SHOW_TOO_EARLY")
        self.assertEqual(ride.state, "assigned")

    def test_no_show_after_the_grace_period_cancels(self):
        ride, _client_token, driver_token = self._assigned_ride_over_http("sub-noshow-late")
        self._post(f"/api/v1/rides/{ride.public_id}/arrived", driver_token)
        ride.sudo().write({"arrived_at": ride.arrived_at - timedelta(seconds=3600)})

        response = self._post(f"/api/v1/rides/{ride.public_id}/cancel", driver_token, {"reason": "client_no_show"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["state"], "cancelled")
        self.assertEqual(ride.cancel_category, "client_no_show")

    def test_a_client_cannot_use_the_no_show_reason(self):
        ride, client_token, _driver_token = self._assigned_ride_over_http("sub-noshow-client")
        response = self._post(f"/api/v1/rides/{ride.public_id}/cancel", client_token, {"reason": "client_no_show"})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(ride.state, "assigned")

    # --- POST /rides/{id}/dispatch : le serveur choisit le chauffeur le plus proche -----------

    def test_dispatch_proposes_the_ride_to_the_closest_online_driver(self):
        client_token, client_public_id = self._sign_in("sub-dispatch-client", "client")
        client_user = self.env["res.users"].sudo().search([("babana_public_id", "=", client_public_id)])
        _far_token, farther = self._make_dispatchable_driver("sub-dispatch-far", meters_north=250)
        _near_token, closest = self._make_dispatchable_driver("sub-dispatch-near", meters_north=40)
        ride = self._make_ride(client_user.partner_id)

        response = self._post(f"/api/v1/rides/{ride.public_id}/dispatch", client_token)

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["state"], "proposed")
        self.assertEqual(body["assignedDriverId"], closest.public_id)
        self.assertNotEqual(body["assignedDriverId"], farther.public_id)
        self.assertTrue(body["proposalExpiresAt"])

    def test_dispatch_with_nobody_nearby_is_no_driver_available(self):
        client_token, client_public_id = self._sign_in("sub-dispatch-alone", "client")
        client_user = self.env["res.users"].sudo().search([("babana_public_id", "=", client_public_id)])
        ride = self._make_ride(client_user.partner_id)

        response = self._post(f"/api/v1/rides/{ride.public_id}/dispatch", client_token)

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "NO_DRIVER_AVAILABLE")
        self.assertEqual(ride.state, "requested")

    def test_dispatch_refuses_a_driver_chosen_by_the_client(self):
        client_token, client_public_id = self._sign_in("sub-dispatch-choice", "client")
        client_user = self.env["res.users"].sudo().search([("babana_public_id", "=", client_public_id)])
        ride = self._make_ride(client_user.partner_id)

        response = self._post(
            f"/api/v1/rides/{ride.public_id}/dispatch", client_token, {"driverId": str(uuid.uuid4())}
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "VALIDATION_ERROR")
        self.assertEqual(ride.state, "requested")

    def test_a_refusal_moves_the_ride_on_to_the_next_closest_driver(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.dispatch_max_attempts", "3")
        client_token, client_public_id = self._sign_in("sub-dispatch-next-client", "client")
        client_user = self.env["res.users"].sudo().search([("babana_public_id", "=", client_public_id)])
        _first_token, first = self._make_dispatchable_driver("sub-dispatch-first", meters_north=30)
        _second_token, second = self._make_dispatchable_driver("sub-dispatch-second", meters_north=200)
        ride = self._make_ride(client_user.partner_id)
        self.assertEqual(self._post(f"/api/v1/rides/{ride.public_id}/dispatch", client_token).status_code, 200)
        self.assertEqual(ride.driver_id, first)

        headers = {"Content-Type": "application/json", "X-Realtime-Secret": os.environ["REALTIME_SHARED_SECRET"]}
        rejected = self.url_open(
            f"/api/internal/rides/{ride.public_id}/driver-rejected",
            data=json.dumps({"driverId": first.public_id, "reason": "trop loin", "expired": False}).encode(),
            headers=headers,
        )

        self.assertEqual(rejected.status_code, 200, rejected.text)
        ride.invalidate_recordset()
        self.assertEqual(ride.state, "proposed")
        self.assertEqual(ride.driver_id, second)
        self.assertEqual(ride.rejection_ids.driver_id, first)

    # --- Critère 2 : un client ne peut pas agir sur la course d'un autre ----------------------

    def test_client_cannot_dispatch_another_clients_ride(self):
        # D54 : la course d'un autre client n'est même pas visible au nom de l'appelant --
        # RIDE_NOT_FOUND (404), pas RIDE_NOT_OWNED (403) : on ne confirme pas qu'elle existe.
        _owner_token, owner_public_id = self._sign_in("sub-ride-owner", "client")
        owner_user = self.env["res.users"].sudo().search(
            [("babana_public_id", "=", owner_public_id)]
        )
        stranger_token, _ = self._sign_in("sub-ride-stranger", "client")
        self._make_dispatchable_driver("sub-ride-driver-2")
        ride = self._make_ride(owner_user.partner_id)

        response = self._post(f"/api/v1/rides/{ride.public_id}/dispatch", stranger_token)

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "RIDE_NOT_FOUND")

    # --- Critère 3 : un chauffeur non affecté ne peut pas être écrit comme acceptant ----------
    # D31 : accept n'a plus de route publique, donc plus d'identité vérifiée par ce contrôleur --
    # la garantie vient maintenant du modèle (action_accept, by_driver != self.driver_id) et de
    # l'identité de connexion côté temps réel (proposal.accept, invariant L3-01). Ce test vérifie
    # ce qui reste vrai côté Odoo : un appel du canal interne portant un chauffeur étranger à la
    # proposition échoue proprement, jamais en double affectation.

    def test_unassigned_driver_cannot_be_recorded_as_accepting(self):
        client_token, client_public_id = self._sign_in("sub-ride-client-3", "client")
        client_user = self.env["res.users"].sudo().search(
            [("babana_public_id", "=", client_public_id)]
        )
        _assigned_token, assigned_driver = self._make_dispatchable_driver("sub-ride-assigned")
        _stranger_token, stranger_driver = self._make_approved_driver("sub-ride-stranger-driver")
        ride = self._make_ride(client_user.partner_id)
        self._post(f"/api/v1/rides/{ride.public_id}/dispatch", client_token)
        self.assertEqual(ride.driver_id, assigned_driver)

        response = self._accept_via_internal_channel(ride.public_id, stranger_driver.public_id)

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "RIDE_INVALID_TRANSITION")
        self.assertEqual(ride.state, "proposed", "aucune affectation ne doit avoir eu lieu")

    # --- Un chauffeur déjà proposé à une course n'est jamais proposé à une seconde (invariant 4) --

    def test_a_driver_already_proposed_is_never_proposed_to_a_second_ride(self):
        first_client_token, first_client_public_id = self._sign_in("sub-ride-client-5a", "client")
        first_client_user = self.env["res.users"].sudo().search(
            [("babana_public_id", "=", first_client_public_id)]
        )
        second_client_token, second_client_public_id = self._sign_in("sub-ride-client-5b", "client")
        second_client_user = self.env["res.users"].sudo().search(
            [("babana_public_id", "=", second_client_public_id)]
        )
        _driver_token, driver = self._make_dispatchable_driver("sub-ride-taken")
        first_ride = self._make_ride(first_client_user.partner_id)
        second_ride = self._make_ride(second_client_user.partner_id)

        first = self._post(f"/api/v1/rides/{first_ride.public_id}/dispatch", first_client_token)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first_ride.driver_id, driver)

        second = self._post(f"/api/v1/rides/{second_ride.public_id}/dispatch", second_client_token)
        self.assertEqual(second.status_code, 404)
        self.assertEqual(second.json()["error"]["code"], "NO_DRIVER_AVAILABLE")
        self.assertEqual(second_ride.state, "requested", "aucune transition n'a eu lieu")

    # --- Critère 6 : un appel rejoué avec le même identifiant d'idempotence ne double pas ------

    def test_replaying_the_same_idempotency_key_does_not_reapply_the_transition(self):
        client_token, client_public_id = self._sign_in("sub-ride-idem", "client")
        client_user = self.env["res.users"].sudo().search(
            [("babana_public_id", "=", client_public_id)]
        )
        driver_token, driver = self._make_dispatchable_driver("sub-ride-idem-driver")
        ride = self._make_ride(client_user.partner_id)
        key = "idem-key-dispatch-1"

        first = self._post(f"/api/v1/rides/{ride.public_id}/dispatch", client_token, idempotency_key=key)
        self.assertEqual(first.status_code, 200)
        first_body = first.json()

        replay = self._post(f"/api/v1/rides/{ride.public_id}/dispatch", client_token, idempotency_key=key)
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json(), first_body)
        # Une vraie ré-application aurait échoué (la course n'est plus 'requested') -- la
        # réponse identique prouve que la transition n'a pas été rejouée, pas seulement que
        # l'erreur a été évitée par chance.
        self.assertEqual(ride.state, "proposed")

    def test_a_business_error_is_not_cached_and_can_be_retried(self):
        client_token, client_public_id = self._sign_in("sub-ride-idem-2", "client")
        client_user = self.env["res.users"].sudo().search(
            [("babana_public_id", "=", client_public_id)]
        )
        ride = self._make_ride(client_user.partner_id)
        key = "idem-key-no-driver-yet"

        # Personne à proximité : une issue métier, pas une réponse à rejouer -- le client qui
        # réessaie avec la même clé doit trouver le chauffeur arrivé entre-temps.
        first = self._post(f"/api/v1/rides/{ride.public_id}/dispatch", client_token, idempotency_key=key)
        self.assertEqual(first.status_code, 404)

        self._make_dispatchable_driver("sub-ride-idem-2-driver")
        retry = self._post(f"/api/v1/rides/{ride.public_id}/dispatch", client_token, idempotency_key=key)
        self.assertEqual(retry.status_code, 200, "un échec métier ne doit pas être mis en cache")

    # --- cancel : client, chauffeur, superviseur --------------------------------------------

    def test_client_can_cancel_own_ride(self):
        client_token, client_public_id = self._sign_in("sub-ride-cancel", "client")
        client_user = self.env["res.users"].sudo().search(
            [("babana_public_id", "=", client_public_id)]
        )
        ride = self._make_ride(client_user.partner_id)

        response = self._post(
            f"/api/v1/rides/{ride.public_id}/cancel", client_token, {"reason": "Changement de plan"}
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["state"], "cancelled")

    def test_stranger_cannot_cancel_a_ride(self):
        # D54 : un tiers ne voit pas la course -- RIDE_NOT_FOUND (404), pas RIDE_NOT_OWNED.
        _owner_token, owner_public_id = self._sign_in("sub-ride-cancel-owner", "client")
        owner_user = self.env["res.users"].sudo().search(
            [("babana_public_id", "=", owner_public_id)]
        )
        stranger_token, _ = self._sign_in("sub-ride-cancel-stranger", "client")
        ride = self._make_ride(owner_user.partner_id)

        response = self._post(f"/api/v1/rides/{ride.public_id}/cancel", stranger_token)

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "RIDE_NOT_FOUND")

    # --- Authentification ------------------------------------------------------------------

    def test_missing_authorization_header_is_unauthorized(self):
        client_token, client_public_id = self._sign_in("sub-ride-noauth", "client")
        client_user = self.env["res.users"].sudo().search(
            [("babana_public_id", "=", client_public_id)]
        )
        ride = self._make_ride(client_user.partner_id)

        response = self.url_open(
            f"/api/v1/rides/{ride.public_id}/cancel",
            data=json.dumps({}).encode(),
            headers={"Content-Type": "application/json"},
        )

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "UNAUTHORIZED")

    def test_unknown_ride_id_is_not_found(self):
        client_token, _ = self._sign_in("sub-ride-notfound", "client")

        response = self._post(f"/api/v1/rides/{uuid.uuid4()}/cancel", client_token)

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "RIDE_NOT_FOUND")

    # --- POST /rides (createRide, L4-03R) ------------------------------------------------------

    def test_create_ride_from_quote_carries_zones_and_fare_rule(self):
        # Critère d'acceptation 6 de L2-04 -- déféré depuis test_quote_controller.py, qui ne
        # peut pas le vérifier avant que POST /rides n'existe (amoa/questions/L2-04.md).
        client_token, client_public_id = self._sign_in("sub-createride-zones", "client")
        client_user = self.env["res.users"].sudo().search(
            [("babana_public_id", "=", client_public_id)]
        )
        quote_id = self._make_quote(client_token)
        quote = self.env["babana.quote"].sudo().search([("public_id", "=", quote_id)])

        response = self._post("/api/v1/rides", client_token, {"quoteId": quote_id})

        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertEqual(body["state"], "requested")
        self.assertEqual(body["amount"], quote.amount)
        ride = self.env["babana.ride"].sudo().search([("public_id", "=", body["id"])])
        self.assertEqual(ride.client_id, client_user.partner_id)
        self.assertEqual(ride.pickup_zone_id, quote.pickup_zone_id)
        self.assertEqual(ride.dropoff_zone_id, quote.dropoff_zone_id)
        self.assertEqual(ride.fare_rule_id, quote.fare_rule_id)
        self.assertEqual(ride.quote_id, quote)
        self.assertTrue(ride.fare_rule_snapshot)

    def test_create_ride_keeps_the_clients_pickup_note_trimmed(self):
        # Douala navigue par repères : l'indication du client part avec la course, telle quelle
        # (espaces de bord retirés), pour être montrée au chauffeur dès la proposition.
        client_token, _ = self._sign_in("sub-createride-note", "client")
        quote_id = self._make_quote(client_token)

        response = self._post(
            "/api/v1/rides",
            client_token,
            {"quoteId": quote_id, "pickupNote": "  Devant la pharmacie du rond-point  "},
        )

        self.assertEqual(response.status_code, 201)
        ride = self.env["babana.ride"].sudo().search([("public_id", "=", response.json()["id"])])
        self.assertEqual(ride.pickup_note, "Devant la pharmacie du rond-point")

    def test_create_ride_without_pickup_note_stores_none(self):
        client_token, _ = self._sign_in("sub-createride-nonote", "client")
        quote_id = self._make_quote(client_token)

        response = self._post("/api/v1/rides", client_token, {"quoteId": quote_id})

        self.assertEqual(response.status_code, 201)
        ride = self.env["babana.ride"].sudo().search([("public_id", "=", response.json()["id"])])
        self.assertFalse(ride.pickup_note)

    def test_create_ride_with_an_invalid_pickup_note_is_a_validation_error(self):
        client_token, _ = self._sign_in("sub-createride-badnote", "client")
        for bad in ("x" * 141, "   ", 42):
            quote_id = self._make_quote(client_token)
            response = self._post("/api/v1/rides", client_token, {"quoteId": quote_id, "pickupNote": bad})
            self.assertEqual(response.status_code, 400, bad)
            self.assertEqual(response.json()["error"]["code"], "VALIDATION_ERROR")
        self.assertFalse(
            self.env["babana.ride"].sudo().search([("pickup_note", "=", "x" * 141)]),
            "aucune course créée avec une indication refusée",
        )

    def test_create_ride_with_missing_quote_id_is_a_validation_error(self):
        client_token, _ = self._sign_in("sub-createride-badbody", "client")

        response = self._post("/api/v1/rides", client_token, {})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "VALIDATION_ERROR")

    def test_create_ride_with_unknown_quote_id_is_quote_not_found(self):
        client_token, _ = self._sign_in("sub-createride-unknown", "client")

        response = self._post(
            "/api/v1/rides", client_token, {"quoteId": str(uuid.uuid4())}
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "QUOTE_NOT_FOUND")

    def test_create_ride_with_expired_quote_is_quote_expired(self):
        client_token, _ = self._sign_in("sub-createride-expired", "client")
        quote_id = self._make_quote(client_token)
        quote = self.env["babana.quote"].sudo().search([("public_id", "=", quote_id)])
        quote.sudo().write({"expires_at": "2000-01-01 00:00:00"})

        response = self._post("/api/v1/rides", client_token, {"quoteId": quote_id})

        self.assertEqual(response.status_code, 410)
        self.assertEqual(response.json()["error"]["code"], "QUOTE_EXPIRED")

    def test_create_ride_with_another_clients_quote_is_quote_not_found(self):
        owner_token, _ = self._sign_in("sub-createride-owner", "client")
        stranger_token, _ = self._sign_in("sub-createride-stranger", "client")
        quote_id = self._make_quote(owner_token)

        response = self._post("/api/v1/rides", stranger_token, {"quoteId": quote_id})

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "QUOTE_NOT_FOUND")

    # --- POST /rides/{id}/complete (L4-03R) ------------------------------------------------------

    def test_full_happy_path_up_to_completed(self):
        client_token, client_public_id = self._sign_in("sub-complete-client", "client")
        driver_token, driver = self._make_dispatchable_driver("sub-complete-driver")
        quote_id = self._make_quote(client_token)
        quote = self.env["babana.quote"].sudo().search([("public_id", "=", quote_id)])

        create_response = self._post("/api/v1/rides", client_token, {"quoteId": quote_id})
        ride_id = create_response.json()["id"]

        self._post(f"/api/v1/rides/{ride_id}/dispatch", client_token)
        self._accept_via_internal_channel(ride_id, driver.public_id)
        self._post(f"/api/v1/rides/{ride_id}/start", driver_token)

        # J24 (amoa/questions/L6-13.md) : la fin de course ne porte que la décision -- corps vide.
        # Le service temps réel n'a rien accumulé dans cet environnement de test (pas de course
        # démarrée côté realtime) : la réponse le dit explicitement.
        complete_response = self._post(f"/api/v1/rides/{ride_id}/complete", driver_token, {})

        self.assertEqual(complete_response.status_code, 200)
        body = complete_response.json()
        self.assertEqual(body["state"], "completed")
        self.assertFalse(body["measured"])
        self.assertIsNone(body["distanceMeters"])
        self.assertIsNone(body["durationSeconds"])
        # Le montant final est celui de la distance de référence (L4-04) : la décision financière
        # existe même sans relevé de trajet.
        self.assertEqual(body["amount"], quote.amount)

        ride = self.env["babana.ride"].sudo().search([("public_id", "=", ride_id)])
        self.assertFalse(ride.trip_measured)
        self.assertFalse(ride.track_polyline)
        self.assertEqual(ride.final_amount, quote.amount)

    def test_complete_by_unassigned_driver_is_rejected(self):
        client_token, _ = self._sign_in("sub-complete-client-2", "client")
        driver_token, driver = self._make_dispatchable_driver("sub-complete-driver-2")
        stranger_token, _stranger_driver = self._make_approved_driver("sub-complete-stranger")
        quote_id = self._make_quote(client_token)
        ride_id = self._post(
            "/api/v1/rides", client_token, {"quoteId": quote_id}
        ).json()["id"]
        self._post(f"/api/v1/rides/{ride_id}/dispatch", client_token)
        self._accept_via_internal_channel(ride_id, driver.public_id)
        self._post(f"/api/v1/rides/{ride_id}/start", driver_token)

        response = self._post(f"/api/v1/rides/{ride_id}/complete", stranger_token, {})

        # D54 : un chauffeur non affecté ne voit pas la course -- RIDE_NOT_FOUND (404).
        # DRIVER_NOT_IN_PROPOSAL (403) reste pour l'appelant qui VOIT la course sans pouvoir la
        # conduire (le client, cf. test_client_cannot_drive_own_ride).
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "RIDE_NOT_FOUND")

    def test_complete_records_the_realtime_measurement_when_one_is_available(self):
        # L3-10 : quand le service temps réel a accumulé un trajet, _complete_ride le lit AVANT la
        # transition (une lecture, jamais une écriture Redis -- sans risque D25/D32) et Odoo
        # l'enregistre. Ici on simule l'accumulation par un patch de fetch_ride_measurement ;
        # la vraie accumulation contre Redis est prouvée côté service (accumulator.test.ts).
        client_token, _ = self._sign_in("sub-complete-measured", "client")
        driver_token, driver = self._make_dispatchable_driver("sub-complete-measured-drv")
        quote_id = self._make_quote(client_token)
        ride_id = self._post("/api/v1/rides", client_token, {"quoteId": quote_id}).json()["id"]
        self._post(f"/api/v1/rides/{ride_id}/dispatch", client_token)
        self._accept_via_internal_channel(ride_id, driver.public_id)
        self._post(f"/api/v1/rides/{ride_id}/start", driver_token)

        measurement = {"distance_meters": 4200, "duration_seconds": 615, "polyline": "abc123def"}
        with patch.object(realtime_client, "fetch_ride_measurement", return_value=measurement):
            response = self._post(f"/api/v1/rides/{ride_id}/complete", driver_token, {})

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["measured"])
        self.assertEqual(body["distanceMeters"], 4200)
        self.assertEqual(body["durationSeconds"], 615)

        ride = self.env["babana.ride"].sudo().search([("public_id", "=", ride_id)])
        self.assertTrue(ride.trip_measured)
        self.assertAlmostEqual(ride.actual_distance_km, 4.2)
        self.assertAlmostEqual(ride.actual_duration_minutes, 615 / 60.0)
        self.assertEqual(ride.track_polyline, "abc123def")

    def test_complete_ignores_any_body_it_receives(self):
        # J24 : la fin de course ne porte que la décision. Un corps -- même l'ancien
        # `{distanceMeters, durationSeconds, polyline}` d'une vieille app -- est simplement ignoré,
        # jamais honoré : le relevé de trajet vient du service temps réel (L3-10), pas de l'app.
        client_token, _ = self._sign_in("sub-complete-client-3", "client")
        driver_token, driver = self._make_dispatchable_driver("sub-complete-driver-3")
        quote_id = self._make_quote(client_token)
        ride_id = self._post(
            "/api/v1/rides", client_token, {"quoteId": quote_id}
        ).json()["id"]
        self._post(f"/api/v1/rides/{ride_id}/dispatch", client_token)
        self._accept_via_internal_channel(ride_id, driver.public_id)
        self._post(f"/api/v1/rides/{ride_id}/start", driver_token)

        response = self._post(
            f"/api/v1/rides/{ride_id}/complete",
            driver_token,
            {"distanceMeters": 99999, "durationSeconds": 1, "polyline": "menteur"},
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["state"], "completed")
        self.assertFalse(body["measured"])
        self.assertIsNone(body["distanceMeters"])
        ride = self.env["babana.ride"].sudo().search([("public_id", "=", ride_id)])
        self.assertFalse(ride.track_polyline)

    # --- POST /rides/{id}/settle (L4-05) --------------------------------------------------------

    def _ride_ready_to_settle(self, label):
        client_token, _ = self._sign_in(f"sub-settle-client-{label}", "client")
        driver_token, driver = self._make_dispatchable_driver(f"sub-settle-driver-{label}")
        quote_id = self._make_quote(client_token)
        quote = self.env["babana.quote"].sudo().search([("public_id", "=", quote_id)])
        ride_id = self._post("/api/v1/rides", client_token, {"quoteId": quote_id}).json()["id"]
        self._post(f"/api/v1/rides/{ride_id}/dispatch", client_token)
        self._accept_via_internal_channel(ride_id, driver.public_id)
        self._post(f"/api/v1/rides/{ride_id}/start", driver_token)
        self._post(f"/api/v1/rides/{ride_id}/complete", driver_token, {})
        return ride_id, driver_token, driver, quote

    def test_full_happy_path_up_to_settled(self):
        ride_id, driver_token, driver, quote = self._ride_ready_to_settle("happy")

        response = self._post(
            f"/api/v1/rides/{ride_id}/settle", driver_token, {"amountCollected": quote.amount}
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["rideId"], ride_id)
        self.assertEqual(body["state"], "settled")
        self.assertEqual(body["amountCollected"], quote.amount)
        self.assertEqual(body["driverCashBalance"], quote.amount)
        # J24 (amoa/questions/L6-14.md) : la réponse dit ce qui s'est passé -- l'app n'infère plus.
        self.assertFalse(body["cashLimitReached"])
        self.assertGreater(body["cashLimit"], 0)
        self.assertEqual(body["marginRemaining"], body["cashLimit"] - body["driverCashBalance"])

        ride = self.env["babana.ride"].sudo().search([("public_id", "=", ride_id)])
        self.assertEqual(ride.state, "settled")
        self.assertTrue(ride.settled_at)

    def test_settle_response_announces_crossing_the_cash_limit(self):
        # J24 : franchir le plafond n'est pas une erreur -- la transition réussit (200), mais la
        # réponse porte cashLimitReached=true et marginRemaining=0, sans que l'app ait à comparer
        # le solde à un plafond qu'elle irait chercher ailleurs.
        # Plafond bien en dessous de n'importe quel tarif : cet encaissement le franchit à coup sûr.
        self.env["ir.config_parameter"].sudo().set_param("babana.cash_limit", "100")
        ride_id, driver_token, driver, quote = self._ride_ready_to_settle("cross-limit")
        driver.write({"is_online": True})

        response = self._post(
            f"/api/v1/rides/{ride_id}/settle", driver_token, {"amountCollected": quote.amount}
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["state"], "settled")
        self.assertTrue(body["cashLimitReached"])
        self.assertEqual(body["cashLimit"], 100)
        self.assertEqual(body["marginRemaining"], 0)
        driver.invalidate_recordset()
        self.assertFalse(driver.is_online)

    # --- Critère 4 : le chauffeur ne peut pas saisir un montant différent --------------------

    def test_settle_with_a_different_amount_is_a_settlement_mismatch(self):
        ride_id, driver_token, _driver, quote = self._ride_ready_to_settle("mismatch")

        response = self._post(
            f"/api/v1/rides/{ride_id}/settle", driver_token, {"amountCollected": quote.amount + 1}
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "SETTLEMENT_AMOUNT_MISMATCH")
        ride = self.env["babana.ride"].sudo().search([("public_id", "=", ride_id)])
        self.assertEqual(ride.state, "completed", "aucune transition ne doit avoir eu lieu")

    # --- Critère 3 : un double encaissement est impossible ------------------------------------

    def test_double_settle_is_rejected(self):
        ride_id, driver_token, _driver, quote = self._ride_ready_to_settle("double")
        self._post(
            f"/api/v1/rides/{ride_id}/settle", driver_token, {"amountCollected": quote.amount}
        )

        response = self._post(
            f"/api/v1/rides/{ride_id}/settle", driver_token, {"amountCollected": quote.amount}
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "RIDE_INVALID_TRANSITION")

    def test_settle_by_unassigned_driver_is_rejected(self):
        ride_id, _driver_token, _driver, quote = self._ride_ready_to_settle("stranger")
        stranger_token, _stranger_driver = self._make_approved_driver("sub-settle-stranger")

        response = self._post(
            f"/api/v1/rides/{ride_id}/settle", stranger_token, {"amountCollected": quote.amount}
        )

        # D54 : un chauffeur non affecté ne voit pas la course -- RIDE_NOT_FOUND (404).
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "RIDE_NOT_FOUND")

    def test_client_cannot_drive_own_ride(self):
        # Le pendant de D54 : le client VOIT sa course (branche client_id de la règle) mais n'a
        # pas de fiche chauffeur -- il ne peut pas la démarrer. Le code reste
        # DRIVER_NOT_IN_PROPOSAL (403) : ce n'est pas « introuvable », c'est « pas votre rôle ».
        client_token, client_public_id = self._sign_in("sub-client-drives", "client")
        client_user = self.env["res.users"].sudo().search(
            [("babana_public_id", "=", client_public_id)]
        )
        ride = self._make_ride(client_user.partner_id)

        response = self._post(f"/api/v1/rides/{ride.public_id}/start", client_token)

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "DRIVER_NOT_IN_PROPOSAL")

    def test_settle_with_missing_amount_is_a_validation_error(self):
        ride_id, driver_token, _driver, _quote = self._ride_ready_to_settle("badbody")

        response = self._post(f"/api/v1/rides/{ride_id}/settle", driver_token, {})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "VALIDATION_ERROR")
