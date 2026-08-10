# Tests de babana.driver (L1-03). Le critère d'acceptation 3 (rating_avg se recalcule à chaque
# nouvel avis) n'est pas testé ici : babana.rating (L4-09) n'existe pas encore, voir
# amoa/questions/L1-03.md -- un test qui simulerait ce recalcul ne prouverait rien.
from __future__ import annotations

from odoo.exceptions import ValidationError
from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestBabanaDriver(TransactionCase):
    def _make_driver(self, **vals):
        employee = self.env["hr.employee"].create({"name": "Chauffeur de test"})
        return self.env["babana.driver"].create({"employee_id": employee.id, **vals})

    # --- Critère 1 : un chauffeur pending ne peut pas passer is_online à vrai --------------

    def test_pending_driver_cannot_go_online(self):
        driver = self._make_driver()
        self.assertEqual(driver.state, "pending")

        with self.assertRaises(ValidationError):
            driver.write({"is_online": True})

    def test_approved_driver_can_go_online(self):
        driver = self._make_driver(state="approved")
        driver.write({"is_online": True})
        self.assertTrue(driver.is_online)

    # --- Critère 2 : un chauffeur suspendu passe automatiquement hors ligne ----------------

    def test_suspending_an_online_driver_forces_it_offline(self):
        driver = self._make_driver(state="approved", is_online=True)
        self.assertTrue(driver.is_online)

        driver.write({"state": "suspended", "rejection_reason": "test"})

        self.assertFalse(driver.is_online)
        self.assertEqual(driver.state, "suspended")

    def test_suspending_wins_even_if_caller_also_requests_online(self):
        # Un appelant qui tenterait de repasser en ligne dans le même appel que la suspension
        # ne doit pas réussir à contourner la règle.
        driver = self._make_driver(state="approved")
        driver.write({"state": "suspended", "is_online": True})
        self.assertFalse(driver.is_online)

    # --- Critère 4 : une tentative d'écriture directe de cash_balance échoue ---------------

    def test_direct_write_of_cash_balance_fails(self):
        driver = self._make_driver()
        with self.assertRaises(Exception):
            driver.write({"cash_balance": 1000})

    def test_cash_balance_is_zero_bridge_value(self):
        driver = self._make_driver()
        self.assertEqual(driver.cash_balance, 0.0)

    # --- Contraintes structurelles ---------------------------------------------------------

    def test_one_driver_per_employee(self):
        employee = self.env["hr.employee"].create({"name": "Chauffeur unique"})
        self.env["babana.driver"].create({"employee_id": employee.id})

        with self.assertRaises(Exception):
            self.env["babana.driver"].create({"employee_id": employee.id})

    def test_default_cash_limit_reads_config_parameter(self):
        self.env["ir.config_parameter"].sudo().set_param(
            "babana.default_cash_limit", "75000"
        )
        driver = self._make_driver()
        self.assertEqual(driver.cash_limit, 75000.0)
