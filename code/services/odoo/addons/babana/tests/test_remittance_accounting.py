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

    # --- Critère 3 (D34) : la créance n'est créditée que du montant compté -------------------

    def test_the_validation_move_never_touches_the_discrepancy_account(self):
        # D29 : un chauffeur qui remet 40 000 sur 45 000 dus. La rédaction précédente de L5-05
        # créditait la créance des 45 000 en entier et faisait apparaître une ligne d'écart dès
        # la validation -- corrigé par D34 (amoa/questions/REPONSES-2026-08-20.md §1) : à la
        # validation, seul ce qui est réellement reçu est comptabilisé.
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
        self.assertFalse(
            discrepancy_lines, "le compte d'écart n'entre en comptabilité qu'à la clôture (L5-06)"
        )

        cash_account = self.env["ir.config_parameter"].sudo().get_param(
            "babana.cash_remittance_cash_account_id"
        )
        cash_lines = move.line_ids.filtered(lambda line: line.account_id.id == int(cash_account))
        self.assertEqual(cash_lines.debit, 40000, "le compte de caisse ne reçoit que le montant compté")

        receivable_account = self.env["ir.config_parameter"].sudo().get_param(
            "babana.cash_remittance_receivable_account_id"
        )
        receivable_lines = move.line_ids.filtered(
            lambda line: line.account_id.id == int(receivable_account)
        )
        self.assertEqual(
            receivable_lines.credit, 40000, "la créance n'est soldée qu'à hauteur du compté"
        )

    def test_no_discrepancy_line_when_the_remittance_is_complete(self):
        remittance, _driver = self._declare_and_validate(declared_amount=1200, counted_amount=1200)

        discrepancy_account = self.env["ir.config_parameter"].sudo().get_param(
            "babana.cash_remittance_discrepancy_account_id"
        )
        discrepancy_lines = remittance.move_id.line_ids.filtered(
            lambda line: line.account_id.id == int(discrepancy_account)
        )
        self.assertFalse(discrepancy_lines, "aucun écart : pas de ligne sur le compte d'écart")

    def test_a_remittance_counted_at_zero_posts_no_move_at_all(self):
        # Compte à zéro (chauffeur qui déclare, puis remet effectivement rien) : rien n'a été
        # réellement reçu, rien ne doit être journalisé (move_id reste vide).
        remittance, _driver = self._declare_and_validate(
            declared_amount=45000, counted_amount=0, movement_amount=45000
        )

        self.assertFalse(remittance.move_id, "rien de reçu, aucune pièce comptable à poser")

    # --- Les deux systèmes se vérifient l'un l'autre (D34) -------------------------------------

    def test_the_accounting_shortfall_matches_the_running_balance(self):
        # Le seul mouvement comptable de cette remise crédite la créance de 40 000 -- le
        # reliquat non crédité (45 000 - 40 000 = 5 000) doit être exactement ce que le compte
        # courant Odoo affiche encore comme dû, tant qu'aucune décision n'a éteint la dette.
        remittance, driver = self._declare_and_validate(
            declared_amount=40000, counted_amount=40000, movement_amount=45000
        )

        receivable_account = self.env["ir.config_parameter"].sudo().get_param(
            "babana.cash_remittance_receivable_account_id"
        )
        credited = sum(
            remittance.move_id.line_ids.filtered(
                lambda line: line.account_id.id == int(receivable_account)
            ).mapped("credit")
        )
        accounting_shortfall = remittance.expected_amount - credited

        driver.invalidate_recordset()
        self.assertEqual(accounting_shortfall, driver.cash_balance)

    def test_two_successive_partial_remittances_never_leave_the_receivable_in_a_credit_balance(self):
        # Le scénario de l'arbitrage D34 : 45 000 dus, 40 000 remis, puis 5 000 remis -- la
        # créance doit tomber exactement à zéro, jamais en dessous.
        driver = self._make_driver()
        self._movement(driver, "collection", 45000)
        driver.invalidate_recordset()

        supervisor = self._make_supervisor()
        first = self.env["babana.cash.remittance"].action_declare(driver=driver, declared_amount=40000)
        first.with_user(supervisor).action_validate(supervisor=supervisor, counted_amount=40000)

        driver.invalidate_recordset()
        self.assertEqual(driver.cash_balance, 5000)

        second = self.env["babana.cash.remittance"].action_declare(driver=driver, declared_amount=5000)
        self.assertEqual(second.expected_amount, 5000, "le second attendu est le solde restant, pas 45 000")
        second.with_user(supervisor).action_validate(supervisor=supervisor, counted_amount=5000)

        driver.invalidate_recordset()
        self.assertEqual(driver.cash_balance, 0, "jamais négatif, jamais créditeur")

        receivable_account = self.env["ir.config_parameter"].sudo().get_param(
            "babana.cash_remittance_receivable_account_id"
        )
        # D69 : bornée aux deux pièces de ce scénario (first.move_id, second.move_id), jamais à
        # une recherche sur tout le compte -- qui mesurerait l'histoire de la base, pas le
        # scénario, et coïnciderait avec 45 000 par accident sur une base vide seulement.
        scenario_moves = first.move_id | second.move_id
        total_credited = sum(
            scenario_moves.line_ids.filtered(
                lambda line: line.account_id.id == int(receivable_account)
            ).mapped("credit")
        )
        self.assertEqual(total_credited, 45000, "le total réellement crédité égale le total reçu, pas plus")

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
