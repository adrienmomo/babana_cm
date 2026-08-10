# Tests de l'extension res.partner (L1-04).
from __future__ import annotations

from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestBabanaPartner(TransactionCase):
    # --- Critère 1 : un client créé par L1-01 est un res.partner avec babana_is_customer vrai

    def test_client_created_by_google_auth_is_marked_customer(self):
        user = self.env["res.users"]._babana_find_or_create_from_google(
            sub="sub-partner-test",
            email="client@example.invalid",
            name="Client de test",
            role="client",
        )

        self.assertTrue(user.partner_id.babana_is_customer)
        self.assertEqual(user.partner_id.babana_google_sub, "sub-partner-test")

    def test_driver_account_does_not_mark_its_partner_as_customer(self):
        employee_user = self.env["res.users"]._babana_find_or_create_from_google(
            sub="sub-driver-not-customer",
            email="driver@example.invalid",
            name="Chauffeur de test",
            role="driver",
        )

        self.assertFalse(employee_user.partner_id.babana_is_customer)

    # --- Critère 2 : babana_google_sub est unique --------------------------------------------

    def test_babana_google_sub_is_unique(self):
        self.env["res.partner"].create(
            {"name": "Premier", "babana_google_sub": "sub-unique-partner"}
        )
        with self.assertRaises(Exception):
            self.env["res.partner"].create(
                {"name": "Second", "babana_google_sub": "sub-unique-partner"}
            )

    def test_multiple_partners_without_google_sub_do_not_collide(self):
        # NULL n'est jamais égal à NULL pour une contrainte unique SQL : deux partenaires sans
        # compte Google (la grande majorité des contacts Odoo classiques) doivent coexister.
        self.env["res.partner"].create({"name": "Sans Google 1"})
        self.env["res.partner"].create({"name": "Sans Google 2"})

    # --- Critère 3 : une facture peut être émise à ce partenaire sans traitement particulier -

    def test_invoice_can_be_issued_to_babana_customer_without_special_handling(self):
        user = self.env["res.users"]._babana_find_or_create_from_google(
            sub="sub-invoice-test",
            email="facture@example.invalid",
            name="Client Facturé",
            role="client",
        )

        invoice = self.env["account.move"].create(
            {
                "move_type": "out_invoice",
                "partner_id": user.partner_id.id,
                "invoice_line_ids": [
                    (
                        0,
                        0,
                        {
                            "name": "Course babana",
                            "quantity": 1,
                            "price_unit": 1000.0,
                        },
                    )
                ],
            }
        )

        self.assertEqual(invoice.partner_id, user.partner_id)
        self.assertEqual(invoice.amount_total, 1000.0)
