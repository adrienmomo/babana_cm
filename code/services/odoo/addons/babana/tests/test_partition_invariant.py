# Le test qui protège la règle de partition (01-architecture.md §2, reformulée le 10 août) :
# « Une course de cinq minutes et une course de quarante-cinq minutes, comportant le même
# nombre de décisions, produisent exactement le même nombre d'écritures Odoo. » C'est ce test,
# pas sa présence dans un document, qui protège la règle -- s'il n'existait pas, ajouter une
# écriture proportionnelle au temps ou à la distance passerait inaperçu.
#
# Compte les appels réels à create() et à _babana_write_transition() (le seul point de passage
# de toute écriture de `state`, invariant 2) -- pas un décompte manuel qui dériverait de
# l'implémentation. Deux courses au même nombre de décisions humaines mais à la distance et la
# durée enregistrées volontairement très différentes (1 km / 5 min contre 40 km / 45 min) doivent
# produire exactement le même nombre d'écritures.
from __future__ import annotations

from unittest.mock import patch

from odoo.tests.common import TransactionCase, tagged

from ..models.babana_ride_state import BabanaRideState


@tagged("post_install", "-at_install")
class TestPartitionInvariant(TransactionCase):
    def _make_partner(self, name):
        return self.env["res.partner"].create({"name": name})

    def _make_driver(self, name):
        employee = self.env["hr.employee"].create({"name": name})
        return self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})

    def _run_full_ride(self, *, label, actual_distance_km, actual_duration_minutes):
        """Six décisions humaines identiques pour les deux courses : demande, proposition,
        acceptation, démarrage, fin de course, encaissement -- chacune une écriture, quelle
        que soit la durée ou la distance réelle du trajet (amoa/questions/L4-02.md, point 2 :
        action_start écrit bien `state`, contrairement à ce que prévoyait la première version
        de C-03R)."""
        client = self._make_partner(f"Client {label}")
        driver = self._make_driver(f"Chauffeur {label}")

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
        ride.action_start(by_driver=driver)
        ride.action_complete(
            by_driver=driver,
            actual_distance_km=actual_distance_km,
            actual_duration_minutes=actual_duration_minutes,
            final_amount=1500,
        )
        ride.action_settle(by_driver=driver, amount_collected=ride.final_amount)
        return ride

    def test_same_decision_count_produces_same_write_count_regardless_of_duration_and_distance(
        self,
    ):
        with patch.object(
            BabanaRideState, "_babana_write_transition", autospec=True,
            side_effect=BabanaRideState._babana_write_transition,
        ) as mocked_write, patch.object(
            type(self.env["babana.ride"]), "create", autospec=True,
            side_effect=type(self.env["babana.ride"]).create,
        ) as mocked_create:
            short_ride = self._run_full_ride(
                label="course courte", actual_distance_km=1.0, actual_duration_minutes=5
            )
            calls_after_short = mocked_write.call_count
            creates_after_short = mocked_create.call_count

            long_ride = self._run_full_ride(
                label="course longue", actual_distance_km=40.0, actual_duration_minutes=45
            )
            calls_after_long = mocked_write.call_count - calls_after_short
            creates_after_long = mocked_create.call_count - creates_after_short

        self.assertEqual(short_ride.state, "settled")
        self.assertEqual(long_ride.state, "settled")

        # Six décisions -> six écritures : create (demande), propose, accept, start, complete,
        # settle. Le nombre est identique pour les deux courses malgré l'écart de distance et de
        # durée -- c'est tout ce que l'invariant affirme.
        self.assertEqual(creates_after_short, 1)
        self.assertEqual(creates_after_long, 1)
        self.assertEqual(calls_after_short, calls_after_long)
        self.assertEqual(calls_after_short, 5)  # propose, accept, start, complete, settle

        # La distance et la durée enregistrées diffèrent bien du tout au tout : le test ne
        # prouve pas l'invariant par accident, en gardant des courses identiques.
        self.assertNotEqual(short_ride.actual_distance_km, long_ride.actual_distance_km)
        self.assertNotEqual(
            short_ride.actual_duration_minutes, long_ride.actual_duration_minutes
        )
