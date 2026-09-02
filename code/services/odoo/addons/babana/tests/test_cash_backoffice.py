# Vues remises et écarts de caisse back-office (L9-05). Testent les champs et méthodes sur
# lesquels les vues s'appuient, pas leur rendu -- même approche que test_motorcycle_backoffice.py
# (L9-02) et test_fare_rule_backoffice.py (L9-04). Les fixtures (chauffeur, superviseur,
# déclaration/validation) reprennent celles de test_discrepancy.py (L5-06).
from __future__ import annotations

import uuid

from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestCashBackoffice(TransactionCase):
    def _make_driver(self, name="Chauffeur"):
        employee = self.env["hr.employee"].create({"name": name})
        return self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})

    def _make_supervisor(self, name="Superviseur"):
        supervisor_group = self.env.ref("babana.group_babana_supervisor")
        internal_user_group = self.env.ref("base.group_user")
        return self.env["res.users"].create(
            {
                "name": name,
                "login": f"{name.lower()}-{uuid.uuid4()}@example.invalid",
                "groups_id": [(6, 0, [supervisor_group.id, internal_user_group.id])],
            }
        )

    def _movement(self, driver, movement_type, amount, **vals):
        return self.env["babana.cash.movement"].create(
            {"driver_id": driver.id, "movement_type": movement_type, "amount": amount, **vals}
        )

    def _declare_and_validate(self, driver, *, declared_amount, counted_amount):
        remittance = self.env["babana.cash.remittance"].action_declare(
            driver=driver, declared_amount=declared_amount
        )
        supervisor = self._make_supervisor()
        remittance.with_user(supervisor).action_validate(
            supervisor=supervisor, counted_amount=counted_amount
        )
        return remittance

    def _partial_remittance(self, driver=None, *, expected=45000, given=40000):
        driver = driver or self._make_driver()
        self._movement(driver, "collection", expected)
        driver.invalidate_recordset()
        remittance = self._declare_and_validate(
            driver, declared_amount=given, counted_amount=given
        )
        return remittance, driver

    # --- L5-04/L9-05 : le chauffeur reste débiteur, observable depuis la remise ---------------

    def test_remittance_links_to_its_discrepancy_record(self):
        remittance, driver = self._partial_remittance(expected=45000, given=40000)

        self.assertTrue(remittance.discrepancy_id)
        self.assertEqual(remittance.discrepancy_id.remittance_id, remittance)
        self.assertEqual(remittance.discrepancy_id.driver_id, driver)
        self.assertEqual(remittance.discrepancy_amount, 5000)

    def test_complete_remittance_has_no_linked_discrepancy(self):
        driver = self._make_driver()
        self._movement(driver, "collection", 1200)
        driver.invalidate_recordset()
        remittance = self._declare_and_validate(driver, declared_amount=1200, counted_amount=1200)

        self.assertFalse(remittance.discrepancy_id)

    # --- Critère 2 : l'historique d'écarts du chauffeur est visible depuis l'écart courant ----

    def test_discrepancy_form_shows_the_driver_history(self):
        driver = self._make_driver()
        first, _driver = self._partial_remittance(driver, expected=10000, given=9000)
        second, _driver = self._partial_remittance(driver, expected=10000, given=9500)

        self.assertIn(second.discrepancy_id, first.discrepancy_id.driver_other_discrepancy_ids)
        self.assertIn(first.discrepancy_id, second.discrepancy_id.driver_other_discrepancy_ids)
        # Jamais soi-même dans son propre historique.
        self.assertNotIn(first.discrepancy_id, first.discrepancy_id.driver_other_discrepancy_ids)

    def test_discrepancy_history_is_scoped_to_the_same_driver(self):
        other_driver_remittance, _other = self._partial_remittance(expected=10000, given=9000)
        driver = self._make_driver("Chauffeur isolé")
        remittance, _driver = self._partial_remittance(driver, expected=10000, given=9000)

        self.assertNotIn(
            other_driver_remittance.discrepancy_id,
            remittance.discrepancy_id.driver_other_discrepancy_ids,
        )

    # --- Critère 5 : une série d'écarts de même sens est visuellement repérable ---------------

    def test_series_flag_matches_the_configured_threshold(self):
        self.env["ir.config_parameter"].sudo().set_param(
            "babana.cash_discrepancy_alert_series_count", "2"
        )
        driver = self._make_driver()
        first, _driver = self._partial_remittance(driver, expected=10000, given=9000)
        self.assertFalse(
            first.discrepancy_id.part_of_a_series, "un seul écart n'est jamais une série"
        )
        self.assertEqual(first.discrepancy_id.same_direction_recent_count, 1)

        second, _driver = self._partial_remittance(driver, expected=10000, given=9000)
        first.discrepancy_id.invalidate_recordset()

        self.assertTrue(second.discrepancy_id.part_of_a_series)
        self.assertTrue(
            first.discrepancy_id.part_of_a_series,
            "le premier écart de la série se voit rattrapé une fois le seuil atteint",
        )
        self.assertEqual(second.discrepancy_id.same_direction_recent_count, 2)

    def test_series_flag_false_below_threshold(self):
        self.env["ir.config_parameter"].sudo().set_param(
            "babana.cash_discrepancy_alert_series_count", "5"
        )
        remittance, _driver = self._partial_remittance(expected=10000, given=9000)

        self.assertFalse(remittance.discrepancy_id.part_of_a_series)

    # --- Critère 3 : le tableau de bord affiche le total détenu par la flotte -----------------

    def test_dashboard_reports_fleet_total_and_pending_remittances(self):
        driver_a = self._make_driver("Chauffeur A")
        driver_b = self._make_driver("Chauffeur B")
        self._movement(driver_a, "collection", 12000)
        self._movement(driver_b, "collection", 8000)
        driver_a.invalidate_recordset()
        driver_b.invalidate_recordset()
        self.env["babana.cash.remittance"].action_declare(driver=driver_a, declared_amount=12000)

        dashboard = self.env["babana.cash.dashboard"].create({})

        self.assertEqual(dashboard.total_held_amount, 20000)
        self.assertEqual(dashboard.pending_remittances_count, 1)
        self.assertTrue(dashboard.oldest_pending_remittance_id)
        self.assertEqual(dashboard.oldest_pending_remittance_id.driver_id, driver_a)

    def test_dashboard_counts_drivers_at_and_near_the_limit(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.cash_limit", "10000")
        self.env["ir.config_parameter"].sudo().set_param("babana.cash_limit_alert_ratio", "0.8")
        at_limit = self._make_driver("Au plafond")
        near_limit = self._make_driver("Proche du plafond")
        far = self._make_driver("Loin du plafond")
        self._movement(at_limit, "collection", 10000)
        self._movement(near_limit, "collection", 8500)
        self._movement(far, "collection", 1000)
        for driver in (at_limit, near_limit, far):
            driver.invalidate_recordset()

        dashboard = self.env["babana.cash.dashboard"].create({})

        self.assertEqual(dashboard.drivers_at_limit_count, 1)
        self.assertEqual(dashboard.drivers_near_limit_count, 1)
        self.assertEqual(dashboard.cash_limit, 10000)

    def test_driver_cash_limit_near_flag(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.cash_limit", "10000")
        self.env["ir.config_parameter"].sudo().set_param("babana.cash_limit_alert_ratio", "0.8")
        driver = self._make_driver()
        self._movement(driver, "collection", 8500)
        driver.invalidate_recordset()

        self.assertTrue(driver.cash_limit_near)
        self.assertFalse(driver.cash_limit_reached)

    def test_driver_cash_limit_near_is_false_once_the_limit_is_reached(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.cash_limit", "10000")
        self.env["ir.config_parameter"].sudo().set_param("babana.cash_limit_alert_ratio", "0.8")
        driver = self._make_driver()
        self._movement(driver, "collection", 10000)
        driver.invalidate_recordset()

        self.assertFalse(driver.cash_limit_near, "au plafond, ce n'est plus 'proche', c'est atteint")
        self.assertTrue(driver.cash_limit_reached)
