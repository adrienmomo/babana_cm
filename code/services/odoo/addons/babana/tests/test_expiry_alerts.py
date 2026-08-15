# Tests des alertes d'échéance (L1-10) : assurance de moto et permis de chauffeur.
from __future__ import annotations

from datetime import timedelta

from odoo.fields import Date
from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestExpiryAlerts(TransactionCase):
    def setUp(self):
        super().setUp()
        self.env["ir.config_parameter"].sudo().set_param(
            "babana.expiry_alert_window_days", "15"
        )

    def _make_motorcycle(self, **vals):
        base = {"license_plate": f"LT-{self.env['babana.motorcycle'].search_count([]) + 1:04d}-BC"}
        base.update(vals)
        return self.env["babana.motorcycle"].create(base)

    def _make_driver(self, name="Chauffeur de test", **vals):
        employee = self.env["hr.employee"].create({"name": name})
        base = {"employee_id": employee.id, "state": "approved"}
        base.update(vals)
        return self.env["babana.driver"].create(base)

    def _make_license_document(self, driver, expires_on):
        # L1-05 (résolution du champ-pont license_expires_on, code/docs/bridge-fields.md) :
        # l'expiration du permis vit désormais sur babana.driver.document, pas sur babana.driver.
        return self.env["babana.driver.document"].create(
            {
                "driver_id": driver.id,
                "document_type": "license",
                "storage_key": "test/irrelevant.jpg",
                "expires_on": expires_on,
            }
        )

    def _run_cron(self):
        self.env["babana.motorcycle"]._cron_check_expiry_alerts()

    # --- Critère 1 : une échéance dans la fenêtre d'alerte produit une notification -----------

    def test_motorcycle_insurance_within_window_produces_a_notification(self):
        moto = self._make_motorcycle(insurance_expires_on=Date.today() + timedelta(days=10))
        before = len(moto.message_ids)

        self._run_cron()

        self.assertGreater(len(moto.message_ids), before)
        self.assertEqual(moto.insurance_alert_sent_on, Date.today())

    def test_motorcycle_insurance_outside_window_produces_no_notification(self):
        moto = self._make_motorcycle(insurance_expires_on=Date.today() + timedelta(days=60))

        self._run_cron()

        self.assertFalse(moto.insurance_alert_sent_on)

    def test_driver_license_within_window_produces_a_notification(self):
        driver = self._make_driver()
        document = self._make_license_document(driver, Date.today() + timedelta(days=5))
        before = len(driver.message_ids)

        self._run_cron()

        self.assertGreater(len(driver.message_ids), before)
        self.assertEqual(document.alert_sent_on, Date.today())

    # --- Critère 2 : assurance expirée bloque l'affectation et met le chauffeur hors ligne ----

    def test_expired_motorcycle_insurance_blocks_affectation_and_puts_driver_offline(self):
        driver = self._make_driver()
        moto = self._make_motorcycle(
            insurance_expires_on=Date.today() + timedelta(days=1),
        )
        moto.write({"driver_id": driver.id})
        driver.write({"is_online": True})

        # Le temps passe : l'assurance vient d'expirer (aucune écriture n'accompagne le passage
        # de la date, d'où la nécessité d'une tâche planifiée plutôt qu'une contrainte seule).
        moto.write({"insurance_expires_on": Date.today() - timedelta(days=1)})

        self._run_cron()

        self.assertEqual(moto.state, "maintenance")
        self.assertFalse(driver.is_online)

    # --- Critère 3 : un permis expiré met le chauffeur hors ligne -----------------------------

    def test_expired_license_puts_driver_offline(self):
        driver = self._make_driver(is_online=True)
        # Le temps passe : aucune écriture n'accompagne le passage de la date (même
        # raisonnement que l'assurance moto, d'où la tâche planifiée).
        self._make_license_document(driver, Date.today() - timedelta(days=1))

        self._run_cron()

        self.assertFalse(driver.is_online)

    # --- Critère 4 : idempotence -- deux exécutions le même jour ne doublent pas l'alerte -----

    def test_running_the_cron_twice_the_same_day_does_not_duplicate_the_notification(self):
        moto = self._make_motorcycle(insurance_expires_on=Date.today() + timedelta(days=10))
        driver = self._make_driver()
        self._make_license_document(driver, Date.today() + timedelta(days=5))

        self._run_cron()
        moto_messages_after_first_run = len(moto.message_ids)
        driver_messages_after_first_run = len(driver.message_ids)

        self._run_cron()

        self.assertEqual(len(moto.message_ids), moto_messages_after_first_run)
        self.assertEqual(len(driver.message_ids), driver_messages_after_first_run)
