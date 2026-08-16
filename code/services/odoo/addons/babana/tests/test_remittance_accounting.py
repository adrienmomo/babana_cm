# Tests de l'écriture comptable de la remise de caisse (L5-05). Ce que L5-03/L5-04 couvrent déjà
# (gel du montant attendu, concordance/discordance, déblocage du plafond) n'est pas repris ici.
from __future__ import annotations

import uuid

from odoo.exceptions import UserError
from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestRemittanceAccounting(TransactionCase):
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

    def _declare_and_validate(self, *, declared_amount, counted_amount, movement_amount=None):
        driver = self._make_driver()
        self._movement(driver, "collection", movement_amount or declared_amount)
        driver.invalidate_recordset()
        remittance = self.env["babana.cash.remittance"].action_declare(
            driver=driver, declared_amount=declared_amount
        )
        supervisor = self._make_supervisor()
        remittance.with_user(supervisor).action_validate(
            supervisor=supervisor, counted_amount=counted_amount
        )
        return remittance, driver

    # --- Critère 1 : la validation produit une pièce comptable équilibrée --------------------

    def test_validation_posts_a_balanced_journal_entry(self):
        remittance, _driver = self._declare_and_validate(declared_amount=1200, counted_amount=1200)

        move = remittance.move_id
        self.assertTrue(move)
        self.assertEqual(move.state, "posted")
        self.assertEqual(sum(move.line_ids.mapped("debit")), sum(move.line_ids.mapped("credit")))
        self.assertEqual(sum(move.line_ids.mapped("debit")), 1200)

    # --- Critère 4 : la pièce et la remise se référencent mutuellement -----------------------

    def test_the_move_and_the_remittance_reference_each_other(self):
        remittance, _driver = self._declare_and_validate(declared_amount=1200, counted_amount=1200)

        self.assertEqual(remittance.move_id.ref, remittance.reference)

    # --- Critère 3 : un écart produit une écriture distincte sur le compte d'écart -----------

    def test_a_discrepancy_produces_a_distinct_line_on_the_discrepancy_account(self):
        # D29 : un chauffeur qui remet 40 000 sur 45 000 dus.
        remittance, _driver = self._declare_and_validate(
            declared_amount=40000, counted_amount=40000, movement_amount=45000
        )

        move = remittance.move_id
        discrepancy_account = self.env["ir.config_parameter"].sudo().get_param(
            "babana.cash_remittance_discrepancy_account_id"
        )
        discrepancy_lines = move.line_ids.filtered(
            lambda line: line.account_id.id == int(discrepancy_account)
        )
        self.assertEqual(len(discrepancy_lines), 1)
        self.assertEqual(discrepancy_lines.debit, 5000)

        cash_account = self.env["ir.config_parameter"].sudo().get_param(
            "babana.cash_remittance_cash_account_id"
        )
        cash_lines = move.line_ids.filtered(lambda line: line.account_id.id == int(cash_account))
        self.assertEqual(cash_lines.debit, 40000, "le compte de caisse ne reçoit que le montant compté")

    def test_no_discrepancy_line_when_the_remittance_is_complete(self):
        remittance, _driver = self._declare_and_validate(declared_amount=1200, counted_amount=1200)

        discrepancy_account = self.env["ir.config_parameter"].sudo().get_param(
            "babana.cash_remittance_discrepancy_account_id"
        )
        discrepancy_lines = remittance.move_id.line_ids.filtered(
            lambda line: line.account_id.id == int(discrepancy_account)
        )
        self.assertFalse(discrepancy_lines, "aucun écart : pas de ligne sur le compte d'écart")

    # --- Critère 2 : comptes et journaux viennent de la configuration ------------------------

    def test_accounts_and_journal_come_from_configuration(self):
        alternate_journal = self.env["account.journal"].create(
            {"name": "Caisse alternative (test)", "code": "TCAI", "type": "cash"}
        )
        Params = self.env["ir.config_parameter"].sudo()
        Params.set_param("babana.cash_remittance_journal_id", alternate_journal.id)
        Params.set_param(
            "babana.cash_remittance_cash_account_id", alternate_journal.default_account_id.id
        )

        remittance, _driver = self._declare_and_validate(declared_amount=1200, counted_amount=1200)

        self.assertEqual(remittance.move_id.journal_id, alternate_journal)

    def test_a_missing_account_configuration_blocks_validation_and_applies_nothing(self):
        self.env["ir.config_parameter"].sudo().set_param(
            "babana.cash_remittance_receivable_account_id", ""
        )
        driver = self._make_driver()
        self._movement(driver, "collection", 1200)
        driver.invalidate_recordset()
        remittance = self.env["babana.cash.remittance"].action_declare(
            driver=driver, declared_amount=1200
        )
        supervisor = self._make_supervisor()

        with self.assertRaises(UserError):
            remittance.with_user(supervisor).action_validate(
                supervisor=supervisor, counted_amount=1200
            )

        self.assertEqual(remittance.state, "declared", "rien ne doit être appliqué (atomicité)")
        driver.invalidate_recordset()
        self.assertEqual(driver.cash_balance, 1200, "aucun mouvement de remise ne doit exister")

    # --- Critère 5 : annuler une pièce validée exige un mécanisme d'extourne tracé -----------

    def test_a_posted_move_cannot_be_deleted_directly(self):
        remittance, _driver = self._declare_and_validate(declared_amount=1200, counted_amount=1200)

        with self.assertRaises(UserError):
            remittance.move_id.unlink()

    def test_cancelling_a_posted_move_goes_through_a_tracked_reversal(self):
        remittance, _driver = self._declare_and_validate(declared_amount=1200, counted_amount=1200)
        move = remittance.move_id

        reversal = move._reverse_moves([{"date": move.date, "ref": f"Extourne {move.ref}"}])
        reversal.action_post()

        self.assertEqual(reversal.state, "posted")
        self.assertEqual(sum(reversal.line_ids.mapped("debit")), sum(move.line_ids.mapped("credit")))
        self.assertTrue(move.exists(), "la pièce d'origine n'est jamais supprimée, seulement contrepassée")
