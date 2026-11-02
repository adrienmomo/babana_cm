# Notation réciproque (2 novembre) : le chauffeur note son client à la fin de la course, et peut
# corriger sa note ensuite depuis son historique -- à la différence du client, dont la note du
# chauffeur est définitive (L4-09). Les deux moyennes voyagent dans le profil (`GET /me`), avec la
# même règle « nouveau » sous babana.rating_min_count avis.
from __future__ import annotations

import json
import uuid

from odoo.tests.common import HttpCase, tagged

from ..controllers.auth import _issue_access_token


@tagged("post_install", "-at_install")
class TestClientRating(HttpCase):
    def setUp(self):
        super().setUp()
        self.env["ir.config_parameter"].sudo().set_param("babana.rating_min_count", "3")
        self.driver_token, self.driver = self._driver("sub-crating-driver")

    def _driver(self, sub):
        user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub=sub, email=f"{sub}@example.invalid", name=f"Chauffeur {sub}", role="driver"
        )
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
            self.env["babana.driver.document"].sudo().create(vals)
        moto = self.env["babana.motorcycle"].sudo().create({"license_plate": f"LT-{uuid.uuid4().hex[:4].upper()}-CR"})
        moto.write({"driver_id": driver.id})
        driver.invalidate_recordset()
        driver.sudo().action_approve(new_employee_name=f"Chauffeur {sub}")
        token, _ = _issue_access_token(user)
        return token, driver

    def _client(self, sub):
        user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub=sub, email=f"{sub}@example.invalid", name=f"Client {sub}", role="client"
        )
        token, _ = _issue_access_token(user)
        return token, user.partner_id

    def _ride(self, client, *, until="settled", driver=None):
        driver = driver or self.driver
        ride = self.env["babana.ride"].action_request(
            {
                "client_id": client.id,
                "pickup_latitude": 4.0447, "pickup_longitude": 9.6996,
                "dropoff_latitude": 4.0622, "dropoff_longitude": 9.7108,
                "reference_distance_km": 4.2,
                "pickup_label": "Carrefour Tiff",
                "dropoff_label": "Rond-point Deïdo",
            }
        )
        ride.action_propose(by_partner=client, driver=driver)
        if until == "cancelled":
            ride.action_cancel(actor_role="client", actor_record=client, reason="Changement de plan")
            return ride
        ride.action_accept(by_driver=driver)
        ride.action_start(by_driver=driver)
        ride.action_complete(by_driver=driver, final_amount=700)
        if until == "settled":
            ride.action_settle(by_driver=driver, amount_collected=700)
        return ride

    def _rate_client(self, ride, token, body):
        return self.url_open(
            f"/api/v1/rides/{ride.public_id}/client-rating",
            data=json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )

    def _rate_driver(self, ride, token, rating):
        return self.url_open(
            f"/api/v1/rides/{ride.public_id}/rate",
            data=json.dumps({"rating": rating}).encode(),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )

    def _get(self, path, token):
        return self.url_open(path, headers={"Authorization": f"Bearer {token}"})

    def _stored(self, ride):
        return self.env["babana.client.rating"].sudo().search([("ride_id", "=", ride.id)])

    # --- Le chauffeur note son client --------------------------------------------------------

    def test_the_driver_rates_the_client_of_a_settled_ride(self):
        _token, client = self._client("sub-crating-1")
        ride = self._ride(client)

        response = self._rate_client(ride, self.driver_token, {"rating": 4, "comment": "Ponctuel"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"rideId": ride.public_id, "rating": 4})
        stored = self._stored(ride)
        self.assertEqual((stored.rating, stored.comment, stored.client_id, stored.driver_id), (4, "Ponctuel", client, self.driver))
        self.assertEqual(ride.state, "settled", "noter n'est pas une transition")

    def test_a_completed_ride_not_yet_settled_can_already_be_rated(self):
        # L'écran d'encaissement propose la note : une confirmation encore en file hors connexion
        # ne doit pas la faire refuser.
        _token, client = self._client("sub-crating-2")
        ride = self._ride(client, until="completed")

        response = self._rate_client(ride, self.driver_token, {"rating": 5})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._stored(ride).rating, 5)

    def test_a_cancelled_ride_cannot_be_rated(self):
        _token, client = self._client("sub-crating-3")
        ride = self._ride(client, until="cancelled")

        response = self._rate_client(ride, self.driver_token, {"rating": 1})

        self.assertIn(response.status_code, (403, 404))
        self.assertFalse(self._stored(ride))

    def test_the_driver_can_change_his_rating_afterwards_one_record_per_ride(self):
        _token, client = self._client("sub-crating-4")
        ride = self._ride(client)
        self.assertEqual(self._rate_client(ride, self.driver_token, {"rating": 2}).status_code, 200)

        response = self._rate_client(ride, self.driver_token, {"rating": 5})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"rideId": ride.public_id, "rating": 5})
        self.assertEqual(len(self._stored(ride)), 1)
        self.assertEqual(self._stored(ride).rating, 5)

    def test_the_client_cannot_rate_himself_through_this_route(self):
        client_token, client = self._client("sub-crating-5")
        ride = self._ride(client)

        response = self._rate_client(ride, client_token, {"rating": 5})

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "RIDE_NOT_OWNED")
        self.assertFalse(self._stored(ride))

    def test_another_driver_does_not_even_see_the_ride(self):
        _token, client = self._client("sub-crating-6")
        ride = self._ride(client)
        other_token, _other = self._driver("sub-crating-6-other")

        response = self._rate_client(ride, other_token, {"rating": 1})

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "RIDE_NOT_FOUND")

    def test_out_of_range_or_malformed_rating_is_rejected(self):
        _token, client = self._client("sub-crating-7")
        ride = self._ride(client)
        for body in ({"rating": 0}, {"rating": 6}, {"rating": 4.5}, {"rating": True}, {}, {"rating": 3, "comment": "x" * 501}):
            response = self._rate_client(ride, self.driver_token, body)
            self.assertEqual(response.status_code, 400, body)
            self.assertEqual(response.json()["error"]["code"], "VALIDATION_ERROR")
        self.assertFalse(self._stored(ride))

    def test_the_client_rating_of_the_driver_stays_final(self):
        # L'autre sens ne change pas : la note du client sur le chauffeur reste définitive.
        client_token, client = self._client("sub-crating-8")
        ride = self._ride(client)
        self.assertEqual(self._rate_driver(ride, client_token, 5).status_code, 200)

        response = self._rate_driver(ride, client_token, 1)

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "RATING_ALREADY_SUBMITTED")

    # --- Historique du chauffeur -------------------------------------------------------------

    def test_driver_history_lists_his_ended_rides_with_his_rating_of_the_client(self):
        _token, client = self._client("sub-crating-9")
        rated = self._ride(client)
        unrated = self._ride(client, until="completed")
        cancelled = self._ride(client, until="cancelled")
        self._rate_client(rated, self.driver_token, {"rating": 3})
        _other_token, other_driver = self._driver("sub-crating-9-other")
        self._ride(client, driver=other_driver)

        response = self._get("/api/v1/drivers/me/rides", self.driver_token)

        self.assertEqual(response.status_code, 200)
        body = response.json()
        by_id = {entry["id"]: entry for entry in body["rides"]}
        self.assertEqual(set(by_id), {rated.public_id, unrated.public_id, cancelled.public_id}, "seulement ses courses")
        self.assertEqual(by_id[rated.public_id]["clientRating"], 3)
        self.assertTrue(by_id[rated.public_id]["clientRatingAllowed"])
        self.assertEqual(by_id[rated.public_id]["status"], "settled")
        self.assertEqual(by_id[rated.public_id]["amount"], 700)
        self.assertEqual(by_id[rated.public_id]["pickupLabel"], "Carrefour Tiff")
        self.assertIsNone(by_id[unrated.public_id]["clientRating"])
        self.assertTrue(by_id[unrated.public_id]["clientRatingAllowed"])
        self.assertFalse(by_id[cancelled.public_id]["clientRatingAllowed"])
        self.assertNotIn("Client sub-crating-9", json.dumps(body), "le nom du client ne sort pas après la course")
        self.assertIsNone(body["nextCursor"])

    def test_driver_history_is_paginated_by_the_server_page_size(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.ride_history_page_size", "2")
        _token, client = self._client("sub-crating-10")
        rides = [self._ride(client) for _ in range(3)]

        first = self._get("/api/v1/drivers/me/rides", self.driver_token).json()
        second = self._get(f"/api/v1/drivers/me/rides?cursor={first['nextCursor']}", self.driver_token).json()

        self.assertEqual(len(first["rides"]), 2)
        self.assertEqual(len(second["rides"]), 1)
        self.assertIsNone(second["nextCursor"])
        self.assertEqual(
            {entry["id"] for entry in first["rides"] + second["rides"]}, {ride.public_id for ride in rides}
        )

    def test_a_client_has_no_driver_history(self):
        client_token, _client = self._client("sub-crating-11")

        response = self._get("/api/v1/drivers/me/rides", client_token)

        # Même réponse que GET /drivers/me/cash pour un compte sans fiche chauffeur.
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "UNAUTHORIZED")

    # --- Les deux moyennes dans le profil ----------------------------------------------------

    def test_the_client_profile_carries_his_average_once_enough_ratings(self):
        client_token, client = self._client("sub-crating-12")
        self.assertEqual(self._get("/api/v1/me", client_token).json()["rating"], {"average": None, "count": 0})
        rides = [self._ride(client) for _ in range(3)]
        self._rate_client(rides[0], self.driver_token, {"rating": 5})
        self._rate_client(rides[1], self.driver_token, {"rating": 4})
        self.assertEqual(
            self._get("/api/v1/me", client_token).json()["rating"], {"average": None, "count": 2}, "« nouveau » sous le seuil"
        )

        self._rate_client(rides[2], self.driver_token, {"rating": 4})

        self.assertEqual(self._get("/api/v1/me", client_token).json()["rating"], {"average": 4.3, "count": 3})

    def test_a_corrected_rating_moves_the_client_average(self):
        client_token, client = self._client("sub-crating-13")
        rides = [self._ride(client) for _ in range(3)]
        for ride in rides:
            self._rate_client(ride, self.driver_token, {"rating": 2})

        self._rate_client(rides[0], self.driver_token, {"rating": 5})

        self.assertEqual(self._get("/api/v1/me", client_token).json()["rating"], {"average": 3.0, "count": 3})

    def test_the_driver_profile_carries_his_average_from_the_clients(self):
        self.assertEqual(self._get("/api/v1/me", self.driver_token).json()["rating"], {"average": None, "count": 0})
        for sub, value in (("a", 5), ("b", 5), ("c", 4)):
            client_token, client = self._client(f"sub-crating-14-{sub}")
            self._rate_driver(self._ride(client), client_token, value)

        self.assertEqual(self._get("/api/v1/me", self.driver_token).json()["rating"], {"average": 4.7, "count": 3})
