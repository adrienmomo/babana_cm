# Cotation multi-arrêts (L2-08, amoa/specs/L2-tarification.md). Contre mock-maps, comme
# test_quote_controller.py : sa distance est déterministe (vol d'oiseau × 1,3), ce qui permet de
# vérifier que l'itinéraire coté passe bien par les arrêts, dans l'ordre.
from __future__ import annotations

import json

from odoo.tests.common import HttpCase, tagged

# Le module, pas la classe : importée par son nom, elle serait collectée ici une seconde fois.
from . import test_quote_controller as quote_tests

_ORIGIN = quote_tests._ORIGIN
_DESTINATION = quote_tests._DESTINATION
_BASE = quote_tests.TestQuoteController

# Un arrêt plausible entre Akwa et Bonapriso (Deido), et un second plus à l'est.
_STOP_A = {"latitude": 4.0600, "longitude": 9.7150}
_STOP_B = {"latitude": 4.0400, "longitude": 9.7300}


@tagged("post_install", "-at_install")
class TestQuoteStops(HttpCase):
    @classmethod
    def _request_handler(cls, s, r, **kw):
        # Même passe-droit que test_quote_controller.py : identité et routage simulés atteints
        # pour de vrai. Recopié, pas emprunté -- son super() ne vaut que dans sa propre classe.
        if r.url.startswith(quote_tests._mock_google_base_url()) or "mock-maps" in r.url:
            from odoo.tests.common import _super_send

            return _super_send(s, r, **kw)
        return super()._request_handler(s, r, **kw)

    _sign_in_client = _BASE._sign_in_client
    _quote = _BASE._quote

    def _leg(self, token, origin, destination):
        """Distance d'un tronçon seul, mesurée par l'endpoint lui-même (mêmes arrondis, même cache)."""
        response = self._quote(token, {"origin": origin, "destination": destination})
        self.assertEqual(response.status_code, 200)
        return response.json()["distanceMeters"]

    # --- Critère 1 : sans arrêt, rien ne change ------------------------------------------------

    def test_quote_without_stops_has_no_stop_fare_and_zero_stops(self):
        token = self._sign_in_client("sub-stops-none")

        without_key = self._quote(token).json()
        empty_list = self._quote(token, {"stops": []}).json()

        self.assertEqual(without_key["stopCount"], 0)
        self.assertEqual(without_key["breakdown"]["stopFare"], 0)
        self.assertEqual(without_key["amount"], empty_list["amount"])
        self.assertEqual(without_key["distanceMeters"], empty_list["distanceMeters"])

    # --- Critère 2 : k arrêts = k forfaits, itinéraire par les arrêts dans l'ordre -------------

    def test_stops_add_their_flat_fee_and_route_through_them_in_order(self):
        token = self._sign_in_client("sub-stops-two")

        response = self._quote(token, {"stops": [_STOP_A, _STOP_B]})

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["stopCount"], 2)
        rule = self.env["babana.quote"].sudo().search(
            [("public_id", "=", body["quoteId"])]
        ).fare_rule_id
        self.assertEqual(body["breakdown"]["stopFare"], round(2 * rule.stop_flat_fee))
        expected_distance = (
            self._leg(token, _ORIGIN, _STOP_A)
            + self._leg(token, _STOP_A, _STOP_B)
            + self._leg(token, _STOP_B, _DESTINATION)
        )
        self.assertEqual(body["distanceMeters"], expected_distance)

    def test_stop_order_changes_the_route(self):
        token = self._sign_in_client("sub-stops-order")

        forward = self._quote(token, {"stops": [_STOP_A, _STOP_B]}).json()
        backward = self._quote(token, {"stops": [_STOP_B, _STOP_A]}).json()

        self.assertNotEqual(forward["distanceMeters"], backward["distanceMeters"])

    def test_breakdown_with_stops_still_sums_to_the_amount(self):
        token = self._sign_in_client("sub-stops-sum")

        body = self._quote(token, {"stops": [_STOP_A]}).json()

        b = body["breakdown"]
        total = (
            b["baseFare"] + b["approachFare"] + b["distanceFare"] + b["surgeAmount"]
            + b["stopFare"] - b["discountAmount"] + b["floorAmount"] + b["roundingAmount"]
        )
        self.assertEqual(total, body["amount"])

    # --- Critère 3 : au-delà du maximum, refus explicite ---------------------------------------

    def test_more_stops_than_the_configured_maximum_is_refused(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.max_stops_per_ride", "1")
        token = self._sign_in_client("sub-stops-limit")

        refused = self._quote(token, {"stops": [_STOP_A, _STOP_B]})
        accepted = self._quote(token, {"stops": [_STOP_A]})

        self.assertEqual(refused.status_code, 400)
        self.assertEqual(refused.json()["error"]["code"], "TOO_MANY_STOPS")
        self.assertEqual(accepted.status_code, 200)

    def test_a_stop_that_is_not_a_position_is_a_validation_error(self):
        token = self._sign_in_client("sub-stops-invalid")

        response = self._quote(token, {"stops": [{"latitude": 4.05}]})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "VALIDATION_ERROR")

    # --- Critère 4 : le devis gèle les arrêts et les valeurs d'attente -------------------------

    def test_quote_freezes_its_stops_and_the_stop_and_wait_values(self):
        token = self._sign_in_client("sub-stops-frozen")

        body = self._quote(token, {"stops": [_STOP_A]}).json()

        quote = self.env["babana.quote"].sudo().search([("public_id", "=", body["quoteId"])])
        self.assertEqual(quote.stop_count, 1)
        self.assertEqual(json.loads(quote.stops_json), [_STOP_A])
        frozen = json.loads(quote.stop_wait_snapshot)
        self.assertEqual(frozen, quote.fare_rule_id._stop_wait_snapshot())

        # La grille change ensuite -- le devis, lui, garde ce qu'il a gelé.
        quote.fare_rule_id.new_version(
            {"wait_rate_per_minute": frozen["wait_rate_per_minute"] + 10}
        )
        self.assertEqual(json.loads(quote.stop_wait_snapshot), frozen)

    # --- L4-14 : la course créée depuis ce devis porte ses arrêts et ses valeurs gelées ---------

    def test_ride_created_from_a_quote_carries_its_stops_and_frozen_values(self):
        token = self._sign_in_client("sub-stops-ride")
        quote_body = self._quote(token, {"stops": [_STOP_A, _STOP_B]}).json()

        response = self.url_open(
            "/api/v1/rides",
            data=json.dumps({"quoteId": quote_body["quoteId"]}).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        )

        self.assertEqual(response.status_code, 201, response.text)
        ride = self.env["babana.ride"].sudo().search([("public_id", "=", response.json()["id"])])
        quote = self.env["babana.quote"].sudo().search([("public_id", "=", quote_body["quoteId"])])
        stops = ride.stop_ids.sorted("sequence")
        self.assertEqual(
            [(s.latitude, s.longitude, s.kind) for s in stops],
            [(_STOP_A["latitude"], _STOP_A["longitude"], "planned"), (_STOP_B["latitude"], _STOP_B["longitude"], "planned")],
        )
        self.assertEqual(ride.stop_wait_snapshot, quote.stop_wait_snapshot)
        self.assertEqual(ride.reference_distance_km, quote_body["distanceMeters"] / 1000.0)
        self.assertEqual(round(ride.estimated_amount), quote_body["amount"])
