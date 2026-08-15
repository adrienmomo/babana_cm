# Tests de l'éligibilité à la bascule en ligne / hors ligne (L3-04, D7) : chaque condition de
# refus renvoie un motif distinct (critère 1), un chauffeur en course ne peut pas se mettre hors
# ligne (critère 2). Le critère 4 (plafond d'encaisse) ne peut pas être exercé avec de vraies
# données ici : cash_balance est un champ-pont (toujours 0.0 tant que L5-01 n'existe pas) --
# _check_online_eligibility() porte déjà la comparaison, prête pour ce jour-là (même situation
# que promo_applied, L2-04).
from __future__ import annotations

from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestDriverAvailability(TransactionCase):
    def _make_motorcycle(self):
        n = self.env["babana.motorcycle"].search_count([]) + 1
        return self.env["babana.motorcycle"].create({"license_plate": f"LT-AV{n:04d}-BC"})

    def _verify_required_documents(self, driver, *, license_expires_on="2030-01-01"):
        for document_type in ("license", "id_card"):
            vals = {
                "driver_id": driver.id,
                "document_type": document_type,
                "storage_key": f"test/{document_type}.jpg",
                "verification_status": "verified",
            }
            if document_type == "license":
                vals["expires_on"] = license_expires_on
            self.env["babana.driver.document"].create(vals)

    def _make_approved_driver(self, *, license_expires_on="2030-01-01"):
        driver = self.env["babana.driver"].create({})
        self._verify_required_documents(driver, license_expires_on=license_expires_on)
        self._make_motorcycle().write({"driver_id": driver.id})
        driver.invalidate_recordset()
        driver.action_approve(new_employee_name="Chauffeur disponible")
        return driver

    # --- Critère 1 : chaque condition de refus a un motif distinct ----------------------------

    def test_pending_driver_is_refused_not_approved(self):
        driver = self.env["babana.driver"].create({})
        self.assertEqual(driver._check_online_eligibility()[0], "DRIVER_NOT_APPROVED")

    def test_approved_driver_without_motorcycle_is_refused(self):
        driver = self._make_approved_driver()
        driver.motorcycle_id.write({"driver_id": False})
        driver.invalidate_recordset()
        self.assertEqual(driver._check_online_eligibility()[0], "MOTORCYCLE_NOT_ASSIGNED")

    def test_approved_driver_with_expired_insurance_is_refused(self):
        driver = self._make_approved_driver()
        driver.motorcycle_id.write({"insurance_expires_on": "2020-01-01"})
        self.assertEqual(driver._check_online_eligibility()[0], "INSURANCE_EXPIRED")

    def test_approved_driver_with_expired_license_is_refused(self):
        driver = self._make_approved_driver(license_expires_on="2020-01-01")
        self.assertEqual(driver._check_online_eligibility()[0], "LICENSE_EXPIRED")

    def test_eligible_driver_has_no_refusal(self):
        driver = self._make_approved_driver()
        self.assertIsNone(driver._check_online_eligibility())

    # --- Critère 2 : un chauffeur en course ne peut pas se mettre hors ligne ------------------

    def test_driver_with_active_ride_cannot_go_offline(self):
        driver = self._make_approved_driver()
        partner = self.env["res.partner"].create({"name": "Client test L3-04"})
        self.env["babana.ride"].action_request(
            {
                "client_id": partner.id,
                "pickup_latitude": 4.05,
                "pickup_longitude": 9.70,
                "dropoff_latitude": 4.06,
                "dropoff_longitude": 9.77,
            }
        )
        ride = self.env["babana.ride"].search(
            [("client_id", "=", partner.id), ("state", "=", "requested")], limit=1
        )
        ride.action_propose(by_partner=partner, driver=driver)

        self.assertEqual(driver._check_offline_allowed()[0], "DRIVER_HAS_ACTIVE_RIDE")

    def test_driver_without_active_ride_can_go_offline(self):
        driver = self._make_approved_driver()
        self.assertIsNone(driver._check_offline_allowed())
