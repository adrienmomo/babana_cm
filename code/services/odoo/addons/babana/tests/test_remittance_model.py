# Tests du modèle babana.cash.remittance (L5-03) : le gel à la création, la couverture des
# courses, l'écart calculé, l'immutabilité post-validation. Les transitions (action_declare,
# action_validate, L5-04) n'existent pas encore dans ce lot -- ces tests créent et modifient la
# remise directement, comme test_ride_state_machine.py le fait pour babana.ride avant que
# L4-02R n'existe.
from __future__ import annotations

from odoo.exceptions import UserError
from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestCashRemittanceModel(TransactionCase):
    def _make_partner(self, name="Client"):
        return self.env["res.partner"].create({"name": name})

    def _make_driver(self, name="Chauffeur"):
        employee = self.env["hr.employee"].create({"name": name})
        return self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})

    def _settle_a_ride(self, driver, *, final_amount=1200):
        client = self._make_partner()
        ride = self.env["babana.ride"].action_request(
            {
                "client_id": client.id,
                "pickup_latitude": 4.05,
                "pickup_longitude": 9.70,
                "dropoff_latitude": 4.06,
                "dropoff_longitude": 9.77,
            }
        )
        ride.action_propose(by_partner=client, driver=driver)
        ride.action_accept(by_driver=driver)
        ride.action_start(by_driver=driver)
        ride.action_complete(
            by_driver=driver,
            actual_distance_km=5.0,
            actual_duration_minutes=15,
            final_amount=final_amount,
        )
        ride.action_settle(by_driver=driver, amount_collected=final_amount)
        return ride

    # --- Critère 1 : le montant attendu est figé à la création, ne bouge plus -----------------

    def test_expected_amount_is_frozen_at_creation(self):
        driver = self._make_driver()
        self._settle_a_ride(driver, final_amount=1200)

        remittance = self.env["babana.cash.remittance"].create({"driver_id": driver.id})
        self.assertEqual(remittance.expected_amount, 1200)

        # Un encaissement supplémentaire après la création ne doit rien changer à expected_amount
        # (même critère que le suivant, vérifié ici sur le montant plutôt que sur les courses).
        self._settle_a_ride(driver, final_amount=800)
        remittance.invalidate_recordset()
        self.assertEqual(remittance.expected_amount, 1200)

        with self.assertRaises(UserError):
            remittance.write({"expected_amount": 999})

    # --- Critère 2 : une course encaissée après la création de la remise n'y est pas incluse --

    def test_a_ride_settled_after_creation_is_not_covered(self):
        driver = self._make_driver()
        first_ride = self._settle_a_ride(driver, final_amount=1200)

        remittance = self.env["babana.cash.remittance"].create({"driver_id": driver.id})

        second_ride = self._settle_a_ride(driver, final_amount=800)

        self.assertEqual(remittance.ride_ids, first_ride)
        self.assertNotIn(second_ride.id, remittance.ride_ids.ids)

    # --- Critère 5 : les courses couvertes sont référencées ------------------------------------

    def test_covered_rides_are_referenced(self):
        driver = self._make_driver()
        ride_a = self._settle_a_ride(driver, final_amount=1200)
        ride_b = self._settle_a_ride(driver, final_amount=800)

        remittance = self.env["babana.cash.remittance"].create({"driver_id": driver.id})

        self.assertEqual(set(remittance.ride_ids.ids), {ride_a.id, ride_b.id})

    def test_a_movement_already_covered_by_a_previous_remittance_is_not_covered_twice(self):
        driver = self._make_driver()
        ride_a = self._settle_a_ride(driver, final_amount=1200)
        first_remittance = self.env["babana.cash.remittance"].create({"driver_id": driver.id})

        ride_b = self._settle_a_ride(driver, final_amount=800)
        second_remittance = self.env["babana.cash.remittance"].create({"driver_id": driver.id})

        self.assertEqual(first_remittance.ride_ids, ride_a)
        self.assertEqual(second_remittance.ride_ids, ride_b)

    # --- Critère 3 : l'écart est calculé, jamais saisi -----------------------------------------

    def test_discrepancy_amount_is_computed_not_writable_before_or_after_validation(self):
        driver = self._make_driver()
        self._settle_a_ride(driver, final_amount=1200)
        remittance = self.env["babana.cash.remittance"].create({"driver_id": driver.id})

        self.assertEqual(
            remittance.discrepancy_amount, 0, "pas encore validée -- rien à calculer (critère 3)"
        )

        remittance.write(
            {"declared_amount": 1000, "counted_amount": 1000, "state": "validated"}
        )
        self.assertEqual(remittance.discrepancy_amount, 200)

    # --- Critère 4 : une remise validée ne peut plus être modifiée ----------------------------

    def test_a_validated_remittance_is_immutable(self):
        driver = self._make_driver()
        self._settle_a_ride(driver, final_amount=1200)
        remittance = self.env["babana.cash.remittance"].create({"driver_id": driver.id})
        remittance.write(
            {"declared_amount": 1200, "counted_amount": 1200, "state": "validated"}
        )

        with self.assertRaises(UserError):
            remittance.write({"discrepancy_reason": "essai après validation"})

    def test_a_declared_remittance_can_still_be_modified(self):
        # Contrôle négatif du critère 4 : l'immutabilité est bien réservée à 'validated', pas à
        # tout état -- une remise seulement déclarée reste modifiable (le superviseur doit
        # pouvoir y écrire counted_amount).
        driver = self._make_driver()
        self._settle_a_ride(driver, final_amount=1200)
        remittance = self.env["babana.cash.remittance"].create(
            {"driver_id": driver.id, "declared_amount": 1200, "state": "declared"}
        )

        remittance.write({"counted_amount": 1200})
        self.assertEqual(remittance.counted_amount, 1200)
