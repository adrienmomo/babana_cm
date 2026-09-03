# Tests de la facture de course (L4-06). Ce que test_settlement.py couvre déjà (atomicité des
# trois autres effets d'action_settle, plafond d'encaisse) n'est pas repris ici -- seulement ce
# que cette tâche ajoute : la pièce elle-même, son détail décomposé, son gabarit d'impression, et
# l'envoi sur demande.
from __future__ import annotations

import json
from unittest.mock import patch

from odoo.exceptions import UserError
from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestInvoice(TransactionCase):
    def _make_partner(self, name="Client", email="client@example.invalid"):
        return self.env["res.partner"].create({"name": name, "email": email})

    def _make_driver(self, name="Chauffeur", license_plate="LT-1234-CI"):
        employee = self.env["hr.employee"].create({"name": name})
        driver = self.env["babana.driver"].create(
            {"employee_id": employee.id, "state": "approved"}
        )
        motorcycle = self.env["babana.motorcycle"].create({"license_plate": license_plate})
        motorcycle.write({"driver_id": driver.id})
        driver.invalidate_recordset()
        return driver

    # Décomposition avec toutes les composantes non nulles sauf le plancher : exerce la vraie
    # règle de visibilité (_FARE_LINES, babana_ride_invoice.py), pas seulement le repli à une
    # ligne. La somme (500 + 700 + 200 - 100 + 0 + 25) fait exactement 1325, le montant final --
    # c'est cette identité que le critère d'acceptation 2 vérifie.
    _BREAKDOWN = {
        "base_fare": 500.0,
        "distance_fare": 700.0,
        "surge_amount": 200.0,
        "discount_amount": 100.0,
        "floor_amount": 0.0,
        "rounding_amount": 25.0,
        "minimum_fare_applied": False,
        "total": 1325.0,
    }

    def _ride_ready_to_settle(self, *, breakdown=None, email="client@example.invalid"):
        client = self._make_partner(email=email)
        driver = self._make_driver()
        breakdown = breakdown if breakdown is not None else self._BREAKDOWN
        vals = {
            "client_id": client.id,
            "pickup_latitude": 4.05,
            "pickup_longitude": 9.70,
            "pickup_label": "Makepe, arrêt de bus",
            "dropoff_latitude": 4.06,
            "dropoff_longitude": 9.77,
            "dropoff_label": "Akwa, rond-point Deido",
            "reference_distance_km": 6.4,
        }
        if breakdown:
            vals["fare_rule_snapshot"] = json.dumps(breakdown)
        ride = self.env["babana.ride"].action_request(vals)
        ride.action_propose(by_partner=client, driver=driver)
        ride.action_accept(by_driver=driver)
        ride.action_start(by_driver=driver)
        final_amount = breakdown["total"] if breakdown else 1200
        ride.action_complete(by_driver=driver, final_amount=final_amount)
        return ride, driver

    # --- Critère 1 : la facture est un account.move avec une numérotation légale --------------

    def test_settle_generates_a_posted_invoice_referencing_the_ride(self):
        ride, driver = self._ride_ready_to_settle()

        ride.action_settle(by_driver=driver, amount_collected=1325)

        self.assertTrue(ride.invoice_id)
        self.assertEqual(ride.invoice_id.move_type, "out_invoice")
        self.assertEqual(ride.invoice_id.state, "posted")
        self.assertNotEqual(ride.invoice_id.name, "/", "la numérotation légale doit être posée")
        self.assertEqual(ride.invoice_id.ref, ride.reference)
        self.assertEqual(ride.invoice_id.partner_id, ride.client_id)
        self.assertEqual(ride.invoice_id.babana_ride_id, ride)

    # --- Critère 2 : une ligne par composante, la somme égale le montant final ----------------

    def test_invoice_lines_match_the_visible_breakdown_and_sum_to_the_final_amount(self):
        ride, driver = self._ride_ready_to_settle()

        ride.action_settle(by_driver=driver, amount_collected=1325)

        lines = ride.invoice_id.invoice_line_ids
        labels = lines.mapped("name")
        self.assertEqual(
            set(labels),
            {"Prise en charge", "Distance", "Majoration", "Remise", "Arrondi"},
            "l'ajustement plancher est nul : il ne doit pas apparaître (règle de "
            "visibleFareLines, apps/client/src/components/fareBreakdown.ts)",
        )
        self.assertEqual(sum(lines.mapped("price_subtotal")), 1325)
        self.assertEqual(round(ride.invoice_id.amount_total), 1325)

    def test_invoice_always_shows_base_and_distance_even_at_zero(self):
        breakdown = dict(self._BREAKDOWN)
        breakdown.update(
            base_fare=0.0, distance_fare=0.0, surge_amount=0.0, discount_amount=0.0,
            floor_amount=1200.0, rounding_amount=0.0, total=1200.0,
        )
        ride, driver = self._ride_ready_to_settle(breakdown=breakdown)

        ride.action_settle(by_driver=driver, amount_collected=1200)

        labels = ride.invoice_id.invoice_line_ids.mapped("name")
        self.assertIn("Prise en charge", labels)
        self.assertIn("Distance", labels)
        self.assertIn("Ajustement plancher", labels)

    # --- Critère 5 : le journal et le compte sont paramétrables -------------------------------

    def test_invoice_uses_the_configured_journal_and_income_account(self):
        journal = self.env["account.journal"].search([("type", "=", "sale")], limit=1)
        other_journal = self.env["account.journal"].create(
            {"name": "Autre journal de vente", "code": "OJRN", "type": "sale"}
        )
        self.assertNotEqual(journal, other_journal)
        self.env["ir.config_parameter"].sudo().set_param(
            "babana.invoice_journal_id", str(other_journal.id)
        )

        ride, driver = self._ride_ready_to_settle()
        ride.action_settle(by_driver=driver, amount_collected=1325)

        self.assertEqual(ride.invoice_id.journal_id, other_journal)

    def test_settle_fails_atomically_when_the_invoice_journal_is_not_configured(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.invoice_journal_id", "")
        ride, driver = self._ride_ready_to_settle()

        with self.assertRaises(UserError):
            ride.action_settle(by_driver=driver, amount_collected=1325)

        self.assertEqual(ride.state, "completed", "l'échec de la facture ne doit rien appliquer")
        self.assertFalse(ride.invoice_id)
        self.assertFalse(self.env["babana.cash.movement"].search([("ride_id", "=", ride.id)]))

    # --- Le montant facturé est celui de la course, gelé --------------------------------------

    def test_invoice_amount_is_frozen_even_if_the_fare_rule_changes_afterwards(self):
        ride, driver = self._ride_ready_to_settle()
        # Une règle déjà utilisée par une course ne se modifie pas en place (L2-01, critère 4) --
        # new_version() est le seul chemin, exactement ce que cette immutabilité protège : la
        # facture ne doit jamais dépendre de la grille en vigueur au moment de l'encaissement.
        fare_rule = self.env["babana.fare.rule"].search([], limit=1)
        if fare_rule:
            fare_rule.sudo().new_version({"base_fare": fare_rule.base_fare + 10_000})

        ride.action_settle(by_driver=driver, amount_collected=1325)

        self.assertEqual(round(ride.invoice_id.amount_total), 1325)

    # --- Dégradation (D30) : une course sans détail décomposé n'empêche pas l'encaissement ----

    def test_missing_fare_snapshot_degrades_to_a_single_line_invoice_instead_of_blocking(self):
        ride, driver = self._ride_ready_to_settle(breakdown={})

        ride.action_settle(by_driver=driver, amount_collected=1200)

        self.assertTrue(ride.invoice_id)
        self.assertEqual(ride.invoice_id.invoice_line_ids.mapped("name"), ["Course"])
        self.assertEqual(round(ride.invoice_id.amount_total), 1200)

    # --- Critère 3 : le PDF se génère et contient toutes les mentions listées -----------------

    def test_report_html_contains_every_required_mention(self):
        ride, driver = self._ride_ready_to_settle()
        ride.action_settle(by_driver=driver, amount_collected=1325)

        html, _report_type = (
            self.env["ir.actions.report"]
            .sudo()
            ._render_qweb_html("babana.report_ride_invoice", ride.invoice_id.ids)
        )
        content = html.decode()
        for mention in (
            ride.reference,
            "Makepe, arrêt de bus",
            "Akwa, rond-point Deido",
            "6.4",
            driver.display_name,
            "LT-1234-CI",
            "Total",
        ):
            self.assertIn(mention, content, f"mention absente du gabarit : {mention!r}")

    def test_report_renders_an_actual_pdf(self):
        ride, driver = self._ride_ready_to_settle()
        ride.action_settle(by_driver=driver, amount_collected=1325)

        # `force_report_rendering` : sous --test-enable, Odoo remplace silencieusement tout PDF
        # par du HTML pour accélérer la suite (ir_actions_report.py, `_render_qweb_pdf`) --
        # ce test existe précisément pour prouver qu'un vrai PDF sort de ce gabarit, il doit
        # donc forcer le vrai rendu plutôt que de vérifier le raccourci de test.
        report = self.env.ref("babana.action_report_ride_invoice")
        pdf_content, report_type = report.sudo().with_context(
            force_report_rendering=True
        )._render_qweb_pdf(report.report_name, ride.invoice_id.ids)
        self.assertEqual(report_type, "pdf")
        self.assertTrue(pdf_content.startswith(b"%PDF"))

    # --- Critère 4 : l'envoi par email fonctionne, à la demande seulement ---------------------

    def test_settle_never_sends_an_email_by_itself(self):
        ride, driver = self._ride_ready_to_settle()

        with patch.object(type(self.env["mail.mail"]), "send") as mock_send:
            ride.action_settle(by_driver=driver, amount_collected=1325)

        mock_send.assert_not_called()

    def test_send_invoice_email_without_an_invoice_is_rejected(self):
        ride, _driver = self._ride_ready_to_settle()

        with self.assertRaises(UserError):
            ride._babana_send_invoice_email()

    def test_send_invoice_email_without_a_client_email_is_rejected(self):
        ride, driver = self._ride_ready_to_settle(email=False)
        ride.action_settle(by_driver=driver, amount_collected=1325)

        with self.assertRaises(UserError):
            ride._babana_send_invoice_email()

    def test_send_invoice_email_queues_a_mail_with_the_pdf_attached(self):
        ride, driver = self._ride_ready_to_settle()
        ride.action_settle(by_driver=driver, amount_collected=1325)

        with patch.object(type(self.env["mail.mail"]), "send") as mock_send:
            result = ride.button_send_invoice_email()

        self.assertTrue(result)
        self.assertEqual(mock_send.call_count, 1)
        mail = self.env["mail.mail"].search(
            [("email_to", "=", "client@example.invalid")], order="id desc", limit=1
        )
        self.assertTrue(mail)
        self.assertEqual(len(mail.attachment_ids), 1)
        self.assertTrue(mail.attachment_ids.name.endswith(".pdf"))
