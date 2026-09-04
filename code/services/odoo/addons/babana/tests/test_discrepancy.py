# Tests du traitement des écarts de remise de caisse (D29, L5-06). Ce que L5-04/L5-05 couvrent
# déjà (concordance/discordance, écriture comptable) n'est pas repris ici, sauf le critère 1 bis
# (reliquat au solde), explicitement redemandé par cette tâche.
from __future__ import annotations

import uuid

from odoo.exceptions import UserError
from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestCashDiscrepancy(TransactionCase):
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

    def _partial_remittance(self, *, expected=45000, given=40000):
        driver = self._make_driver()
        self._movement(driver, "collection", expected)
        driver.invalidate_recordset()
        remittance = self._declare_and_validate(
            driver, declared_amount=given, counted_amount=given
        )
        return remittance, driver

    # --- Critère 1 : un écart non nul crée systématiquement un enregistrement dédié -----------

    def test_a_nonzero_discrepancy_creates_a_discrepancy_record(self):
        remittance, driver = self._partial_remittance(expected=45000, given=40000)

        discrepancy = self.env["babana.cash.discrepancy"].search(
            [("remittance_id", "=", remittance.id)]
        )
        self.assertEqual(len(discrepancy), 1)
        self.assertEqual(discrepancy.driver_id, driver)
        self.assertEqual(discrepancy.amount, 5000)
        self.assertEqual(discrepancy.direction, "shortfall")
        self.assertEqual(discrepancy.status, "pending")

    def test_a_complete_remittance_creates_no_discrepancy_record(self):
        driver = self._make_driver()
        self._movement(driver, "collection", 1200)
        driver.invalidate_recordset()
        remittance = self._declare_and_validate(driver, declared_amount=1200, counted_amount=1200)

        self.assertFalse(
            self.env["babana.cash.discrepancy"].search([("remittance_id", "=", remittance.id)])
        )

    # --- Critère 1 bis : une remise partielle laisse le reliquat au solde du chauffeur --------

    def test_partial_remittance_leaves_the_remainder_on_the_balance(self):
        _remittance, driver = self._partial_remittance(expected=45000, given=40000)

        driver.invalidate_recordset()
        self.assertEqual(driver.cash_balance, 5000)

    # --- Critère 2 : aucun écart ne peut être clos sans motif ---------------------------------

    def test_closing_without_a_reason_category_is_rejected(self):
        remittance, _driver = self._partial_remittance()
        discrepancy = self.env["babana.cash.discrepancy"].search(
            [("remittance_id", "=", remittance.id)]
        )
        supervisor = self._make_supervisor()

        with self.assertRaises(UserError):
            discrepancy.with_user(supervisor).action_close(
                decided_by=supervisor, decision="left_on_balance", reason_category=None
            )

    def test_closing_with_reason_other_requires_a_comment(self):
        remittance, _driver = self._partial_remittance()
        discrepancy = self.env["babana.cash.discrepancy"].search(
            [("remittance_id", "=", remittance.id)]
        )
        supervisor = self._make_supervisor()

        with self.assertRaises(UserError):
            discrepancy.with_user(supervisor).action_close(
                decided_by=supervisor,
                decision="left_on_balance",
                reason_category="other",
                reason_comment="",
            )

    def test_a_closed_discrepancy_is_immutable(self):
        remittance, _driver = self._partial_remittance()
        discrepancy = self.env["babana.cash.discrepancy"].search(
            [("remittance_id", "=", remittance.id)]
        )
        supervisor = self._make_supervisor()
        discrepancy.with_user(supervisor).action_close(
            decided_by=supervisor,
            decision="left_on_balance",
            reason_category="change_shortage",
        )

        with self.assertRaises(UserError):
            discrepancy.write({"reason_comment": "essai après clôture"})

    # --- Critère 3 : le traitement produit un mouvement de compte courant tracé ---------------

    def test_the_default_treatment_produces_no_extra_movement(self):
        remittance, driver = self._partial_remittance(expected=45000, given=40000)
        discrepancy = self.env["babana.cash.discrepancy"].search(
            [("remittance_id", "=", remittance.id)]
        )
        supervisor = self._make_supervisor()
        movement_count_before = self.env["babana.cash.movement"].search_count(
            [("driver_id", "=", driver.id)]
        )

        discrepancy.with_user(supervisor).action_close(
            decided_by=supervisor,
            decision="left_on_balance",
            reason_category="change_shortage",
        )

        self.assertFalse(discrepancy.adjustment_movement_id)
        self.assertEqual(
            self.env["babana.cash.movement"].search_count([("driver_id", "=", driver.id)]),
            movement_count_before,
        )
        driver.invalidate_recordset()
        self.assertEqual(driver.cash_balance, 5000, "le défaut D29 laisse l'écart au solde")

    def test_an_explicit_adjustment_produces_a_tracked_movement_and_clears_the_balance(self):
        remittance, driver = self._partial_remittance(expected=45000, given=40000)
        discrepancy = self.env["babana.cash.discrepancy"].search(
            [("remittance_id", "=", remittance.id)]
        )
        supervisor = self._make_supervisor()

        discrepancy.with_user(supervisor).action_close(
            decided_by=supervisor,
            decision="adjustment",
            reason_category="counting_error",
        )

        movement = discrepancy.adjustment_movement_id
        self.assertTrue(movement)
        self.assertEqual(movement.movement_type, "adjustment")
        self.assertEqual(movement.amount, -5000)
        self.assertEqual(movement.discrepancy_id, discrepancy)
        driver.invalidate_recordset()
        self.assertEqual(driver.cash_balance, 0)

    # --- D34 : c'est ici, et seulement ici, que le compte d'écart entre en comptabilité -------

    def test_an_explicit_adjustment_writes_off_the_remaining_receivable(self):
        remittance, driver = self._partial_remittance(expected=45000, given=40000)
        discrepancy = self.env["babana.cash.discrepancy"].search(
            [("remittance_id", "=", remittance.id)]
        )
        supervisor = self._make_supervisor()

        discrepancy.with_user(supervisor).action_close(
            decided_by=supervisor,
            decision="adjustment",
            reason_category="counting_error",
        )

        move = discrepancy.write_off_move_id
        self.assertTrue(move, "la décision qui éteint la dette pose sa propre pièce comptable")
        self.assertEqual(move.state, "posted")

        discrepancy_account = self.env["ir.config_parameter"].sudo().get_param(
            "babana.cash_remittance_discrepancy_account_id"
        )
        discrepancy_lines = move.line_ids.filtered(
            lambda line: line.account_id.id == int(discrepancy_account)
        )
        self.assertEqual(discrepancy_lines.debit, 5000)

        receivable_account = self.env["ir.config_parameter"].sudo().get_param(
            "babana.cash_remittance_receivable_account_id"
        )
        # Créance totalement soldée en comptabilité une fois la dette éteinte : 40 000 crédités à
        # la validation (remittance.move_id) + 5 000 ici (move) = 45 000, le montant attendu en
        # entier. D69 : bornée aux deux pièces de ce scénario, jamais à une recherche sur tout le
        # compte -- qui mesurerait l'histoire de la base, pas le scénario.
        scenario_moves = remittance.move_id | move
        total_credited = sum(
            scenario_moves.line_ids.filtered(
                lambda line: line.account_id.id == int(receivable_account)
            ).mapped("credit")
        )
        self.assertEqual(total_credited, 45000)

    def test_the_default_treatment_posts_no_write_off_move(self):
        remittance, _driver = self._partial_remittance(expected=45000, given=40000)
        discrepancy = self.env["babana.cash.discrepancy"].search(
            [("remittance_id", "=", remittance.id)]
        )
        supervisor = self._make_supervisor()

        discrepancy.with_user(supervisor).action_close(
            decided_by=supervisor,
            decision="left_on_balance",
            reason_category="change_shortage",
        )

        self.assertFalse(
            discrepancy.write_off_move_id, "ne rien décider, c'est laisser la dette où elle est"
        )

    # --- Critère 4 : le seuil d'écart cumulé déclenche une alerte -----------------------------

    def test_a_cumulative_amount_over_the_threshold_triggers_an_alert(self):
        self.env["ir.config_parameter"].sudo().set_param(
            "babana.cash_discrepancy_alert_amount_threshold", "1000"
        )
        self.env["ir.config_parameter"].sudo().set_param(
            "babana.cash_discrepancy_alert_series_count", "100"
        )
        _remittance, driver = self._partial_remittance(expected=45000, given=40000)

        alert = driver.message_ids.filtered(lambda m: "Alerte écarts de caisse" in (m.body or ""))
        self.assertTrue(alert, "5 000 d'écart au-delà du seuil de 1 000 doit alerter")

    def test_a_cumulative_amount_under_the_threshold_does_not_alert(self):
        self.env["ir.config_parameter"].sudo().set_param(
            "babana.cash_discrepancy_alert_amount_threshold", "1000000"
        )
        self.env["ir.config_parameter"].sudo().set_param(
            "babana.cash_discrepancy_alert_series_count", "100"
        )
        _remittance, driver = self._partial_remittance(expected=45000, given=40000)

        alert = driver.message_ids.filtered(lambda m: "Alerte écarts de caisse" in (m.body or ""))
        self.assertFalse(alert, "un seul petit écart, loin sous le seuil, ne doit pas alerter")

    # --- Critère 5 : une série d'écarts de même sens chez un chauffeur est détectée -----------

    def test_a_series_of_same_direction_discrepancies_triggers_an_alert(self):
        self.env["ir.config_parameter"].sudo().set_param(
            "babana.cash_discrepancy_alert_amount_threshold", "1000000"
        )
        self.env["ir.config_parameter"].sudo().set_param(
            "babana.cash_discrepancy_alert_series_count", "2"
        )
        driver = self._make_driver()

        self._movement(driver, "collection", 10000)
        driver.invalidate_recordset()
        self._declare_and_validate(driver, declared_amount=9000, counted_amount=9000)
        no_alert_yet = driver.message_ids.filtered(
            lambda m: "Alerte écarts de caisse" in (m.body or "")
        )
        self.assertFalse(no_alert_yet, "un seul écart isolé est banal (spécification)")

        self._movement(driver, "collection", 10000)
        driver.invalidate_recordset()
        self._declare_and_validate(driver, declared_amount=9000, counted_amount=9000)

        alert = driver.message_ids.filtered(lambda m: "Alerte écarts de caisse" in (m.body or ""))
        self.assertTrue(alert, "deux écarts de même sens atteignent le seuil de série (2)")
