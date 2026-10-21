# « Sur place », attente du client et « client absent ».
#
# « Sur place » est une décision humaine du chauffeur : une écriture (`arrived_at`), une seule,
# jamais une transition d'état (la course reste `assigned`). Elle ouvre un délai de grâce
# (`babana.no_show_grace_seconds`, paramétrable dans Paramètres > Babana) au-delà duquel le
# chauffeur peut annuler pour « client absent » -- une règle tranchée ici, jamais dans l'app
# (invariant 3).
from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch

from odoo import fields
from odoo.exceptions import ValidationError
from odoo.tests.common import TransactionCase, tagged

from ..models.babana_ride_state import NO_SHOW_REASON, RideInvalidTransition, RideNoShowTooEarly
from ..services import realtime_client


@tagged("post_install", "-at_install")
class TestRideArrival(TransactionCase):
    def setUp(self):
        super().setUp()
        self.env["ir.config_parameter"].sudo().set_param("babana.no_show_grace_seconds", "300")
        patcher = patch.object(realtime_client, "notify_driver_arrived")
        self.notify_arrived = patcher.start()
        self.addCleanup(patcher.stop)

    def _make_driver(self, name="Chauffeur"):
        employee = self.env["hr.employee"].create({"name": name})
        return self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})

    def _ride_at_assigned(self):
        client = self.env["res.partner"].create({"name": "Client"})
        # Un vrai compte client (comme après inscription) : c'est lui qu'on prévient de l'arrivée.
        self.env["res.users"].sudo().create(
            {"name": "Client", "login": f"arrival-{client.id}@example.invalid", "partner_id": client.id}
        )
        driver = self._make_driver()
        ride = self.env["babana.ride"].action_request(
            {
                "client_id": client.id,
                "pickup_latitude": 4.05,
                "pickup_longitude": 9.70,
                "dropoff_latitude": 4.06,
                "dropoff_longitude": 9.77,
            }
        )
        ride.action_propose(by_partner=client, driver=driver)
        ride.action_accept(by_driver=driver)
        return ride, driver

    # --- Sur place ---------------------------------------------------------------------------

    def test_arrival_is_recorded_without_changing_the_state(self):
        ride, driver = self._ride_at_assigned()
        ride.action_mark_arrived(by_driver=driver)
        self.assertTrue(ride.arrived_at)
        self.assertEqual(ride.state, "assigned")

    def test_arrival_is_written_once(self):
        # Une décision, une écriture : un second « Sur place » (rejeu réseau) ne déplace pas
        # l'heure d'arrivée -- c'est elle qui fait foi pour le délai de grâce.
        ride, driver = self._ride_at_assigned()
        ride.action_mark_arrived(by_driver=driver)
        first = ride.arrived_at
        ride.write({"arrived_at": first - timedelta(seconds=30)})  # recule l'horloge du test
        first = ride.arrived_at
        ride.action_mark_arrived(by_driver=driver)
        self.assertEqual(ride.arrived_at, first)
        self.assertEqual(self.notify_arrived.call_count, 1)

    def test_arrival_notifies_the_client_with_the_grace_period(self):
        ride, driver = self._ride_at_assigned()
        ride.action_mark_arrived(by_driver=driver)
        kwargs = self.notify_arrived.call_args.kwargs
        self.assertEqual(kwargs["ride_public_id"], ride.public_id)
        self.assertEqual(kwargs["driver_public_id"], driver.public_id)
        self.assertEqual(kwargs["no_show_grace_seconds"], 300)

    def test_only_the_assigned_driver_can_declare_arrival(self):
        ride, _driver = self._ride_at_assigned()
        with self.assertRaises(RideInvalidTransition):
            ride.action_mark_arrived(by_driver=self._make_driver("Autre"))
        self.assertFalse(ride.arrived_at)

    def test_arrival_only_while_assigned(self):
        ride, driver = self._ride_at_assigned()
        ride.action_start(by_driver=driver)
        with self.assertRaises(RideInvalidTransition):
            ride.action_mark_arrived(by_driver=driver)

    # --- Client absent -------------------------------------------------------------------------

    def _arrived_seconds_ago(self, seconds):
        ride, driver = self._ride_at_assigned()
        ride.action_mark_arrived(by_driver=driver)
        ride.write({"arrived_at": fields.Datetime.now() - timedelta(seconds=seconds)})
        return ride, driver

    def test_no_show_after_the_grace_period_cancels_the_ride(self):
        ride, driver = self._arrived_seconds_ago(301)
        with patch.object(realtime_client, "notify_ride_cancelled"):
            ride.action_cancel_no_show(by_driver=driver)
        self.assertEqual(ride.state, "cancelled")
        self.assertEqual(ride.cancel_reason, NO_SHOW_REASON)
        self.assertEqual(ride.cancel_category, "client_no_show")

    def test_no_show_before_the_grace_period_is_refused(self):
        ride, driver = self._arrived_seconds_ago(120)
        with self.assertRaises(RideNoShowTooEarly):
            ride.action_cancel_no_show(by_driver=driver)
        self.assertEqual(ride.state, "assigned")

    def test_no_show_without_arrival_is_refused(self):
        # Le délai court depuis « Sur place » : sans arrivée déclarée, aucun délai n'a commencé.
        ride, driver = self._ride_at_assigned()
        with self.assertRaises(RideNoShowTooEarly):
            ride.action_cancel_no_show(by_driver=driver)

    def test_no_show_by_another_driver_is_refused(self):
        ride, _driver = self._arrived_seconds_ago(301)
        with self.assertRaises(RideInvalidTransition):
            ride.action_cancel_no_show(by_driver=self._make_driver("Autre"))

    def test_the_grace_period_comes_from_the_setting(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.no_show_grace_seconds", "60")
        ride, driver = self._arrived_seconds_ago(61)
        with patch.object(realtime_client, "notify_ride_cancelled"):
            ride.action_cancel_no_show(by_driver=driver)
        self.assertEqual(ride.state, "cancelled")


@tagged("post_install", "-at_install")
class TestBabanaSettings(TransactionCase):
    """Paramètres > Babana : les délais d'une course, modifiables sans le mode développeur. Chaque
    champ est l'`ir.config_parameter` que le code lit déjà -- une seule source de vérité."""

    def _settings(self, **vals):
        return self.env["res.config.settings"].create(vals)

    def test_saving_the_settings_writes_the_parameters_the_code_reads(self):
        self._settings(
            babana_no_show_grace_seconds=420,
            babana_quote_validity_seconds=180,
            babana_otp_ttl_seconds=240,
        ).execute()
        get = self.env["ir.config_parameter"].sudo().get_param
        self.assertEqual(get("babana.no_show_grace_seconds"), "420")
        self.assertEqual(get("babana.quote_validity_seconds"), "180")
        self.assertEqual(get("babana.otp_ttl_seconds"), "240")

    def test_the_page_shows_the_current_values(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.no_show_grace_seconds", "360")
        self.assertEqual(self.env["res.config.settings"].create({}).babana_no_show_grace_seconds, 360)

    def test_a_delay_must_be_positive(self):
        with self.assertRaises(ValidationError):
            self._settings(babana_no_show_grace_seconds=0).execute()
