# Tests de babana.cash.movement et du solde calculé de babana.driver (D8, L5-01).
from __future__ import annotations

from odoo.exceptions import UserError, ValidationError
from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestCashBalance(TransactionCase):
    def _make_driver(self):
        employee = self.env["hr.employee"].create({"name": "Chauffeur de test"})
        return self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})

    def _movement(self, driver, movement_type, amount, **vals):
        return self.env["babana.cash.movement"].create(
            {"driver_id": driver.id, "movement_type": movement_type, "amount": amount, **vals}
        )

    # --- Critères 1, 3, 6 : le solde est calculé, jamais stocké librement --------------------

    def test_a_collection_creates_exactly_one_movement_and_increments_the_balance(self):
        driver = self._make_driver()

        self._movement(driver, "collection", 1200)
        driver.invalidate_recordset()

        self.assertEqual(driver.cash_balance, 1200)
        self.assertEqual(
            self.env["babana.cash.movement"].search_count([("driver_id", "=", driver.id)]), 1
        )

    def test_balance_is_the_sum_of_all_movements(self):
        driver = self._make_driver()

        self._movement(driver, "collection", 1200)
        self._movement(driver, "collection", 800)
        self._movement(driver, "remittance", -500)
        driver.invalidate_recordset()

        self.assertEqual(driver.cash_balance, 1500)

    # --- Critère 2 : un mouvement ne peut être ni modifié ni supprimé ------------------------

    def test_a_movement_cannot_be_modified(self):
        driver = self._make_driver()
        movement = self._movement(driver, "collection", 1200)

        with self.assertRaises(UserError):
            movement.write({"amount": 1300})

    def test_a_movement_cannot_be_modified_even_by_an_administrator(self):
        driver = self._make_driver()
        movement = self._movement(driver, "collection", 1200)

        with self.assertRaises(UserError):
            movement.sudo().write({"amount": 1300})

    def test_a_movement_cannot_be_deleted(self):
        driver = self._make_driver()
        movement = self._movement(driver, "collection", 1200)

        with self.assertRaises(UserError):
            movement.unlink()

    def test_a_movement_cannot_be_deleted_even_by_an_administrator(self):
        driver = self._make_driver()
        movement = self._movement(driver, "collection", 1200)

        with self.assertRaises(UserError):
            movement.sudo().unlink()

    # --- Signe attendu par type ----------------------------------------------------------------

    def test_a_collection_must_be_strictly_positive(self):
        driver = self._make_driver()
        with self.assertRaises(ValidationError):
            self._movement(driver, "collection", -100)

    def test_a_collection_of_zero_is_rejected(self):
        driver = self._make_driver()
        with self.assertRaises(Exception):
            self._movement(driver, "collection", 0)

    def test_a_remittance_must_be_strictly_negative(self):
        driver = self._make_driver()
        self._movement(driver, "collection", 1000)
        with self.assertRaises(ValidationError):
            self._movement(driver, "remittance", 100)

    # --- Critère 4 : une remise supérieure au solde est refusée ------------------------------

    def test_a_remittance_exceeding_the_balance_is_rejected(self):
        driver = self._make_driver()
        self._movement(driver, "collection", 1000)

        with self.assertRaises(UserError):
            self._movement(driver, "remittance", -1500)

        driver.invalidate_recordset()
        self.assertEqual(driver.cash_balance, 1000, "le solde ne doit pas bouger si la remise est refusée")

    # --- D29 : une remise partielle laisse un solde non nul, qui continue de peser -----------

    def test_a_partial_remittance_leaves_a_nonzero_balance(self):
        driver = self._make_driver()
        self._movement(driver, "collection", 45000)

        self._movement(driver, "remittance", -40000)
        driver.invalidate_recordset()

        self.assertEqual(
            driver.cash_balance,
            5000,
            "D29 : le reliquat après une remise partielle reste au solde du chauffeur",
        )

    # --- Critère 5 : un ajustement exige un motif ---------------------------------------------

    def test_an_adjustment_without_a_reason_is_rejected(self):
        driver = self._make_driver()
        with self.assertRaises(ValidationError):
            self._movement(driver, "adjustment", -500)

    def test_an_adjustment_with_a_blank_reason_is_rejected(self):
        driver = self._make_driver()
        with self.assertRaises(ValidationError):
            self._movement(driver, "adjustment", -500, reason="   ")

    def test_an_adjustment_with_a_reason_is_accepted_and_can_go_negative(self):
        # Spécification (L5-01) : "Seul un ajustement explicite peut produire un solde négatif."
        driver = self._make_driver()

        self._movement(driver, "adjustment", -200, reason="Correction d'une double saisie du 12 août")
        driver.invalidate_recordset()

        self.assertEqual(driver.cash_balance, -200)

    def test_an_adjustment_can_also_be_positive(self):
        driver = self._make_driver()

        self._movement(driver, "adjustment", 300, reason="Recette non enregistrée le 10 août")
        driver.invalidate_recordset()

        self.assertEqual(driver.cash_balance, 300)

    # --- Traçabilité du mouvement (course d'origine) -------------------------------------------

    def test_a_collection_can_reference_its_originating_ride(self):
        driver = self._make_driver()
        client = self.env["res.partner"].create({"name": "Client"})
        ride = self.env["babana.ride"].action_request(
            {
                "client_id": client.id,
                "pickup_latitude": 4.05,
                "pickup_longitude": 9.70,
                "dropoff_latitude": 4.06,
                "dropoff_longitude": 9.77,
            }
        )

        movement = self._movement(driver, "collection", 1200, ride_id=ride.id)

        self.assertEqual(movement.ride_id, ride)
