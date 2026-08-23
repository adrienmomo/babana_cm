# Tests du canal interne de profils chauffeur (L3-16, controllers/internal_profiles.py). HttpCase
# comme test_internal_controller.py, même raison : une route HTTP authentifiée par secret
# partagé, indépendante du service temps réel réel.
from __future__ import annotations

import json
import os

from odoo.tests.common import HttpCase, tagged


@tagged("post_install", "-at_install")
class TestInternalProfilesController(HttpCase):
    def _post(self, body=None, secret=None):
        headers = {"Content-Type": "application/json"}
        if secret is not None:
            headers["X-Realtime-Secret"] = secret
        return self.url_open(
            "/api/internal/drivers/profiles", data=json.dumps(body or {}).encode(), headers=headers
        )

    def _real_secret(self) -> str:
        return os.environ["REALTIME_SHARED_SECRET"]

    def _make_approved_driver(self, name, *, vehicle_class="standard"):
        employee = self.env["hr.employee"].create({"name": name})
        motorcycle = self.env["babana.motorcycle"].create(
            {"license_plate": f"LT-{employee.id:04d}-DP", "vehicle_class": vehicle_class}
        )
        driver = self.env["babana.driver"].sudo().create({"employee_id": employee.id, "state": "approved"})
        motorcycle.write({"driver_id": driver.id})
        driver.invalidate_recordset()
        return driver

    # --- Authentification ------------------------------------------------------------------

    def test_missing_secret_is_unauthorized(self):
        response = self._post({"driverIds": []})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "UNAUTHORIZED")

    def test_wrong_secret_is_unauthorized(self):
        response = self._post({"driverIds": []}, secret="not-the-secret")
        self.assertEqual(response.status_code, 401)

    # --- Critère 1 : les cinq champs viennent d'Odoo ------------------------------------------

    def test_returns_the_five_whitelisted_fields(self):
        driver = self._make_approved_driver("Paul Ekwalla", vehicle_class="premium")

        response = self._post({"driverIds": [driver.public_id]}, secret=self._real_secret())

        self.assertEqual(response.status_code, 200)
        profile = response.json()["profiles"][driver.public_id]
        self.assertEqual(profile["firstName"], "Paul")
        self.assertEqual(profile["motorcycleClass"], "premium")
        self.assertIsNone(profile["photoUrl"])
        self.assertIsNone(profile["rating"], "rating_count est un champ-pont, toujours 0 (L4-09)")
        # licensePlate (D41, 25 août) : décision explicite pour ce canal interne uniquement --
        # jamais exposé par nearby.drivers (voir services/realtime/src/nearby/projection.ts, qui
        # ne le lit pas), seulement par ride.assigned une fois le chauffeur affecté.
        self.assertEqual(profile["licensePlate"], driver.motorcycle_id.license_plate)

    # --- Critère 3 : un seul appel gère tout un lot -------------------------------------------

    def test_a_single_call_serves_a_batch_of_drivers(self):
        driver_a = self._make_approved_driver("Chauffeur A")
        driver_b = self._make_approved_driver("Chauffeur B")

        response = self._post(
            {"driverIds": [driver_a.public_id, driver_b.public_id]}, secret=self._real_secret()
        )

        self.assertEqual(response.status_code, 200)
        profiles = response.json()["profiles"]
        self.assertEqual(set(profiles.keys()), {driver_a.public_id, driver_b.public_id})

    # --- Critère 4 : liste blanche, jamais l'enregistrement projeté ---------------------------

    def test_no_field_beyond_the_whitelist_is_ever_served(self):
        driver = self._make_approved_driver("Chauffeur Confidentiel")

        response = self._post({"driverIds": [driver.public_id]}, secret=self._real_secret())

        profile = response.json()["profiles"][driver.public_id]
        self.assertEqual(
            set(profile.keys()),
            {"firstName", "photoUrl", "rating", "motorcycleClass", "licensePlate"},
        )
        serialized = json.dumps(profile)
        for forbidden in ("Confidentiel", "license_plate", "employee_id", "phone"):
            self.assertNotIn(forbidden, serialized)

    # --- Chauffeur inconnu : jamais inventé ---------------------------------------------------

    def test_unknown_driver_id_is_absent_from_the_response(self):
        response = self._post({"driverIds": ["00000000-0000-4000-8000-000000000000"]}, secret=self._real_secret())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["profiles"], {})

    def test_empty_driver_ids_returns_an_empty_map(self):
        response = self._post({"driverIds": []}, secret=self._real_secret())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["profiles"], {})
