# Notation d'une course (L4-09) : POST /rides/{id}/rate, babana.rating, et la moyenne du
# chauffeur telle que le canal interne la sert (« nouveau » sous le seuil d'avis).
from __future__ import annotations

import json
import os

from odoo.tests.common import HttpCase, tagged

from ..controllers.auth import _issue_access_token


@tagged("post_install", "-at_install")
class TestRideRating(HttpCase):
    def setUp(self):
        super().setUp()
        self._plates = 0
        self.env["ir.config_parameter"].sudo().set_param("babana.rating_min_count", "3")
        self.driver = self._driver()

    def _driver(self):
        self._plates += 1
        employee = self.env["hr.employee"].create({"name": f"Emmanuel Ndoumbè {self._plates}"})
        driver = self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})
        motorcycle = self.env["babana.motorcycle"].create({"license_plate": f"LT-{4900 + self._plates}-RT"})
        motorcycle.write({"driver_id": driver.id})
        driver.invalidate_recordset()
        return driver

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
            }
        )
        ride.action_propose(by_partner=client, driver=driver)
        ride.action_accept(by_driver=driver)
        ride.action_start(by_driver=driver)
        ride.action_complete(by_driver=driver, final_amount=700)
        if until == "settled":
            ride.action_settle(by_driver=driver, amount_collected=700)
        return ride

    def _rate(self, ride, token, body):
        return self.url_open(
            f"/api/v1/rides/{ride.public_id}/rate",
            data=json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )

    def _profile_rating(self, driver):
        response = self.url_open(
            "/api/internal/drivers/profiles",
            data=json.dumps({"driverIds": [driver.public_id]}).encode(),
            headers={"Content-Type": "application/json", "X-Realtime-Secret": os.environ["REALTIME_SHARED_SECRET"]},
        )
        return response.json()["profiles"][driver.public_id]["rating"]

    # --- Critère 1 : course encaissée, par son client seulement -----------------------------

    def test_the_client_rates_a_settled_ride(self):
        token, client = self._client("sub-rating-1")
        ride = self._ride(client)

        response = self._rate(ride, token, {"rating": 4, "comment": "Trajet rapide"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"rideId": ride.public_id, "rating": 4})
        rating = self.env["babana.rating"].search([("ride_id", "=", ride.id)])
        self.assertEqual((rating.rating, rating.comment, rating.driver_id), (4, "Trajet rapide", self.driver))
        self.assertEqual(ride.state, "settled", "noter n'est pas une transition")

    def test_a_ride_not_yet_settled_cannot_be_rated(self):
        token, client = self._client("sub-rating-2")
        ride = self._ride(client, until="completed")

        response = self._rate(ride, token, {"rating": 5})

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "RATING_NOT_ALLOWED")
        self.assertFalse(self.env["babana.rating"].search([("ride_id", "=", ride.id)]))

    def test_another_client_does_not_even_see_the_ride(self):
        _token, client = self._client("sub-rating-3")
        ride = self._ride(client)
        stranger_token, _stranger = self._client("sub-rating-3-other")

        response = self._rate(ride, stranger_token, {"rating": 1})

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "RIDE_NOT_FOUND")

    def test_out_of_range_or_malformed_rating_is_rejected(self):
        token, client = self._client("sub-rating-4")
        ride = self._ride(client)
        for body in ({"rating": 0}, {"rating": 6}, {"rating": 4.5}, {"rating": True}, {}, {"rating": 3, "comment": "x" * 501}):
            response = self._rate(ride, token, body)
            self.assertEqual(response.status_code, 400, body)
            self.assertEqual(response.json()["error"]["code"], "VALIDATION_ERROR")
        self.assertFalse(self.env["babana.rating"].search([("ride_id", "=", ride.id)]))

    # --- Critère 2 : une seule note par course -------------------------------------------------

    def test_a_second_rating_on_the_same_ride_is_refused(self):
        token, client = self._client("sub-rating-5")
        ride = self._ride(client)
        self.assertEqual(self._rate(ride, token, {"rating": 5}).status_code, 200)

        response = self._rate(ride, token, {"rating": 1})

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "RATING_ALREADY_SUBMITTED")
        self.assertEqual(self.env["babana.rating"].search([("ride_id", "=", ride.id)]).rating, 5)

    # --- Critère 3 : la moyenne se recalcule ---------------------------------------------------

    def test_the_driver_average_follows_each_new_rating(self):
        other_driver = self._driver()
        token, client = self._client("sub-rating-6")
        for value in (5, 4, 2):
            self._rate(self._ride(client), token, {"rating": value})
        self._rate(self._ride(client, driver=other_driver), token, {"rating": 1})

        self.driver.invalidate_recordset()
        self.assertEqual(self.driver.rating_count, 3)
        self.assertAlmostEqual(self.driver.rating_avg, 11 / 3)
        self.assertEqual((other_driver.rating_count, other_driver.rating_avg), (1, 1.0))

    # --- Critère 4 : « nouveau » sous le seuil, jamais zéro --------------------------------------

    def test_below_the_minimum_count_the_driver_is_new_not_zero(self):
        token, client = self._client("sub-rating-7")
        self.assertIsNone(self._profile_rating(self.driver), "aucun avis")
        self._rate(self._ride(client), token, {"rating": 5})
        self._rate(self._ride(client), token, {"rating": 4})
        self.assertIsNone(self._profile_rating(self.driver), "deux avis sur trois requis")

        self._rate(self._ride(client), token, {"rating": 4})

        self.assertEqual(self._profile_rating(self.driver), 4.3)

    # --- Critère 5 : le commentaire ne sort pas du back-office -----------------------------------

    def test_the_comment_is_never_sent_back_to_the_app(self):
        token, client = self._client("sub-rating-8")
        ride = self._ride(client)

        body = self._rate(ride, token, {"rating": 3, "comment": "Conduite brusque"}).json()

        self.assertNotIn("comment", body)
        self.assertNotIn("Conduite brusque", json.dumps(body))
