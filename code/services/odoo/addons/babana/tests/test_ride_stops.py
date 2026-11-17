# Arrêts d'une course (L4-14, amoa/specs/L4-course.md). Les critères d'acceptation sont repris
# dans l'ordre. Le routage est remplacé par une distance déterministe : ce qui est testé ici est
# la règle des arrêts, pas le fournisseur (testé contre mock-maps par test_quote_stops.py).
from __future__ import annotations

import json
from datetime import timedelta
from unittest.mock import patch

from odoo import fields
from odoo.tests.common import TransactionCase, tagged

from ..models.babana_ride_state import RideInvalidTransition
from ..models.babana_ride_stop import (
    StopNotFound,
    StopQuoteExpired,
    TooManyStops,
    clamp_event_time,
)
from ..services import push, realtime_client, routing


def _fake_route(env, *, points, vehicle_class, at_datetime):
    # 1 km par tronçon : la distance dit combien de points l'itinéraire traverse.
    return routing.RouteResult(distance_meters=1000 * (len(points) - 1), duration_seconds=240, polyline="")


@tagged("post_install", "-at_install")
class TestRideStops(TransactionCase):
    def setUp(self):
        super().setUp()
        for name in ("notify_ride_started", "notify_driver_arrived"):
            patcher = patch.object(realtime_client, name)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(routing, "get_reference_route_through", side_effect=_fake_route)
        self.route = patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.object(push, "notify_users_async")
        self.push = patcher.start()
        self.addCleanup(patcher.stop)
        self.env["ir.config_parameter"].sudo().set_param("babana.max_stops_per_ride", "3")
        self.rule = self.env["babana.fare.rule"].create(
            {
                "name": "Grille arrêts",
                "base_fare": 200.0,
                "price_per_km": 100.0,
                "approach_price_per_km": 0.0,
                "minimum_fare": 300.0,
                "stop_flat_fee": 100.0,
                "priority": 99,
            }
        )

    # --- Mise en place -------------------------------------------------------------------------

    def _make_driver(self):
        employee = self.env["hr.employee"].create({"name": "Chauffeur arrêts"})
        user = self.env["res.users"].sudo().create(
            {"name": "Chauffeur arrêts", "login": f"stops-driver-{employee.id}@example.invalid"}
        )
        return self.env["babana.driver"].create(
            {"employee_id": employee.id, "state": "approved", "user_id": user.id}
        )

    def _ride(self, *, stops=(), state="in_progress"):
        client = self.env["res.partner"].create({"name": "Client arrêts"})
        self.env["res.users"].sudo().create(
            {"name": "Client arrêts", "login": f"stops-client-{client.id}@example.invalid", "partner_id": client.id}
        )
        driver = self._make_driver()
        ride = self.env["babana.ride"].action_request(
            {
                "client_id": client.id,
                "pickup_latitude": 4.05,
                "pickup_longitude": 9.70,
                "dropoff_latitude": 4.06,
                "dropoff_longitude": 9.77,
                "fare_rule_id": self.rule.id,
                "estimated_amount": 500.0,
                "reference_distance_km": 1.0,
                "stop_wait_snapshot": json.dumps(self.rule._stop_wait_snapshot()),
                "stop_ids": [
                    (0, 0, {"sequence": i, "latitude": lat, "longitude": lng, "kind": "planned"})
                    for i, (lat, lng) in enumerate(stops, start=1)
                ],
            }
        )
        ride.action_propose(by_partner=client, driver=driver)
        ride.action_accept(by_driver=driver)
        if state == "in_progress":
            ride.action_start(by_driver=driver)
        return ride, client, driver

    def _past(self, ride, seconds):
        """Recule le démarrage : les heures d'événements ci-dessous doivent pouvoir le suivre."""
        ride.with_context(babana_allow_state_write=True).write(
            {"started_at": fields.Datetime.now() - timedelta(seconds=seconds)}
        )

    # --- Critère 1 : écritures bornées par les décisions, pas par la durée --------------------

    def _count_stop_writes(self, wait_seconds):
        ride, _client, driver = self._ride(stops=[(4.051, 9.71), (4.052, 9.72)])
        self._past(ride, 3600)
        counts = {"create": 0, "write": 0}
        stop_model = type(self.env["babana.ride.stop"])
        original_create, original_write = stop_model.create, stop_model.write

        def counting_create(model, vals_list):
            counts["create"] += 1
            return original_create(model, vals_list)

        def counting_write(model, vals):
            counts["write"] += 1
            return original_write(model, vals)

        start = ride.started_at
        with patch.object(stop_model, "create", counting_create), patch.object(stop_model, "write", counting_write):
            clock = start
            for stop in ride.stop_ids.sorted("sequence"):
                clock += timedelta(seconds=60)
                ride.action_stop_arrived(by_driver=driver, stop_public_id=stop.public_id, occurred_at=clock)
                clock += timedelta(seconds=wait_seconds)
                ride.action_stop_departed(by_driver=driver, stop_public_id=stop.public_id, occurred_at=clock)
            ride.action_stop_unplanned(by_driver=driver, latitude=4.055, longitude=9.73, occurred_at=clock + timedelta(seconds=60))
        return counts["create"] + counts["write"]

    def test_stop_writes_do_not_depend_on_how_long_the_driver_waits(self):
        short = self._count_stop_writes(wait_seconds=30)
        long = self._count_stop_writes(wait_seconds=1500)
        self.assertEqual(short, long)
        # k = 2 arrêts prévus (arrivée + départ chacun) + 1 imprévu (une création) : 2k + 1.
        self.assertEqual(short, 5)

    # --- Critère 2 : cotation sans écriture sur la course, confirmation en une écriture --------

    def test_quoting_an_added_stop_does_not_touch_the_ride(self):
        ride, client, _driver = self._ride()
        before = (ride.estimated_amount, ride.reference_distance_km, ride.fare_rule_snapshot, ride.write_date)

        quote = ride.action_quote_added_stop(by_partner=client, latitude=4.055, longitude=9.73, label="Pharmacie")

        self.assertEqual((ride.estimated_amount, ride.reference_distance_km, ride.fare_rule_snapshot, ride.write_date), before)
        self.assertFalse(ride.stop_ids)
        self.assertEqual(quote.ride_id, ride)
        self.assertFalse(quote.confirmed_at)
        # Itinéraire prévu complet : prise en charge -> arrêt -> arrivée = 2 tronçons.
        self.assertEqual(quote.distance_meters, 2000)
        self.assertEqual(json.loads(quote.fare_rule_snapshot)["stop_fare"], 100.0)

    def test_confirming_updates_the_planned_price_and_keeps_the_quote(self):
        ride, client, driver = self._ride(stops=[(4.051, 9.71)])
        quote = ride.action_quote_added_stop(by_partner=client, latitude=4.055, longitude=9.73)

        stop = ride.action_confirm_added_stop(by_partner=client, quote=quote)

        self.assertEqual(ride.estimated_amount, quote.amount)
        self.assertEqual(ride.reference_distance_km, 3.0)
        self.assertEqual(ride.fare_rule_snapshot, quote.fare_rule_snapshot)
        self.assertTrue(stop.added_during_ride)
        self.assertEqual(stop.added_quote_id, quote)
        self.assertTrue(quote.confirmed_at)
        self.assertIn(quote, ride.stop_quote_ids)
        self.assertEqual(ride._babana_compute_final_amount(), quote.amount)

    def test_the_quote_routes_through_existing_stops_then_the_added_one(self):
        ride, client, _driver = self._ride(stops=[(4.051, 9.71)])
        ride.action_quote_added_stop(by_partner=client, latitude=4.055, longitude=9.73)
        points = self.route.call_args.kwargs["points"]
        self.assertEqual(points, [(4.05, 9.70), (4.051, 9.71), (4.055, 9.73), (4.06, 9.77)])

    def test_the_quote_uses_the_rides_own_fare_rule_not_todays(self):
        ride, client, _driver = self._ride()
        # Une règle plus prioritaire apparaît pendant la course : elle ne concerne pas celle-ci.
        self.env["babana.fare.rule"].create(
            {"name": "Nouvelle grille", "base_fare": 900.0, "price_per_km": 900.0, "minimum_fare": 300.0, "priority": 500}
        )
        quote = ride.action_quote_added_stop(by_partner=client, latitude=4.055, longitude=9.73)
        self.assertEqual(quote.fare_rule_id, self.rule)
        self.assertEqual(json.loads(quote.fare_rule_snapshot)["base_fare"], 200.0)

    def test_a_quote_made_before_another_confirmed_addition_is_expired(self):
        ride, client, _driver = self._ride()
        first = ride.action_quote_added_stop(by_partner=client, latitude=4.055, longitude=9.73)
        stale = ride.action_quote_added_stop(by_partner=client, latitude=4.057, longitude=9.74)
        ride.action_confirm_added_stop(by_partner=client, quote=first)
        with self.assertRaises(StopQuoteExpired):
            ride.action_confirm_added_stop(by_partner=client, quote=stale)

    def test_an_expired_quote_cannot_be_confirmed(self):
        ride, client, _driver = self._ride()
        quote = ride.action_quote_added_stop(by_partner=client, latitude=4.055, longitude=9.73)
        quote.write({"expires_at": fields.Datetime.now() - timedelta(seconds=1)})
        with self.assertRaises(StopQuoteExpired):
            ride.action_confirm_added_stop(by_partner=client, quote=quote)

    def test_adding_beyond_the_configured_maximum_is_refused(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.max_stops_per_ride", "1")
        ride, client, _driver = self._ride(stops=[(4.051, 9.71)])
        with self.assertRaises(TooManyStops):
            ride.action_quote_added_stop(by_partner=client, latitude=4.055, longitude=9.73)

    def test_only_the_rides_client_can_add_a_stop_and_only_during_the_ride(self):
        ride, _client, _driver = self._ride()
        stranger = self.env["res.partner"].create({"name": "Tiers"})
        with self.assertRaises(RideInvalidTransition):
            ride.action_quote_added_stop(by_partner=stranger, latitude=4.055, longitude=9.73)
        assigned, client, _driver = self._ride(state="assigned")
        with self.assertRaises(RideInvalidTransition):
            assigned.action_quote_added_stop(by_partner=client, latitude=4.055, longitude=9.73)

    def test_confirming_twice_adds_the_stop_once(self):
        ride, client, _driver = self._ride()
        quote = ride.action_quote_added_stop(by_partner=client, latitude=4.055, longitude=9.73)
        ride.action_confirm_added_stop(by_partner=client, quote=quote)
        ride.action_confirm_added_stop(by_partner=client, quote=quote)
        self.assertEqual(len(ride.stop_ids), 1)

    # --- Critère 3 : le chauffeur est prévenu au commit, jamais avant -------------------------

    def test_the_driver_is_notified_only_after_commit(self):
        ride, client, driver = self._ride()
        quote = ride.action_quote_added_stop(by_partner=client, latitude=4.055, longitude=9.73)
        with patch.object(realtime_client, "_notify_stop_added_now") as send:
            ride.action_confirm_added_stop(by_partner=client, quote=quote)
            send.assert_not_called()
            self.env.cr.postcommit.run()
        send.assert_called_once()
        self.assertEqual(send.call_args.kwargs["driver_public_id"], driver.public_id)
        self.assertEqual(len(send.call_args.kwargs["stops"]), 1)

    def test_a_rolled_back_addition_notifies_nobody(self):
        ride, client, _driver = self._ride()
        quote = ride.action_quote_added_stop(by_partner=client, latitude=4.055, longitude=9.73)
        with patch.object(realtime_client, "_notify_stop_added_now") as send:
            ride.action_confirm_added_stop(by_partner=client, quote=quote)
            # Ce que fait sql_db.Cursor.rollback : vider les rappels sans les exécuter.
            self.env.cr.postcommit.clear()
            self.env.cr.postcommit.run()
        send.assert_not_called()

    def test_the_driver_gets_a_push_and_the_client_none(self):
        ride, client, driver = self._ride()
        self.push.reset_mock()
        quote = ride.action_quote_added_stop(by_partner=client, latitude=4.055, longitude=9.73)
        ride.action_confirm_added_stop(by_partner=client, quote=quote)
        recipients = [call.args[1] for call in self.push.call_args_list]
        self.assertEqual(recipients, [driver.user_id])

    # --- Critère 4 : heure bornée, heure brute gardée -----------------------------------------

    def test_clamp_keeps_a_plausible_time_and_bounds_the_others(self):
        now = fields.Datetime.now()
        lower = now - timedelta(minutes=10)
        plausible = now - timedelta(minutes=3)
        self.assertEqual(clamp_event_time(plausible, lower=lower, received_at=now), plausible)
        self.assertEqual(clamp_event_time(now + timedelta(minutes=5), lower=lower, received_at=now), now)
        self.assertEqual(clamp_event_time(lower - timedelta(minutes=5), lower=lower, received_at=now), lower)
        self.assertEqual(clamp_event_time(None, lower=lower, received_at=now), now)

    def test_a_departure_before_the_arrival_is_brought_back_to_the_arrival(self):
        ride, _client, driver = self._ride(stops=[(4.051, 9.71)])
        self._past(ride, 600)
        stop = ride.stop_ids
        arrival = fields.Datetime.now() - timedelta(minutes=5)
        ride.action_stop_arrived(by_driver=driver, stop_public_id=stop.public_id, occurred_at=arrival)
        bogus = arrival - timedelta(minutes=2)
        ride.action_stop_departed(by_driver=driver, stop_public_id=stop.public_id, occurred_at=bogus)
        self.assertEqual(stop.departed_at, arrival)
        self.assertEqual(stop.departed_at_device, bogus)

    def test_an_arrival_in_the_future_is_brought_back_to_reception(self):
        ride, _client, driver = self._ride(stops=[(4.051, 9.71)])
        stop = ride.stop_ids
        future = fields.Datetime.now() + timedelta(hours=1)
        ride.action_stop_arrived(by_driver=driver, stop_public_id=stop.public_id, occurred_at=future)
        self.assertLessEqual(stop.arrived_at, fields.Datetime.now())
        self.assertEqual(stop.arrived_at_device, future)

    def test_an_offline_event_keeps_the_time_it_happened(self):
        ride, _client, driver = self._ride(stops=[(4.051, 9.71)])
        self._past(ride, 1800)
        stop = ride.stop_ids
        happened = fields.Datetime.now() - timedelta(minutes=12)
        ride.action_stop_arrived(by_driver=driver, stop_public_id=stop.public_id, occurred_at=happened)
        self.assertEqual(stop.arrived_at, happened)

    # --- Critère 5 : un rejeu n'écrit rien de plus --------------------------------------------

    def test_replayed_arrival_and_departure_do_not_move_the_times(self):
        ride, _client, driver = self._ride(stops=[(4.051, 9.71)])
        self._past(ride, 600)
        stop = ride.stop_ids
        ride.action_stop_arrived(by_driver=driver, stop_public_id=stop.public_id)
        ride.action_stop_departed(by_driver=driver, stop_public_id=stop.public_id)
        arrived, departed = stop.arrived_at, stop.departed_at
        later = fields.Datetime.now()
        ride.action_stop_arrived(by_driver=driver, stop_public_id=stop.public_id, occurred_at=later)
        ride.action_stop_departed(by_driver=driver, stop_public_id=stop.public_id, occurred_at=later)
        self.assertEqual((stop.arrived_at, stop.departed_at), (arrived, departed))

    # --- Critère 6 : séquences impossibles refusées --------------------------------------------

    def test_departure_from_a_stop_never_reached_is_refused(self):
        ride, _client, driver = self._ride(stops=[(4.051, 9.71)])
        with self.assertRaises(RideInvalidTransition):
            ride.action_stop_departed(by_driver=driver, stop_public_id=ride.stop_ids.public_id)

    def test_unknown_stop_is_refused(self):
        ride, _client, driver = self._ride()
        with self.assertRaises(StopNotFound):
            ride.action_stop_arrived(by_driver=driver, stop_public_id="pas-un-arret")

    def test_a_second_stop_cannot_open_while_one_is_open(self):
        ride, _client, driver = self._ride(stops=[(4.051, 9.71), (4.052, 9.72)])
        first, second = ride.stop_ids.sorted("sequence")
        ride.action_stop_arrived(by_driver=driver, stop_public_id=first.public_id)
        with self.assertRaises(RideInvalidTransition):
            ride.action_stop_arrived(by_driver=driver, stop_public_id=second.public_id)
        with self.assertRaises(RideInvalidTransition):
            ride.action_stop_unplanned(by_driver=driver, latitude=4.055, longitude=9.73)

    def test_stop_events_outside_the_ride_are_refused(self):
        ride, _client, driver = self._ride(stops=[(4.051, 9.71)], state="assigned")
        with self.assertRaises(RideInvalidTransition):
            ride.action_stop_arrived(by_driver=driver, stop_public_id=ride.stop_ids.public_id)
        with self.assertRaises(RideInvalidTransition):
            ride.action_stop_unplanned(by_driver=driver, latitude=4.055, longitude=9.73)

    def test_another_driver_cannot_declare_a_stop_event(self):
        ride, _client, _driver = self._ride(stops=[(4.051, 9.71)])
        other = self._make_driver()
        with self.assertRaises(RideInvalidTransition):
            ride.action_stop_arrived(by_driver=other, stop_public_id=ride.stop_ids.public_id)

    def test_pickup_departure_needs_arrival_and_happens_before_start(self):
        ride, _client, driver = self._ride(state="assigned")
        with self.assertRaises(RideInvalidTransition):
            ride.action_stop_departed(by_driver=driver)
        ride.action_mark_arrived(by_driver=driver)
        ride.action_stop_departed(by_driver=driver)
        self.assertTrue(ride.pickup_departed_at)
        self.assertGreaterEqual(ride.pickup_departed_at, ride.arrived_at)
        ride.action_start(by_driver=driver)
        with self.assertRaises(RideInvalidTransition):
            ride.action_stop_departed(by_driver=driver)

    def test_an_unplanned_stop_is_created_already_reached(self):
        ride, _client, driver = self._ride()
        stop = ride.action_stop_unplanned(by_driver=driver, latitude=4.055, longitude=9.73)
        self.assertEqual(stop.kind, "unplanned")
        self.assertTrue(stop.arrived_at)
        self.assertFalse(stop.departed_at)

    # --- Critère 7 : aucune attente n'est annoncée au client ----------------------------------

    def test_stop_events_send_nothing_to_anyone(self):
        ride, _client, driver = self._ride(stops=[(4.051, 9.71)])
        self.push.reset_mock()
        stop = ride.stop_ids
        with patch.object(realtime_client, "_post") as post:
            ride.action_stop_arrived(by_driver=driver, stop_public_id=stop.public_id)
            ride.action_stop_departed(by_driver=driver, stop_public_id=stop.public_id)
            ride.action_stop_unplanned(by_driver=driver, latitude=4.055, longitude=9.73)
            self.env.cr.postcommit.run()
        post.assert_not_called()
        self.push.assert_not_called()
