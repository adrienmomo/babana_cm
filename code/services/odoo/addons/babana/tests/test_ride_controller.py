# Tests des endpoints du cycle de vie de la course (L4-03). Cinq endpoints sur huit du contrat
# -- voir amoa/questions/L4-03.md pour ce qui manque et pourquoi (createRide/complete/settle/
# rate dépendent de tâches non prévues cette nuit). Le critère 7 (« aucune condition métier dans
# le contrôleur ») n'est pas un comportement observable à l'exécution -- vérifié par construction
# (controllers/ride.py ne teste jamais un champ métier, seulement l'identité de l'appelant) et en
# revue, pas par un test ici.
#
# Depuis L3-17, select-driver réserve réellement contre le service temps réel (D26) : un
# chauffeur approuvé par simple RPC (_make_approved_driver) n'est plus sélectionnable tel quel --
# il doit être réellement passé en ligne, avoir émis une position, et avoir été montré au client
# via nearby.drivers (précondition C-03, critère 8). _realtime_ws.py fait les trois par le
# chemin réel (WebSocket), jamais par une écriture Redis directe.
from __future__ import annotations

import json
import os
import uuid

import requests

from odoo.tests.common import HttpCase, tagged

from ._realtime_ws import bring_driver_online, make_driver_visible_to_client
from ._redis_fixture import seed_driver_profile


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


@tagged("post_install", "-at_install")
class TestRideController(HttpCase):
    @classmethod
    def _request_handler(cls, s, r, **kw):
        # Sens Odoo -> temps réel (L3-17) : select-driver et complete appellent réellement le
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

    # Position par défaut de ces fixtures -- même point que _make_ride ci-dessous, pour que le
    # chauffeur tombe dans le rayon interrogé par défaut par make_driver_visible_to_client.
    _DEFAULT_POSITION = {"latitude": 4.05, "longitude": 9.70}

    def _make_selectable_driver(self, sub, *client_tokens):
        """Chauffeur approuvé, réellement en ligne et positionné (L3-01/L3-02/L3-04), et montré
        via nearby.drivers à chacun des clients fournis (précondition C-03, critère 8) -- sans ce
        dernier point, select-driver renverrait DRIVER_NOT_IN_LAST_LIST (traduit en
        DRIVER_ALREADY_TAKEN, amoa/questions/L3-17.md §3) pour un chauffeur pourtant disponible."""
        driver_token, driver = self._make_approved_driver(sub)
        bring_driver_online(
            driver_token, self._DEFAULT_POSITION["latitude"], self._DEFAULT_POSITION["longitude"]
        )
        # Champ-pont (amoa/questions/L3-05.md, code/docs/bridge-fields.md) : nearby.drivers omet
        # TOUJOURS un chauffeur sans profil en cache -- aucun canal Odoo -> temps réel ne le
        # peuple encore (L3-16, jamais implémentée). Seedé directement, comme test/nearby.test.ts
        # le fait déjà côté TypeScript.
        seed_driver_profile(driver.public_id, first_name=f"Chauffeur {sub}")
        for client_token in client_tokens:
            make_driver_visible_to_client(client_token, driver.public_id, self._DEFAULT_POSITION)
        return driver_token, driver

    def _post(self, path, token, body=None, idempotency_key=None):
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return self.url_open(path, data=json.dumps(body or {}).encode(), headers=headers)

    def _make_ride(self, client_partner):
        return self.env["babana.ride"].action_request(
            {
                "client_id": client_partner.id,
                "pickup_latitude": 4.05,
                "pickup_longitude": 9.70,
                "dropoff_latitude": 4.06,
                "dropoff_longitude": 9.77,
            }
        )

    # --- L4-03R : POST /rides (createRide) et POST /rides/{id}/complete -----------------------

    _QUOTE_ORIGIN = {"latitude": 4.0483, "longitude": 9.6934}
    _QUOTE_DESTINATION = {"latitude": 4.0270, "longitude": 9.7040}

    def _make_quote(self, client_token):
        response = self._post(
            "/api/v1/quote",
            client_token,
            {"origin": self._QUOTE_ORIGIN, "destination": self._QUOTE_DESTINATION},
        )
        self.assertEqual(response.status_code, 200)
        return response.json()["quoteId"]

    # --- Parcours nominal, jusqu'à in_progress --------------------------------------------------

    def test_full_happy_path_up_to_in_progress(self):
        client_token, client_public_id = self._sign_in("sub-ride-client", "client")
        client_user = self.env["res.users"].sudo().search(
            [("babana_public_id", "=", client_public_id)]
        )
        driver_token, driver = self._make_selectable_driver("sub-ride-driver", client_token)
        ride = self._make_ride(client_user.partner_id)

        select_response = self._post(
            f"/api/v1/rides/{ride.public_id}/select-driver",
            client_token,
            {"driverId": driver.public_id},
        )
        self.assertEqual(select_response.status_code, 200)
        select_body = select_response.json()
        self.assertEqual(select_body["state"], "proposed")
        self.assertEqual(select_body["assignedDriverId"], driver.public_id)
        self.assertTrue(select_body["proposalExpiresAt"])

        accept_response = self._post(f"/api/v1/rides/{ride.public_id}/accept", driver_token)
        self.assertEqual(accept_response.status_code, 200)
        self.assertEqual(accept_response.json()["state"], "assigned")

        start_response = self._post(f"/api/v1/rides/{ride.public_id}/start", driver_token)
        self.assertEqual(start_response.status_code, 200)
        self.assertEqual(start_response.json()["state"], "in_progress")

    # --- Critère 1 : requête non conforme rejetée avant tout traitement -----------------------

    def test_select_driver_without_driver_id_is_a_validation_error(self):
        client_token, client_public_id = self._sign_in("sub-ride-badbody", "client")
        client_user = self.env["res.users"].sudo().search(
            [("babana_public_id", "=", client_public_id)]
        )
        ride = self._make_ride(client_user.partner_id)

        response = self._post(f"/api/v1/rides/{ride.public_id}/select-driver", client_token, {})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "VALIDATION_ERROR")

    # --- Critère 2 : un client ne peut pas agir sur la course d'un autre ----------------------

    def test_client_cannot_select_driver_on_another_clients_ride(self):
        _owner_token, owner_public_id = self._sign_in("sub-ride-owner", "client")
        owner_user = self.env["res.users"].sudo().search(
            [("babana_public_id", "=", owner_public_id)]
        )
        stranger_token, _ = self._sign_in("sub-ride-stranger", "client")
        driver_token, driver = self._make_approved_driver("sub-ride-driver-2")
        ride = self._make_ride(owner_user.partner_id)

        response = self._post(
            f"/api/v1/rides/{ride.public_id}/select-driver",
            stranger_token,
            {"driverId": driver.public_id},
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "RIDE_NOT_OWNED")

    # --- Critère 3 : un chauffeur non affecté tentant accept est rejeté -----------------------

    def test_unassigned_driver_cannot_accept(self):
        client_token, client_public_id = self._sign_in("sub-ride-client-3", "client")
        client_user = self.env["res.users"].sudo().search(
            [("babana_public_id", "=", client_public_id)]
        )
        _assigned_token, assigned_driver = self._make_selectable_driver("sub-ride-assigned", client_token)
        stranger_token, _stranger_driver = self._make_approved_driver("sub-ride-stranger-driver")
        ride = self._make_ride(client_user.partner_id)
        self._post(
            f"/api/v1/rides/{ride.public_id}/select-driver",
            client_token,
            {"driverId": assigned_driver.public_id},
        )

        response = self._post(f"/api/v1/rides/{ride.public_id}/accept", stranger_token)

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "DRIVER_NOT_IN_PROPOSAL")

    # --- Critère 5 (chemin rapide, pas la garantie L3-06 -- amoa/questions/L4-03.md) ----------

    def test_selecting_an_already_proposed_driver_is_rejected_without_a_transition(self):
        first_client_token, first_client_public_id = self._sign_in("sub-ride-client-5a", "client")
        first_client_user = self.env["res.users"].sudo().search(
            [("babana_public_id", "=", first_client_public_id)]
        )
        second_client_token, second_client_public_id = self._sign_in(
            "sub-ride-client-5b", "client"
        )
        second_client_user = self.env["res.users"].sudo().search(
            [("babana_public_id", "=", second_client_public_id)]
        )
        driver_token, driver = self._make_selectable_driver(
            "sub-ride-taken", first_client_token, second_client_token
        )
        first_ride = self._make_ride(first_client_user.partner_id)
        second_ride = self._make_ride(second_client_user.partner_id)

        first = self._post(
            f"/api/v1/rides/{first_ride.public_id}/select-driver",
            first_client_token,
            {"driverId": driver.public_id},
        )
        self.assertEqual(first.status_code, 200)

        second = self._post(
            f"/api/v1/rides/{second_ride.public_id}/select-driver",
            second_client_token,
            {"driverId": driver.public_id},
        )
        self.assertEqual(second.status_code, 409)
        self.assertEqual(second.json()["error"]["code"], "DRIVER_ALREADY_TAKEN")
        self.assertEqual(second_ride.state, "requested", "aucune transition n'a eu lieu")

    # --- Critère 6 : un appel rejoué avec le même identifiant d'idempotence ne double pas ------

    def test_replaying_the_same_idempotency_key_does_not_reapply_the_transition(self):
        client_token, client_public_id = self._sign_in("sub-ride-idem", "client")
        client_user = self.env["res.users"].sudo().search(
            [("babana_public_id", "=", client_public_id)]
        )
        driver_token, driver = self._make_selectable_driver("sub-ride-idem-driver", client_token)
        ride = self._make_ride(client_user.partner_id)
        key = "idem-key-select-driver-1"

        first = self._post(
            f"/api/v1/rides/{ride.public_id}/select-driver",
            client_token,
            {"driverId": driver.public_id},
            idempotency_key=key,
        )
        self.assertEqual(first.status_code, 200)
        first_body = first.json()

        replay = self._post(
            f"/api/v1/rides/{ride.public_id}/select-driver",
            client_token,
            {"driverId": driver.public_id},
            idempotency_key=key,
        )
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
        key = "idem-key-unknown-driver"

        first = self._post(
            f"/api/v1/rides/{ride.public_id}/select-driver",
            client_token,
            {"driverId": str(uuid.uuid4())},
            idempotency_key=key,
        )
        self.assertEqual(first.status_code, 400)

        driver_token, driver = self._make_selectable_driver("sub-ride-idem-2-driver", client_token)
        retry = self._post(
            f"/api/v1/rides/{ride.public_id}/select-driver",
            client_token,
            {"driverId": driver.public_id},
            idempotency_key=key,
        )
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
        _owner_token, owner_public_id = self._sign_in("sub-ride-cancel-owner", "client")
        owner_user = self.env["res.users"].sudo().search(
            [("babana_public_id", "=", owner_public_id)]
        )
        stranger_token, _ = self._sign_in("sub-ride-cancel-stranger", "client")
        ride = self._make_ride(owner_user.partner_id)

        response = self._post(f"/api/v1/rides/{ride.public_id}/cancel", stranger_token)

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "RIDE_NOT_OWNED")

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
        driver_token, driver = self._make_selectable_driver("sub-complete-driver", client_token)
        quote_id = self._make_quote(client_token)
        quote = self.env["babana.quote"].sudo().search([("public_id", "=", quote_id)])

        create_response = self._post("/api/v1/rides", client_token, {"quoteId": quote_id})
        ride_id = create_response.json()["id"]

        self._post(
            f"/api/v1/rides/{ride_id}/select-driver", client_token, {"driverId": driver.public_id}
        )
        self._post(f"/api/v1/rides/{ride_id}/accept", driver_token)
        self._post(f"/api/v1/rides/{ride_id}/start", driver_token)

        complete_response = self._post(
            f"/api/v1/rides/{ride_id}/complete",
            driver_token,
            {"distanceMeters": 5200, "durationSeconds": 900, "polyline": "abc123"},
        )

        self.assertEqual(complete_response.status_code, 200)
        body = complete_response.json()
        self.assertEqual(body["state"], "completed")
        self.assertEqual(body["distanceMeters"], 5200)
        self.assertEqual(body["durationSeconds"], 900)
        # Le montant final est celui de la distance de référence (L4-04), pas recalculé sur les
        # 5200 m parcourus transmis ci-dessus.
        self.assertEqual(body["amount"], quote.amount)

        ride = self.env["babana.ride"].sudo().search([("public_id", "=", ride_id)])
        self.assertEqual(ride.track_polyline, "abc123")
        self.assertEqual(ride.final_amount, quote.amount)

    def test_complete_by_unassigned_driver_is_rejected(self):
        client_token, _ = self._sign_in("sub-complete-client-2", "client")
        driver_token, driver = self._make_selectable_driver("sub-complete-driver-2", client_token)
        stranger_token, _stranger_driver = self._make_approved_driver("sub-complete-stranger")
        quote_id = self._make_quote(client_token)
        ride_id = self._post(
            "/api/v1/rides", client_token, {"quoteId": quote_id}
        ).json()["id"]
        self._post(
            f"/api/v1/rides/{ride_id}/select-driver", client_token, {"driverId": driver.public_id}
        )
        self._post(f"/api/v1/rides/{ride_id}/accept", driver_token)
        self._post(f"/api/v1/rides/{ride_id}/start", driver_token)

        response = self._post(
            f"/api/v1/rides/{ride_id}/complete",
            stranger_token,
            {"distanceMeters": 100, "durationSeconds": 60, "polyline": "x"},
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "DRIVER_NOT_IN_PROPOSAL")

    def test_complete_with_missing_fields_is_a_validation_error(self):
        client_token, _ = self._sign_in("sub-complete-client-3", "client")
        driver_token, driver = self._make_selectable_driver("sub-complete-driver-3", client_token)
        quote_id = self._make_quote(client_token)
        ride_id = self._post(
            "/api/v1/rides", client_token, {"quoteId": quote_id}
        ).json()["id"]
        self._post(
            f"/api/v1/rides/{ride_id}/select-driver", client_token, {"driverId": driver.public_id}
        )
        self._post(f"/api/v1/rides/{ride_id}/accept", driver_token)
        self._post(f"/api/v1/rides/{ride_id}/start", driver_token)

        response = self._post(f"/api/v1/rides/{ride_id}/complete", driver_token, {})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "VALIDATION_ERROR")
