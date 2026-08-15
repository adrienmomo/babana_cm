# Tests de la consolidation de fin de course (L4-04). action_complete lui-même (L4-02) reste
# inchangé -- il écrit déjà l'ensemble des champs de fin de course en une seule opération
# (_babana_write_transition). Ce que L4-04 ajoute vit dans babana.ride : le calcul du montant
# final sur la distance de référence (_babana_compute_final_amount) et le signalement d'écart
# (distance_deviation_flagged).
from __future__ import annotations

from odoo.exceptions import UserError
from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestRideCompletion(TransactionCase):
    def _make_partner(self, name="Client"):
        return self.env["res.partner"].create({"name": name})

    def _make_driver(self, name="Chauffeur"):
        employee = self.env["hr.employee"].create({"name": name})
        return self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})

    def _ride_in_progress(self, *, reference_distance_km=5.0, estimated_amount=1000):
        client = self._make_partner()
        driver = self._make_driver()
        ride = self.env["babana.ride"].action_request(
            {
                "client_id": client.id,
                "pickup_latitude": 4.05,
                "pickup_longitude": 9.70,
                "dropoff_latitude": 4.06,
                "dropoff_longitude": 9.77,
                "reference_distance_km": reference_distance_km,
                "estimated_amount": estimated_amount,
            }
        )
        ride.action_propose(by_partner=client, driver=driver)
        ride.action_accept(by_driver=driver)
        ride.action_start(by_driver=driver)
        return ride, client, driver

    def _complete(self, ride, driver, *, actual_distance_km, actual_duration_minutes=15,
                  track_polyline="abc123"):
        final_amount = ride._babana_compute_final_amount()
        ride.action_complete(
            by_driver=driver,
            actual_distance_km=actual_distance_km,
            actual_duration_minutes=actual_duration_minutes,
            track_polyline=track_polyline,
            final_amount=final_amount,
        )
        return final_amount

    # --- Critère 1 : le tracé est écrit en une seule opération ---------------------------------

    def test_track_polyline_is_archived_with_completion(self):
        ride, _client, driver = self._ride_in_progress()
        self._complete(ride, driver, actual_distance_km=5.2, track_polyline="xyz789")
        self.assertEqual(ride.track_polyline, "xyz789")
        self.assertEqual(ride.state, "completed")

    # --- Critère 2 : le montant final est calculé sur la distance de référence ----------------

    def test_final_amount_is_based_on_reference_distance_not_actual(self):
        ride, _client, driver = self._ride_in_progress(
            reference_distance_km=5.0, estimated_amount=1000
        )
        # La distance parcourue diverge fortement de la distance de référence -- le montant
        # final ne doit pas en tenir compte.
        final_amount = self._complete(ride, driver, actual_distance_km=9.0)
        self.assertEqual(final_amount, 1000)
        self.assertEqual(ride.final_amount, 1000)

    # --- Critère 3 : un écart au-delà du seuil est signalé sans bloquer la fin de course ------

    def test_large_deviation_is_flagged_but_does_not_block_completion(self):
        self.env["ir.config_parameter"].sudo().set_param(
            "babana.distance_deviation_threshold_km", "2.0"
        )
        ride, _client, driver = self._ride_in_progress(reference_distance_km=5.0)
        self._complete(ride, driver, actual_distance_km=9.0)  # écart de 4 km > seuil de 2 km

        self.assertEqual(ride.state, "completed")
        self.assertAlmostEqual(ride.distance_deviation_km, 4.0)
        self.assertTrue(ride.distance_deviation_flagged)

    def test_small_deviation_is_not_flagged(self):
        self.env["ir.config_parameter"].sudo().set_param(
            "babana.distance_deviation_threshold_km", "2.0"
        )
        ride, _client, driver = self._ride_in_progress(reference_distance_km=5.0)
        self._complete(ride, driver, actual_distance_km=5.5)  # écart de 0.5 km < seuil

        self.assertFalse(ride.distance_deviation_flagged)

    # --- Critère 4 : distance et montant sont immuables après completed -----------------------

    def test_distance_and_amount_are_frozen_after_completion(self):
        ride, _client, driver = self._ride_in_progress()
        self._complete(ride, driver, actual_distance_km=5.1)

        with self.assertRaises(UserError):
            ride.write({"final_amount": 9999})
        with self.assertRaises(UserError):
            ride.write({"actual_distance_km": 42.0})

    # --- Critère 5 : toute différence entre estimé et final est explicitée dans le détail -----

    def test_final_amount_matches_estimated_when_no_promotion_mechanism_exists(self):
        # babana.promotion (L2-06) n'existe pas encore (amoa/questions/L2-04.md) : le montant
        # final ne peut donc jamais différer de l'estimé aujourd'hui -- ce test documente cette
        # limite plutôt que de la laisser implicite. Le point d'accroche
        # (_babana_compute_final_amount) existe pour que L2-06 n'ait qu'à le brancher.
        ride, _client, driver = self._ride_in_progress(estimated_amount=1200)
        final_amount = self._complete(ride, driver, actual_distance_km=5.0)
        self.assertEqual(final_amount, ride.estimated_amount)
