# Vues flotte back-office (L9-02). Testent les champs et méthodes sur lesquels les vues
# s'appuient, pas leur rendu.
from __future__ import annotations

from datetime import date, timedelta

from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestMotorcycleBackoffice(TransactionCase):
    def _motorcycle(self, **vals):
        n = self.env["babana.motorcycle"].search_count([]) + 1
        return self.env["babana.motorcycle"].create(
            dict({"license_plate": f"LT-{n:04d}-BG"}, **vals)
        )

    def _driver(self):
        employee = self.env["hr.employee"].create({"name": "Chauffeur flotte"})
        return self.env["babana.driver"].create(
            {"employee_id": employee.id, "state": "approved"}
        )

    # --- Critère 2 : l'affectation et la fin d'affectation se font depuis le formulaire -------

    def test_assignment_and_end_from_the_form(self):
        moto = self._motorcycle(insurance_expires_on=date.today() + timedelta(days=200))
        driver = self._driver()

        # Affectation : créer une ligne d'historique (ce que fait le bouton « Affecter un
        # chauffeur » via babana_assignment_new_action). Son create() pose le miroir driver_id.
        assignment = self.env["babana.assignment"].create(
            {"motorcycle_id": moto.id, "driver_id": driver.id}
        )
        self.assertEqual(moto.driver_id, driver)
        self.assertEqual(moto.state, "assigned")
        self.assertFalse(assignment.end_date)

        # Fin d'affectation depuis la fiche moto : clôt la ligne active et efface le miroir.
        moto.action_end_assignment()
        self.assertFalse(moto.driver_id)
        self.assertEqual(moto.state, "available")
        self.assertTrue(assignment.end_date)

    # --- Critère 3 : une moto à l'assurance expirée est visuellement distincte ---------------

    def test_insurance_expired_flag_and_filter(self):
        expired = self._motorcycle(insurance_expires_on=date.today() - timedelta(days=1))
        valid = self._motorcycle(insurance_expires_on=date.today() + timedelta(days=90))
        none = self._motorcycle()

        self.assertTrue(expired.insurance_expired)
        self.assertFalse(valid.insurance_expired)
        self.assertFalse(none.insurance_expired)

        found = self.env["babana.motorcycle"].search([("insurance_expired", "=", True)])
        self.assertIn(expired, found)
        self.assertNotIn(valid, found)
        self.assertNotIn(none, found)

        not_expired = self.env["babana.motorcycle"].search([("insurance_expired", "=", False)])
        self.assertIn(valid, not_expired)
        self.assertIn(none, not_expired)
        self.assertNotIn(expired, not_expired)

    # --- Critère 1 : les échéances à venir sont visibles sans construire de filtre -----------

    def test_upcoming_deadlines_are_queryable(self):
        soon = self._motorcycle(insurance_expires_on=date.today() + timedelta(days=10))
        far = self._motorcycle(insurance_expires_on=date.today() + timedelta(days=300))
        action = self.env.ref("babana.babana_motorcycle_deadlines_action")
        self.assertIn("search_default_insurance_expiring_soon", action.context)
        window_end = date.today() + timedelta(days=30)
        upcoming = self.env["babana.motorcycle"].search(
            [
                ("insurance_expires_on", "!=", False),
                ("insurance_expires_on", ">=", date.today()),
                ("insurance_expires_on", "<=", window_end),
            ]
        )
        self.assertIn(soon, upcoming)
        self.assertNotIn(far, upcoming)

    # --- Critère 4 : l'historique d'affectations est consultable et non modifiable -----------

    def test_assignment_history_field_is_readonly(self):
        field = self.env["babana.motorcycle"]._fields["assignment_ids"]
        self.assertTrue(field.readonly)
