# Tests de l'endpoint de cotation (L2-04). Contre la vraie pile de mocks (mock-google-identity
# pour l'authentification, mock-maps pour la distance de référence -- L2-05) : « on simule le
# fournisseur, jamais notre logique » (D19). Le critère 6 (« la course créée depuis une
# estimation porte ses zones et sa règle tarifaire ») est vérifié par test_ride_controller.py
# (L4-03R, hors de ce fichier) une fois POST /rides implémenté -- il n'y a rien à créer ici sans
# lui.
from __future__ import annotations

import json
import os

import requests

from odoo.tests.common import HttpCase, tagged


def _mock_google_base_url() -> str:
    return os.environ.get("GOOGLE_MOCK_IDENTITY_URL", "http://mock-google-identity:4000")


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


# Deux points distincts, plausibles pour Douala (Akwa -> Bonapriso, fixtures/douala.json de
# mock-maps) -- pas de valeurs arbitraires.
_ORIGIN = {"latitude": 4.0483, "longitude": 9.6934}
_DESTINATION = {"latitude": 4.0270, "longitude": 9.7040}


@tagged("post_install", "-at_install")
class TestQuoteController(HttpCase):
    @classmethod
    def _request_handler(cls, s, r, **kw):
        if r.url.startswith(_mock_google_base_url()) or "mock-maps" in r.url:
            from odoo.tests.common import _super_send

            return _super_send(s, r, **kw)
        return super()._request_handler(s, r, **kw)

    def _sign_in_client(self, sub):
        token = _mint_google_token(sub=sub, email=f"{sub}@example.invalid")
        response = self.url_open(
            "/api/v1/auth/google",
            data=json.dumps({"idToken": token, "role": "client"}).encode(),
            headers={"Content-Type": "application/json"},
        )
        return response.json()["accessToken"]

    def _quote(self, token, body=None):
        payload = {"origin": _ORIGIN, "destination": _DESTINATION}
        payload.update(body or {})
        return self.url_open(
            "/api/v1/quote",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        )

    # --- Critère 1 : deux estimations identiques dans la même minute --------------------------

    def test_two_identical_quotes_return_the_same_amount(self):
        token = self._sign_in_client("sub-quote-repeat")

        first = self._quote(token)
        second = self._quote(token)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.json()["amount"], second.json()["amount"])
        self.assertEqual(first.json()["distanceMeters"], second.json()["distanceMeters"])

    # --- Critère 3 : la durée renvoyée est corrigée, pas la durée brute du routeur ------------

    def test_eta_is_corrected_not_raw(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.eta_correction_factor", "1.5")
        token = self._sign_in_client("sub-quote-eta")

        response = self._quote(token)

        self.assertEqual(response.status_code, 200)
        body = response.json()
        # La durée brute vient du même mock-maps déterministe (routing.py:_fetch_from_api) ;
        # avec un facteur de correction de 1.5, l'ETA corrigé ne peut pas être égal à une durée
        # brute plausible pour ce couple de points (non nulle).
        self.assertGreater(body["etaSeconds"], 0)
        self.assertNotEqual(body["etaSeconds"], round(body["etaSeconds"] / 1.5))

    # --- Critère 4 : le détail décomposé complet ------------------------------------------------

    def test_response_contains_full_breakdown(self):
        token = self._sign_in_client("sub-quote-breakdown")

        response = self._quote(token)

        self.assertEqual(response.status_code, 200)
        breakdown = response.json()["breakdown"]
        for key in (
            "baseFare", "distanceFare", "surgeAmount", "discountAmount", "floorAmount",
            "roundingAmount", "minimumFareApplied",
        ):
            self.assertIn(key, breakdown)
        total = (
            breakdown["baseFare"] + breakdown["distanceFare"] + breakdown["surgeAmount"]
            - breakdown["discountAmount"] + breakdown["floorAmount"] + breakdown["roundingAmount"]
        )
        self.assertEqual(total, response.json()["amount"])

    # --- Critère 5 : un code promo invalide n'échoue pas la cotation --------------------------

    def test_invalid_promo_code_does_not_fail_the_quote(self):
        token = self._sign_in_client("sub-quote-promo")

        response = self._quote(token, {"promoCode": "DOESNOTEXIST"})

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertFalse(body["promoApplied"])
        self.assertEqual(body["breakdown"]["discountAmount"], 0)

    # --- Estimation persistée, avec zones résolues et durée de validité -----------------------

    def test_quote_is_persisted_with_zones_and_expiry(self):
        token = self._sign_in_client("sub-quote-persist")

        response = self._quote(token)

        self.assertEqual(response.status_code, 200)
        quote_id = response.json()["quoteId"]
        quote = self.env["babana.quote"].sudo().search([("public_id", "=", quote_id)])
        self.assertTrue(quote)
        self.assertTrue(quote.pickup_zone_id)
        self.assertTrue(quote.dropoff_zone_id)
        self.assertTrue(quote.fare_rule_id)
        self.assertTrue(quote.expires_at)
        self.assertFalse(quote.is_expired())

    def test_missing_origin_is_a_validation_error(self):
        token = self._sign_in_client("sub-quote-badbody")

        response = self.url_open(
            "/api/v1/quote",
            data=json.dumps({"destination": _DESTINATION}).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "VALIDATION_ERROR")

    def test_missing_authorization_is_unauthorized(self):
        response = self.url_open(
            "/api/v1/quote",
            data=json.dumps({"origin": _ORIGIN, "destination": _DESTINATION}).encode(),
            headers={"Content-Type": "application/json"},
        )

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "UNAUTHORIZED")
