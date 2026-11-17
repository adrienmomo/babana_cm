# Prix final (L4-15, amoa/specs/L4-course.md). Module sensible (moteur de cotation) : tous les
# chemins de compute_final_fare sont couverts, puis l'intégration à la fin de course.
from __future__ import annotations

import json
from datetime import timedelta
from unittest.mock import patch

from odoo import fields
from odoo.exceptions import UserError
from odoo.tests.common import BaseCase, TransactionCase, tagged

from ..services import pricing, push, realtime_client, routing
from ..services.pricing import (
    FareRuleInput,
    FinalFareInputs,
    WaitParams,
    WaitPoint,
    billable_wait_minutes,
    compute_fare,
    compute_final_fare,
    round_breakdown_for_wire,
)

_RULE = FareRuleInput(base_fare=200.0, price_per_km=100.0, minimum_fare=300.0, stop_flat_fee=100.0)
_WAIT = WaitParams(rate_per_minute=30.0, pickup_free_minutes=3, stop_free_minutes=2, max_billable_minutes=15)


def _inputs(**overrides):
    values = dict(
        rule=_RULE,
        planned_distance_m=5000.0,
        actual_distance_m=5000.0,
        approach_distance_m=0.0,
        stop_count=0,
        wait_points=(),
        wait=_WAIT,
        band_min_ratio=0.6,
        band_max_ratio=1.0,
        rounding_step=25.0,
    )
    values.update(overrides)
    return FinalFareInputs(**values)


@tagged("post_install", "-at_install")
class TestBillableWaitMinutes(BaseCase):
    """Critère 3 : minutes complètes au-delà de la gratuité, plafonnées."""

    def test_pickup_wait_of_exactly_three_minutes_is_free(self):
        self.assertEqual(billable_wait_minutes(180, free_minutes=3, cap_minutes=15), 0)

    def test_pickup_wait_of_six_minutes_fifty_nine_bills_three(self):
        self.assertEqual(billable_wait_minutes(6 * 60 + 59, free_minutes=3, cap_minutes=15), 3)

    def test_billing_starts_at_the_fourth_minute(self):
        self.assertEqual(billable_wait_minutes(3 * 60 + 59, free_minutes=3, cap_minutes=15), 0)
        self.assertEqual(billable_wait_minutes(4 * 60, free_minutes=3, cap_minutes=15), 1)

    def test_forty_minutes_hits_the_cap(self):
        self.assertEqual(billable_wait_minutes(40 * 60, free_minutes=3, cap_minutes=15), 15)

    def test_stop_wait_of_two_minutes_fifty_nine_is_free(self):
        self.assertEqual(billable_wait_minutes(2 * 60 + 59, free_minutes=2, cap_minutes=15), 0)

    def test_negative_or_zero_wait_is_free(self):
        self.assertEqual(billable_wait_minutes(-30, free_minutes=0, cap_minutes=15), 0)
        self.assertEqual(billable_wait_minutes(0, free_minutes=0, cap_minutes=15), 0)


@tagged("post_install", "-at_install")
class TestComputeFinalFare(BaseCase):
    def _planned_total(self, **kw):
        return compute_fare(_RULE, 5000.0, rounding_step=25.0, **kw).total

    # --- Critère 1 : bande de distance, bornes exactes et de part et d'autre ------------------

    def test_band_lower_bound_exactly_keeps_the_planned_price(self):
        final = compute_final_fare(_inputs(actual_distance_m=3000.0))  # 60 %
        self.assertEqual(final.distance_source, pricing.DISTANCE_PLANNED)
        self.assertEqual(final.breakdown.total, self._planned_total())

    def test_band_upper_bound_exactly_keeps_the_planned_price(self):
        final = compute_final_fare(_inputs(actual_distance_m=5000.0))  # 100 %
        self.assertEqual(final.distance_source, pricing.DISTANCE_PLANNED)

    def test_just_inside_both_bounds_keeps_the_planned_price(self):
        for actual in (3001.0, 4999.0):
            with self.subTest(actual=actual):
                final = compute_final_fare(_inputs(actual_distance_m=actual))
                self.assertEqual(final.billed_distance_m, 5000.0)

    def test_just_below_the_band_bills_the_measured_distance(self):
        final = compute_final_fare(_inputs(actual_distance_m=2999.0))
        self.assertEqual(final.distance_source, pricing.DISTANCE_MEASURED)
        self.assertEqual(final.billed_distance_m, 2999.0)
        self.assertEqual(final.breakdown.total, compute_fare(_RULE, 2999.0, rounding_step=25.0).total)

    def test_just_above_the_band_bills_the_measured_distance(self):
        final = compute_final_fare(_inputs(actual_distance_m=5001.0))
        self.assertEqual(final.distance_source, pricing.DISTANCE_MEASURED)
        self.assertEqual(final.billed_distance_m, 5001.0)

    def test_band_ratio_is_reported(self):
        self.assertAlmostEqual(compute_final_fare(_inputs(actual_distance_m=4000.0)).band_ratio, 0.8)

    # --- Critère 4 : distance absente -> prix prévu -------------------------------------------

    def test_unmeasured_trip_bills_the_planned_distance_and_says_so(self):
        final = compute_final_fare(_inputs(actual_distance_m=None))
        self.assertEqual(final.distance_source, pricing.DISTANCE_UNMEASURED)
        self.assertEqual(final.breakdown.total, self._planned_total())
        self.assertIsNone(final.band_ratio)

    def test_zero_planned_distance_never_divides(self):
        final = compute_final_fare(_inputs(planned_distance_m=0.0, actual_distance_m=1200.0))
        self.assertEqual(final.distance_source, pricing.DISTANCE_PLANNED)

    # --- Approche et forfaits ne dépendent pas de la bande ------------------------------------

    def test_approach_and_stop_fees_are_kept_out_of_band(self):
        rule = FareRuleInput(
            base_fare=200.0, price_per_km=100.0, minimum_fare=300.0, approach_price_per_km=50.0,
            stop_flat_fee=100.0,
        )
        final = compute_final_fare(
            _inputs(rule=rule, actual_distance_m=9000.0, approach_distance_m=1000.0, stop_count=2)
        )
        self.assertEqual(final.breakdown.approach_fare, 50.0)
        self.assertEqual(final.breakdown.stop_fare, 200.0)
        self.assertEqual(final.breakdown.distance_fare, 900.0)

    # --- Attente ---------------------------------------------------------------------------------

    def test_wait_is_billed_per_point_with_its_own_free_minutes(self):
        final = compute_final_fare(
            _inputs(
                wait_points=(
                    WaitPoint("pickup", "pickup", 6 * 60 + 59),  # 3
                    WaitPoint("s1", "stop", 5 * 60),  # 3
                    WaitPoint("s2", "stop", 2 * 60 + 59),  # 0
                )
            )
        )
        self.assertEqual(final.wait_minutes, (("pickup", 3), ("s1", 3), ("s2", 0)))
        self.assertEqual(final.breakdown.wait_fare, 180.0)

    def test_no_wait_and_in_band_is_the_quote_to_the_franc(self):
        final = compute_final_fare(_inputs(stop_count=1, approach_distance_m=800.0))
        expected = compute_fare(_RULE, 5000.0, rounding_step=25.0, stop_count=1, approach_distance_m=800.0)
        self.assertEqual(final.breakdown.total, expected.total)
        self.assertEqual(final.breakdown.wait_fare, 0.0)

    def test_wait_is_added_after_the_floor(self):
        # Course très courte : le plancher (300) s'applique au trajet, l'attente s'y ajoute.
        final = compute_final_fare(
            _inputs(planned_distance_m=100.0, actual_distance_m=100.0,
                    wait_points=(WaitPoint("pickup", "pickup", 5 * 60),))
        )
        self.assertTrue(final.breakdown.minimum_fare_applied)
        self.assertEqual(final.breakdown.total, 300.0 + 2 * 30.0 + 15.0)  # arrondi 360 -> 375

    def test_total_is_rounded_once_and_the_breakdown_still_sums(self):
        final = compute_final_fare(_inputs(actual_distance_m=4321.0, wait_points=(WaitPoint("pickup", "pickup", 4 * 60),)))
        self.assertEqual(final.breakdown.total % 25, 0)
        self.assertTrue(final.breakdown.sum_matches_total())
        wire = round_breakdown_for_wire(final.breakdown)
        self.assertEqual(wire["waitFare"], 30)
        total = sum(wire[k] for k in ("baseFare", "approachFare", "distanceFare", "surgeAmount", "stopFare", "waitFare", "floorAmount", "roundingAmount")) - wire["discountAmount"]
        self.assertEqual(total, round(final.breakdown.total))

    def test_same_inputs_same_result(self):
        inputs = _inputs(actual_distance_m=2000.0, wait_points=(WaitPoint("pickup", "pickup", 600),))
        self.assertEqual(compute_final_fare(inputs), compute_final_fare(inputs))


@tagged("post_install", "-at_install")
class TestFinalFareAtCompletion(TransactionCase):
    """Intégration : le prix final est calculé et écrit une fois, par la transition de fin."""

    def setUp(self):
        super().setUp()
        for name in ("notify_ride_started", "notify_driver_arrived", "notify_ride_completed"):
            patcher = patch.object(realtime_client, name)
            setattr(self, name, patcher.start())
            self.addCleanup(patcher.stop)
        patcher = patch.object(push, "notify_users_async")
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.object(
            routing, "get_reference_route_through",
            side_effect=lambda env, *, points, vehicle_class, at_datetime: routing.RouteResult(
                1000 * (len(points) - 1), 240, ""
            ),
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        self.rule = self.env["babana.fare.rule"].create(
            {
                "name": "Grille prix final",
                "base_fare": 200.0,
                "price_per_km": 100.0,
                "approach_price_per_km": 0.0,
                "minimum_fare": 300.0,
                "stop_flat_fee": 100.0,
                "wait_rate_per_minute": 30.0,
                "priority": 99,
            }
        )

    def _ride(self, *, planned_km=5.0, stops=()):
        client = self.env["res.partner"].create({"name": "Client prix final"})
        self.env["res.users"].sudo().create(
            {"name": "Client prix final", "login": f"final-{client.id}@example.invalid", "partner_id": client.id}
        )
        employee = self.env["hr.employee"].create({"name": "Chauffeur prix final"})
        driver = self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})
        planned = compute_fare(self.rule._pricing_input(), planned_km * 1000, rounding_step=25.0, stop_count=len(stops))
        ride = self.env["babana.ride"].action_request(
            {
                "client_id": client.id,
                "pickup_latitude": 4.05,
                "pickup_longitude": 9.70,
                "dropoff_latitude": 4.06,
                "dropoff_longitude": 9.77,
                "fare_rule_id": self.rule.id,
                "estimated_amount": planned.total,
                "reference_distance_km": planned_km,
                "fare_rule_snapshot": json.dumps(planned.__dict__),
                "stop_wait_snapshot": json.dumps({**self.rule._stop_wait_snapshot(), "rounding_step": 25.0}),
                "stop_ids": [
                    (0, 0, {"sequence": i, "latitude": 4.051, "longitude": 9.71 + i / 100, "kind": "planned"})
                    for i in range(1, len(stops) + 1)
                ],
            }
        )
        ride.action_propose(by_partner=client, driver=driver)
        ride.action_accept(by_driver=driver)
        return ride, client, driver

    def _set_times(self, ride, **values):
        ride.with_context(babana_allow_state_write=True).write(values)

    def _measurement(self, km):
        return {"distance_meters": round(km * 1000), "duration_seconds": 900, "polyline": "abc"}

    def test_without_wait_and_in_band_the_final_price_is_the_estimate(self):
        ride, _client, driver = self._ride()
        ride.action_start(by_driver=driver)
        ride.action_complete(by_driver=driver, measurement=self._measurement(4.5))
        self.assertEqual(ride.final_amount, ride.estimated_amount)
        self.assertEqual(ride.fare_distance_source, pricing.DISTANCE_PLANNED)
        self.assertFalse(ride.fare_needs_review)

    def test_pickup_and_stop_waits_are_billed_from_stored_times(self):
        ride, _client, driver = self._ride(stops=[1])
        ride.action_mark_arrived(by_driver=driver)
        ride.action_start(by_driver=driver)
        stop = ride.stop_ids
        ride.action_stop_arrived(by_driver=driver, stop_public_id=stop.public_id)
        ride.action_stop_departed(by_driver=driver, stop_public_id=stop.public_id)
        now = fields.Datetime.now()
        self._set_times(ride, arrived_at=now - timedelta(minutes=40), started_at=now - timedelta(minutes=33, seconds=1))
        stop.write({"arrived_at": now - timedelta(minutes=20), "departed_at": now - timedelta(minutes=14, seconds=30)})

        ride.action_complete(by_driver=driver, measurement=self._measurement(5.0))

        # Prise en charge 6 min 59 -> 3 ; arrêt 5 min 30 -> 3 : 6 × 30 = 180.
        self.assertEqual(ride.wait_fare_amount, 180.0)
        self.assertEqual(json.loads(ride.final_fare_snapshot)["wait_minutes"], [["pickup", 3], [stop.public_id, 3]])
        # Prévu 800 (200 + 5 km × 100 + 1 arrêt × 100) + attente 180 = 980, arrondi au pas de 25
        # sur le total -> 1 000.
        self.assertEqual(ride.estimated_amount, 800.0)
        self.assertEqual(ride.final_amount, 1000.0)

    def test_pickup_wait_stops_at_the_first_movement(self):
        ride, _client, driver = self._ride()
        ride.action_mark_arrived(by_driver=driver)
        ride.action_stop_departed(by_driver=driver)
        ride.action_start(by_driver=driver)
        now = fields.Datetime.now()
        self._set_times(
            ride,
            arrived_at=now - timedelta(minutes=30),
            pickup_departed_at=now - timedelta(minutes=26),  # 4 min -> 1
            started_at=now - timedelta(minutes=20),
        )
        ride.action_complete(by_driver=driver, measurement=self._measurement(5.0))
        self.assertEqual(ride.wait_fare_amount, 30.0)

    def test_a_stop_never_left_counts_until_completion(self):
        ride, _client, driver = self._ride()
        ride.action_start(by_driver=driver)
        stop = ride.action_stop_unplanned(by_driver=driver, latitude=4.055, longitude=9.73)
        stop.write({"arrived_at": fields.Datetime.now() - timedelta(minutes=7)})  # 7 - 2 = 5
        ride.action_complete(by_driver=driver, measurement=self._measurement(5.0))
        self.assertEqual(ride.wait_fare_amount, 150.0)

    def test_out_of_band_bills_the_measured_distance(self):
        ride, _client, driver = self._ride(planned_km=5.0)
        ride.action_start(by_driver=driver)
        ride.action_complete(by_driver=driver, measurement=self._measurement(8.0))
        self.assertEqual(ride.fare_distance_source, pricing.DISTANCE_MEASURED)
        self.assertEqual(ride.final_amount, compute_fare(self.rule._pricing_input(), 8000, rounding_step=25.0).total)

    # --- Critère 2 : hors bande, les paramètres gelés, jamais la grille du jour ---------------

    def test_out_of_band_uses_frozen_values_even_after_a_new_version(self):
        ride, _client, driver = self._ride(planned_km=5.0)
        ride.action_start(by_driver=driver)
        self.rule.new_version({"price_per_km": 900.0, "wait_rate_per_minute": 300.0})
        ride.action_complete(by_driver=driver, measurement=self._measurement(8.0))
        self.assertEqual(ride.final_amount, compute_fare(self.rule._pricing_input(), 8000, rounding_step=25.0).total)
        self.assertEqual(self.rule.price_per_km, 100.0)

    def test_changing_the_rounding_setting_does_not_change_a_frozen_ride(self):
        ride, _client, driver = self._ride()
        ride.action_start(by_driver=driver)
        self.env["ir.config_parameter"].sudo().set_param("babana.fare_rounding_step", "500")
        ride.action_complete(by_driver=driver, measurement=self._measurement(5.0))
        self.assertEqual(ride.final_amount, ride.estimated_amount)

    # --- Critère 4 : distance absente -> prix prévu, course signalée --------------------------

    def test_unmeasured_trip_bills_the_planned_price_and_is_flagged(self):
        ride, _client, driver = self._ride()
        ride.action_start(by_driver=driver)
        ride.action_complete(by_driver=driver, measurement=None)
        self.assertEqual(ride.final_amount, ride.estimated_amount)
        self.assertTrue(ride.fare_needs_review)
        self.assertIn(ride, self.env["babana.ride"].search([("fare_needs_review", "=", True)]))

    # --- Critère 5 : calculé et écrit une seule fois, dans la transition ----------------------

    def test_the_final_price_is_written_with_the_transition_in_one_write(self):
        ride, _client, driver = self._ride()
        ride.action_start(by_driver=driver)
        ride_model = type(self.env["babana.ride"])
        original = ride_model.write
        writes = []

        def counting(model, vals):
            if model._name == "babana.ride" and model.ids == ride.ids:
                writes.append(set(vals))
            return original(model, vals)

        with patch.object(ride_model, "write", counting):
            ride.action_complete(by_driver=driver, measurement=self._measurement(5.0))
        priced = [keys for keys in writes if "final_amount" in keys]
        self.assertEqual(len(priced), 1)
        self.assertIn("state", priced[0])
        self.assertIn("final_fare_snapshot", priced[0])

    def test_a_caller_cannot_impose_another_amount(self):
        ride, _client, driver = self._ride()
        ride.action_start(by_driver=driver)
        with self.assertRaises(UserError):
            ride.action_complete(by_driver=driver, final_amount=ride.estimated_amount + 500, measurement=None)

    # --- Critère 6 (partie modèle) : le détail montré est le détail facturé -------------------

    def test_completed_message_and_billed_breakdown_carry_the_wait(self):
        ride, _client, driver = self._ride()
        ride.action_mark_arrived(by_driver=driver)
        ride.action_start(by_driver=driver)
        now = fields.Datetime.now()
        self._set_times(ride, arrived_at=now - timedelta(minutes=20), started_at=now - timedelta(minutes=15))  # 5 -> 2
        ride.action_complete(by_driver=driver, measurement=self._measurement(5.0))
        breakdown = self.notify_ride_completed.call_args.kwargs["breakdown"]
        self.assertEqual(breakdown["waitFare"], 60)
        self.assertEqual(self.notify_ride_completed.call_args.kwargs["amount"], round(ride.final_amount))
        self.assertEqual(ride._babana_billed_breakdown().wait_fare, 60.0)

    # --- Critère 7 : le plafond d'encaisse voit le montant final, attente comprise ------------

    def test_settlement_and_cash_movement_use_the_final_amount(self):
        ride, _client, driver = self._ride()
        ride.action_mark_arrived(by_driver=driver)
        ride.action_start(by_driver=driver)
        now = fields.Datetime.now()
        self._set_times(ride, arrived_at=now - timedelta(minutes=20), started_at=now - timedelta(minutes=15))
        ride.action_complete(by_driver=driver, measurement=self._measurement(5.0))
        self.assertGreater(ride.final_amount, ride.estimated_amount)
        with self.assertRaises(UserError):
            ride.action_settle(by_driver=driver, amount_collected=ride.estimated_amount)
        ride.action_settle(by_driver=driver, amount_collected=ride.final_amount)
        movement = self.env["babana.cash.movement"].search([("ride_id", "=", ride.id)])
        self.assertEqual(abs(movement.amount), ride.final_amount)

    # --- Critère 9 : rejeu depuis les seuls champs stockés -----------------------------------

    def test_replay_after_grid_change_and_cache_flush_gives_the_same_price_line_by_line(self):
        ride, client, driver = self._ride(stops=[1])
        ride.action_mark_arrived(by_driver=driver)
        ride.action_start(by_driver=driver)
        quote = ride.action_quote_added_stop(by_partner=client, latitude=4.055, longitude=9.73)
        ride.action_confirm_added_stop(by_partner=client, quote=quote)
        first, second = ride.stop_ids.sorted("sequence")
        now = fields.Datetime.now()
        self._set_times(ride, arrived_at=now - timedelta(minutes=50), started_at=now - timedelta(minutes=44))
        first.write({"arrived_at": now - timedelta(minutes=30), "departed_at": now - timedelta(minutes=25)})
        second.write({"arrived_at": now - timedelta(minutes=15), "departed_at": now - timedelta(minutes=9)})
        ride.action_complete(by_driver=driver, measurement=self._measurement(1.0))  # hors bande
        stored = json.loads(ride.final_fare_snapshot)

        self.rule.new_version({"price_per_km": 1000.0, "stop_flat_fee": 999.0, "wait_rate_per_minute": 999.0})
        self.env["ir.config_parameter"].sudo().set_param("babana.fare_rounding_step", "500")
        self.env["babana.route.cache"].sudo().search([]).unlink()
        with patch.object(routing, "get_reference_route_through", side_effect=AssertionError("pas de routage au rejeu")):
            replayed = ride._babana_replay_final_fare()

        self.assertEqual(replayed.breakdown.total, ride.final_amount)
        self.assertEqual(
            {k: round(v) for k, v in replayed.breakdown.__dict__.items() if isinstance(v, float)},
            {k: round(v) for k, v in stored["breakdown"].items() if isinstance(v, float)},
        )
        self.assertEqual([list(item) for item in replayed.wait_minutes], stored["wait_minutes"])
