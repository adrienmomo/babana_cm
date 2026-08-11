# Tests de babana.motorcycle (L1-07).
from __future__ import annotations

from datetime import timedelta

from odoo.exceptions import ValidationError
from odoo.fields import Date
from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestBabanaMotorcycle(TransactionCase):
    def _make_motorcycle(self, **vals):
        base = {"license_plate": f"LT-{self.env['babana.motorcycle'].search_count([]) + 1:04d}-BC"}
        base.update(vals)
        return self.env["babana.motorcycle"].create(base)

    def _make_driver(self, name="Chauffeur de test"):
        employee = self.env["hr.employee"].create({"name": name})
        return self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})

    # --- Critère 1 : l'immatriculation est unique ---------------------------------------------

    def test_license_plate_is_unique(self):
        self._make_motorcycle(license_plate="LT-1234-BC")
        with self.assertRaises(Exception):
            self._make_motorcycle(license_plate="LT-1234-BC")

    # --- Critère 2 : une moto à l'assurance expirée ne peut pas être affectée -----------------

    def test_motorcycle_with_expired_insurance_cannot_be_assigned(self):
        driver = self._make_driver()
        moto = self._make_motorcycle(insurance_expires_on=Date.today() - timedelta(days=1))

        with self.assertRaises(ValidationError):
            moto.write({"driver_id": driver.id})

    def test_motorcycle_with_valid_insurance_can_be_assigned(self):
        driver = self._make_driver()
        moto = self._make_motorcycle(insurance_expires_on=Date.today() + timedelta(days=30))

        moto.write({"driver_id": driver.id})

        self.assertEqual(moto.driver_id, driver)

    def test_motorcycle_without_insurance_date_can_be_assigned(self):
        # Une date d'expiration absente n'est pas une expiration : rien n'a encore été renseigné,
        # ce n'est pas la même chose qu'une assurance qui a expiré.
        driver = self._make_driver()
        moto = self._make_motorcycle()

        moto.write({"driver_id": driver.id})

        self.assertEqual(moto.driver_id, driver)

    # --- Critère 3 : un chauffeur dont la moto a une assurance expirée ne peut pas passer en ---
    # --- ligne -----------------------------------------------------------------------------

    def test_driver_cannot_go_online_when_motorcycle_insurance_expired(self):
        driver = self._make_driver()
        moto = self._make_motorcycle(insurance_expires_on=Date.today() + timedelta(days=30))
        moto.write({"driver_id": driver.id})

        # L'assurance expire après l'affectation (cas réel : le temps passe).
        moto.write({"insurance_expires_on": Date.today() - timedelta(days=1)})

        with self.assertRaises(ValidationError):
            driver.write({"is_online": True})

    def test_driver_can_go_online_when_motorcycle_insurance_valid(self):
        driver = self._make_driver()
        moto = self._make_motorcycle(insurance_expires_on=Date.today() + timedelta(days=30))
        moto.write({"driver_id": driver.id})

        driver.write({"is_online": True})

        self.assertTrue(driver.is_online)

    def test_driver_without_motorcycle_can_go_online(self):
        # Aucune moto affectée : rien à bloquer sur l'assurance -- un autre contrôle (L1-06)
        # empêchera de toute façon l'approbation d'un chauffeur sans moto, hors de ce lot.
        driver = self._make_driver()
        driver.write({"is_online": True})
        self.assertTrue(driver.is_online)

    # --- Critère 4 : l'état suit l'affectation automatiquement ---------------------------------

    def test_state_becomes_assigned_when_driver_is_set(self):
        driver = self._make_driver()
        moto = self._make_motorcycle()
        self.assertEqual(moto.state, "available")

        moto.write({"driver_id": driver.id})

        self.assertEqual(moto.state, "assigned")

    def test_state_returns_to_available_when_driver_is_cleared(self):
        driver = self._make_driver()
        moto = self._make_motorcycle(driver_id=driver.id)
        self.assertEqual(moto.state, "assigned")

        moto.write({"driver_id": False})

        self.assertEqual(moto.state, "available")

    def test_maintenance_motorcycle_cannot_be_assigned(self):
        driver = self._make_driver()
        moto = self._make_motorcycle(state="maintenance")

        with self.assertRaises(ValidationError):
            moto.write({"driver_id": driver.id})

    def test_clearing_driver_does_not_override_explicit_maintenance_state(self):
        driver = self._make_driver()
        moto = self._make_motorcycle(driver_id=driver.id)

        # Un gestionnaire retire la moto du service en cours de course -- l'état explicite prime.
        moto.write({"state": "maintenance", "driver_id": False})

        self.assertEqual(moto.state, "maintenance")
