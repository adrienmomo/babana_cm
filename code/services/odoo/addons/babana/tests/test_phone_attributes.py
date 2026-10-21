# Attributs de vérification de numéro (L1-09, partie modèle) : unicité, cohérence, source unique.
from __future__ import annotations

from odoo.exceptions import ValidationError
from odoo.tests.common import TransactionCase, tagged
from odoo.tools import mute_logger


@tagged("post_install", "-at_install")
class TestPhoneAttributes(TransactionCase):
    def _partner(self, name, **vals):
        return self.env["res.partner"].create({"name": name, **vals})

    def test_verified_number_is_unique_across_partners(self):
        self._partner("A", babana_phone="+237670000001", babana_phone_verified=True)
        with self.assertRaises(Exception), mute_logger("odoo.sql_db"), self.env.cr.savepoint():
            self._partner("B", babana_phone="+237670000001", babana_phone_verified=True)

    def test_partners_without_number_do_not_collide(self):
        self._partner("A")
        self._partner("B")

    def test_phone_without_verified_flag_is_refused(self):
        with self.assertRaises(ValidationError):
            self._partner("A", babana_phone="+237670000002")

    def test_verified_flag_without_phone_is_refused(self):
        with self.assertRaises(ValidationError):
            self._partner("A", babana_phone_verified=True)

    def test_driver_phone_verified_reads_the_partner(self):
        user = self.env["res.users"]._babana_find_or_create_from_google(
            sub="sub-phone-driver", email="d@example.invalid", name="D", role="driver"
        )
        driver = user._babana_driver()
        self.assertFalse(driver.phone_verified)
        user.partner_id.write(
            {"babana_phone": "+237670000003", "babana_phone_verified": True}
        )
        driver.invalidate_recordset()
        self.assertTrue(driver.phone_verified)

    def test_verification_row_defaults(self):
        row = self.env["babana.phone.verification"].create(
            {
                "phone": "+237670000004",
                "role": "client",
                "code_hash": "0" * 64,
                "expires_at": "2099-01-01 00:00:00",
            }
        )
        self.assertEqual((row.attempts, row.state), (0, "pending"))
        self.assertTrue(row.public_id)
