# Vues back-office du dossier chauffeur (L9-01). Ne testent pas le rendu des vues, mais ce sur
# quoi elles s'appuient : les champs et méthodes que les critères d'acceptation exigent.
from __future__ import annotations

import uuid

from odoo.exceptions import UserError
from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestDriverBackoffice(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.env = cls.env(context=dict(cls.env.context, tracking_disable=True))
        cls.manager = cls.env["res.users"].create(
            {
                "name": "Gestionnaire",
                "login": "manager-%s" % uuid.uuid4(),
                "email": "manager-%s@example.invalid" % uuid.uuid4(),
                "groups_id": [(6, 0, [cls.env.ref("babana.group_babana_manager").id])],
            }
        )
        cls.portal = cls.env.ref("base.group_portal")

    def _driver(self, **vals):
        return self.env["babana.driver"].create(vals)

    def _motorcycle(self):
        n = self.env["babana.motorcycle"].search_count([]) + 1
        return self.env["babana.motorcycle"].create({"license_plate": f"LT-{n:04d}-BF"})

    def _approve(self, driver):
        for document_type in ("license", "id_card"):
            vals = {
                "driver_id": driver.id,
                "document_type": document_type,
                "storage_key": f"test/{document_type}-{uuid.uuid4().hex}.jpg",
                "verification_status": "verified",
            }
            if document_type == "license":
                vals["expires_on"] = "2035-01-01"
            self.env["babana.driver.document"].create(vals)
        self._motorcycle().write({"driver_id": driver.id})
        driver.invalidate_recordset()
        driver.action_approve(new_employee_name="Employé test")

    # --- Critère 1 : la liste montre solde et statut sans ouvrir le formulaire ---------------

    def test_list_fields_are_readable_without_the_form(self):
        driver = self._driver()
        row = driver.read(["display_name", "state", "cash_balance", "is_online", "last_ride_at"])[0]
        self.assertEqual(row["state"], "pending")
        self.assertEqual(row["cash_balance"], 0.0)
        # display_name : jamais « babana.driver,3 ».
        self.assertNotIn("babana.driver,", row["display_name"])

    # --- Critère 2 : tous les filtres listés fonctionnent -----------------------------------

    def test_filter_no_motorcycle(self):
        without = self._driver()
        with_moto = self._driver()
        self._motorcycle().write({"driver_id": with_moto.id})
        found = self.env["babana.driver"].search([("motorcycle_id", "=", False)])
        self.assertIn(without, found)
        self.assertNotIn(with_moto, found)
        found_with = self.env["babana.driver"].search([("motorcycle_id", "!=", False)])
        self.assertIn(with_moto, found_with)
        self.assertNotIn(without, found_with)

    def test_filter_cash_limit_reached(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.cash_limit", "10000")
        at_limit = self._driver()
        self._approve(at_limit)
        self.env["babana.cash.movement"].create(
            {"driver_id": at_limit.id, "movement_type": "collection", "amount": 12000}
        )
        under = self._driver()
        self._approve(under)
        reached = self.env["babana.driver"].search([("cash_limit_reached", "=", True)])
        self.assertIn(at_limit, reached)
        self.assertNotIn(under, reached)
        not_reached = self.env["babana.driver"].search([("cash_limit_reached", "=", False)])
        self.assertIn(under, not_reached)
        self.assertNotIn(at_limit, not_reached)

    def test_filter_online_and_state(self):
        driver = self._driver()
        self._approve(driver)
        driver.write({"is_online": True})
        self.assertIn(driver, self.env["babana.driver"].search([("is_online", "=", True)]))
        self.assertIn(driver, self.env["babana.driver"].search([("state", "=", "approved")]))

    # --- Critère 3 : documents consultables par URL signée, lecture au nom de l'utilisateur --

    def test_document_preview_returns_a_signed_url_for_a_manager(self):
        driver = self._driver()
        document = self.env["babana.driver.document"].create(
            {
                "driver_id": driver.id,
                "document_type": "id_card",
                "storage_key": "test/id-%s.jpg" % uuid.uuid4().hex,
            }
        )
        action = document.with_user(self.manager).action_preview()
        self.assertEqual(action["type"], "ir.actions.act_url")
        self.assertIn(document.storage_key, action["url"])
        self.assertEqual(action["target"], "new")

    def test_document_preview_is_denied_to_a_non_manager(self):
        driver = self._driver()
        document = self.env["babana.driver.document"].create(
            {
                "driver_id": driver.id,
                "document_type": "id_card",
                "storage_key": "test/id-%s.jpg" % uuid.uuid4().hex,
            }
        )
        outsider = self.env["res.users"].create(
            {
                "name": "Client",
                "login": "client-%s" % uuid.uuid4(),
                "groups_id": [(6, 0, [self.portal.id])],
            }
        )
        # D54 : la lecture passe par un `search` au nom de l'appelant. Pour un utilisateur
        # portail non rattaché à ce chauffeur, la règle d'enregistrement filtre la ligne ->
        # `search` vide -> « introuvable », jamais l'URL. On ne confirme même pas l'existence.
        with self.assertRaises(UserError):
            document.with_user(outsider).action_preview()

    # --- Critère 4 : les actions de validation sont accessibles depuis le formulaire --------
    # (via l'assistant babana.driver.decision, seule saisie possible d'un motif / choix employé)

    def test_decision_wizard_rejects_with_a_reason(self):
        driver = self._driver()
        wizard = self.env["babana.driver.decision"].with_user(self.manager).create(
            {"driver_id": driver.id, "decision": "reject", "reason": "Permis illisible"}
        )
        wizard.action_confirm()
        self.assertEqual(driver.state, "rejected")
        self.assertEqual(driver.rejection_reason, "Permis illisible")

    def test_decision_wizard_suspends_with_a_reason(self):
        driver = self._driver()
        self._approve(driver)
        wizard = self.env["babana.driver.decision"].with_user(self.manager).create(
            {"driver_id": driver.id, "decision": "suspend", "reason": "Signalement"}
        )
        wizard.action_confirm()
        self.assertEqual(driver.state, "suspended")

    def test_decision_wizard_approves_with_a_new_employee(self):
        driver = self._driver()
        for document_type in ("license", "id_card"):
            vals = {
                "driver_id": driver.id,
                "document_type": document_type,
                "storage_key": f"test/{document_type}-{uuid.uuid4().hex}.jpg",
                "verification_status": "verified",
            }
            if document_type == "license":
                vals["expires_on"] = "2035-01-01"
            self.env["babana.driver.document"].create(vals)
        self._motorcycle().write({"driver_id": driver.id})
        driver.invalidate_recordset()
        wizard = self.env["babana.driver.decision"].with_user(self.manager).create(
            {
                "driver_id": driver.id,
                "decision": "approve",
                "employee_mode": "new",
                "new_employee_name": "Recrue via assistant",
            }
        )
        wizard.action_confirm()
        self.assertEqual(driver.state, "approved")
        self.assertEqual(driver.employee_id.name, "Recrue via assistant")

    def test_decision_wizard_requires_a_reason_for_a_negative_decision(self):
        driver = self._driver()
        wizard = self.env["babana.driver.decision"].with_user(self.manager).create(
            {"driver_id": driver.id, "decision": "reject", "reason": False}
        )
        with self.assertRaises(UserError):
            wizard.action_confirm()

    # --- Critère 5 : les états critiques sont visuellement distincts (champs de décoration) --

    def test_critical_state_flags(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.cash_limit", "5000")
        driver = self._driver()
        # Un seul permis, expiré (pas de _approve, qui en créerait un valide à la même seconde).
        self.env["babana.driver.document"].create(
            {
                "driver_id": driver.id,
                "document_type": "id_card",
                "storage_key": "test/id-%s.jpg" % uuid.uuid4().hex,
                "verification_status": "verified",
            }
        )
        self.env["babana.driver.document"].create(
            {
                "driver_id": driver.id,
                "document_type": "license",
                "storage_key": "test/exp-%s.jpg" % uuid.uuid4().hex,
                "expires_on": "2000-01-01",
                "verification_status": "verified",
            }
        )
        self._motorcycle().write({"driver_id": driver.id})
        driver.invalidate_recordset()
        driver.action_approve(new_employee_name="Employé test")
        # Plafond atteint.
        self.env["babana.cash.movement"].create(
            {"driver_id": driver.id, "movement_type": "collection", "amount": 6000}
        )
        driver.invalidate_recordset()
        self.assertTrue(driver.document_expired)
        self.assertTrue(driver.cash_limit_reached)
