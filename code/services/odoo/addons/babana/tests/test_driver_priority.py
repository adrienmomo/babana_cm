# Priorité des chauffeurs à l'affectation (19 novembre, amoa/questions/PRIORITE-2026-11-19.md) :
# le score (services/priority.py), le compteur et le journal des points de course tenus par les
# transitions, la reconstitution depuis l'historique, le classement transmis à la réservation, les
# réglages, et ce que l'app lit (GET /me, journal, détail de la note).
from __future__ import annotations

from datetime import datetime, timedelta
from unittest.mock import patch

from odoo import fields
from odoo.exceptions import ValidationError
from odoo.tests.common import HttpCase, TransactionCase, tagged

from ..controllers.auth import _issue_access_token
from ..services import dispatch, priority, realtime_client

NOW = datetime(2026, 11, 19, 12, 0, 0)


class _PriorityFixtures:
    _plates = 0

    def _driver(self, name="Chauffeur", **vals):
        type(self)._plates += 1
        employee = self.env["hr.employee"].create({"name": f"{name} {self._plates}"})
        driver = self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved", **vals})
        motorcycle = self.env["babana.motorcycle"].create({"license_plate": f"PR-{5100 + self._plates}-IO"})
        motorcycle.write({"driver_id": driver.id})
        driver.invalidate_recordset()
        return driver

    def _client(self):
        type(self)._plates += 1
        return self.env["res.partner"].create({"name": f"Client {self._plates}"})

    def _ride(self, client, driver, *, until="completed"):
        ride = self.env["babana.ride"].action_request(
            {
                "client_id": client.id,
                "pickup_latitude": 4.0447, "pickup_longitude": 9.6996,
                "dropoff_latitude": 4.0622, "dropoff_longitude": 9.7108,
                "reference_distance_km": 4.2,
            }
        )
        ride.action_propose(by_partner=client, driver=driver)
        if until == "proposed":
            return ride
        ride.action_accept(by_driver=driver)
        ride.action_start(by_driver=driver)
        ride.action_complete(by_driver=driver, final_amount=700)
        if until == "settled":
            ride.action_settle(by_driver=driver, amount_collected=700)
        return ride

    def _param(self, name, value):
        self.env["ir.config_parameter"].sudo().set_param(name, value)


@tagged("post_install", "-at_install")
class TestPriorityScore(_PriorityFixtures, TransactionCase):
    def _score(self, driver, now=NOW):
        return priority.compute(driver, now=now)[driver.id]

    def test_a_driver_approved_today_has_the_maximum_of_120(self):
        driver = self._driver(approved_at=NOW - timedelta(hours=1))
        score = self._score(driver)
        self.assertEqual((score.ride_points, score.new_driver_points, score.star_points), (100, 10, 10))
        self.assertEqual(score.total, 120)
        self.assertEqual(score.max_total, 120)

    def test_the_new_driver_bonus_lasts_30_days_from_approval(self):
        driver = self._driver(approved_at=NOW - timedelta(days=29, hours=23))
        self.assertEqual(self._score(driver).new_driver_points, 10)
        self.assertEqual(self._score(driver).new_driver_until, NOW + timedelta(hours=1))
        driver.approved_at = NOW - timedelta(days=30)
        self.assertEqual(self._score(driver).new_driver_points, 0, "le 30e jour pile, la période est passée")
        self.assertEqual(self._score(driver).total, 110)

    def test_a_driver_never_approved_has_no_new_driver_bonus(self):
        self.assertEqual(self._score(self._driver()).new_driver_points, 0)

    def test_star_tiers_are_strictly_above_their_threshold(self):
        self.assertEqual(priority.star_points(self.env, 4.51), 10)
        self.assertEqual(priority.star_points(self.env, 4.5), 5, "4,5 pile : palier inférieur")
        self.assertEqual(priority.star_points(self.env, 4.01), 5)
        self.assertEqual(priority.star_points(self.env, 4.0), 0, "4 pile : aucun point")
        self.assertEqual(priority.star_points(self.env, 1.0), 0)

    def test_the_average_counts_50_imaginary_five_star_ratings(self):
        self.assertEqual(priority.smoothed_star_average(self.env, rating_sum=0, rating_count=0), 5.0)
        # Sept notes de 1 : (250 + 7) / 57 = 4,51 -- encore 10 points ; la huitième fait passer
        # sous 4,5.
        seven = priority.smoothed_star_average(self.env, rating_sum=7, rating_count=7)
        eight = priority.smoothed_star_average(self.env, rating_sum=8, rating_count=8)
        self.assertEqual(priority.star_points(self.env, seven), 10)
        self.assertEqual(priority.star_points(self.env, eight), 5)

    def test_real_client_ratings_decide_the_star_points(self):
        self._param(priority.STAR_PRIOR_COUNT_PARAM, "0")
        driver = self._driver()
        for rating in (4, 5):
            client = self._client()
            ride = self._ride(client, driver, until="settled")
            self.env["babana.rating"]._rate_ride(ride, client, rating)
        score = self._score(driver)
        self.assertEqual(score.star_average, 4.5)
        self.assertEqual(score.star_points, 5)

    def test_the_total_is_capped_by_the_setting(self):
        self._param(priority.MAX_TOTAL_PARAM, "115")
        driver = self._driver(approved_at=NOW)
        self.assertEqual(self._score(driver).total, 115)

    def test_every_number_is_a_setting(self):
        for name, value in (
            (priority.RIDE_POINTS_MAX_PARAM, "50"),
            (priority.NEW_DRIVER_POINTS_PARAM, "7"),
            (priority.NEW_DRIVER_DAYS_PARAM, "3"),
            (priority.STAR_HIGH_POINTS_PARAM, "4"),
            (priority.MAX_TOTAL_PARAM, "200"),
        ):
            self._param(name, value)
        driver = self._driver(approved_at=NOW - timedelta(days=2), ride_points=80)
        score = self._score(driver)
        self.assertEqual((score.ride_points, score.new_driver_points, score.star_points), (50, 7, 4))
        driver.approved_at = NOW - timedelta(days=4)
        self.assertEqual(self._score(driver).new_driver_points, 0)

    def test_an_absent_setting_falls_back_to_its_default(self):
        self._param(priority.MISS_PENALTY_PARAM, False)
        self._param(priority.NEW_DRIVER_POINTS_PARAM, "")
        self.assertEqual(priority.miss_penalty(self.env), 1)
        driver = self._driver(approved_at=NOW)
        self.assertEqual(self._score(driver).new_driver_points, 10)


@tagged("post_install", "-at_install")
class TestRidePoints(_PriorityFixtures, TransactionCase):
    def _movements(self, driver):
        return self.env["babana.driver.priority.movement"].search([("driver_id", "=", driver.id)], order="id")

    def test_a_new_driver_starts_at_the_maximum(self):
        self.assertEqual(self._driver().ride_points, 100)

    def test_an_expired_proposal_costs_one_point_and_is_logged(self):
        driver, client = self._driver(), self._client()
        ride = self._ride(client, driver, until="proposed")
        ride.action_reject(by_driver=None, expired=True)
        self.assertEqual(driver.ride_points, 99)
        movement = self._movements(driver)
        self.assertEqual(
            (movement.kind, movement.delta, movement.balance_after, movement.ride_id), ("missed", -1, 99, ride)
        )

    def test_a_refusal_counts_like_an_expiry(self):
        driver, client = self._driver(), self._client()
        ride = self._ride(client, driver, until="proposed")
        ride.action_reject(by_driver=driver, reason="driver_rejected")
        self.assertEqual(driver.ride_points, 99)

    def test_a_completed_ride_gives_a_point_back(self):
        driver, client = self._driver(ride_points=90), self._client()
        ride = self._ride(client, driver)
        self.assertEqual(driver.ride_points, 91)
        movement = self._movements(driver)
        self.assertEqual((movement.kind, movement.delta, movement.balance_after, movement.ride_id), ("completed", 1, 91, ride))

    def test_points_never_exceed_the_maximum_and_order_matters(self):
        # 100, cinq courses terminées, une expiration -> 99, jamais 100 (+5 -1 = +4, plafonné).
        driver = self._driver()
        for _ in range(5):
            self._ride(self._client(), driver)
        self.assertEqual(driver.ride_points, 100)
        self.assertEqual(self._movements(driver).mapped("balance_after"), [100] * 5)
        ride = self._ride(self._client(), driver, until="proposed")
        ride.action_reject(by_driver=None, expired=True)
        self.assertEqual(driver.ride_points, 99)

    def test_points_never_go_below_zero(self):
        driver = self._driver(ride_points=0)
        ride = self._ride(self._client(), driver, until="proposed")
        ride.action_reject(by_driver=None, expired=True)
        self.assertEqual(driver.ride_points, 0)
        self.assertEqual(self._movements(driver).balance_after, 0)

    def test_penalty_and_reward_are_settings(self):
        self._param(priority.MISS_PENALTY_PARAM, "3")
        self._param(priority.COMPLETION_REWARD_PARAM, "2")
        driver = self._driver(ride_points=50)
        self._ride(self._client(), driver)
        ride = self._ride(self._client(), driver, until="proposed")
        ride.action_reject(by_driver=None, expired=True)
        self.assertEqual(self._movements(driver).mapped("delta"), [2, -3])
        self.assertEqual(driver.ride_points, 49)

    def test_supervisors_and_managers_read_the_log_from_the_driver_record(self):
        driver = self._driver()
        self._ride(self._client(), driver)
        for group in ("babana.group_babana_supervisor", "babana.group_babana_manager"):
            user = self.env["res.users"].create(
                {"name": group, "login": f"{group}@example.invalid", "groups_id": [(6, 0, [self.env.ref(group).id])]}
            )
            self.assertEqual(driver.with_user(user).priority_movement_ids.mapped("kind"), ["completed"], group)

    def test_the_first_approval_starts_the_new_driver_period_and_a_reactivation_does_not(self):
        driver = self.env["babana.driver"].create({"employee_id": self.env["hr.employee"].create({"name": "Candidat"}).id})
        driver.motorcycle_id = self.env["babana.motorcycle"].create({"license_plate": "PR-9001-AP"})
        with patch.object(type(driver), "_required_documents_are_verified", return_value=True):
            driver.action_approve(employee_id=driver.employee_id.id)
        approved_at = driver.approved_at
        self.assertTrue(approved_at)
        driver.write({"state": "suspended", "rejection_reason": "test"})
        driver.action_reactivate()
        self.assertEqual(driver.approved_at, approved_at)

    def test_the_rebuild_replays_each_history_in_order_once(self):
        self._param(priority.RIDE_POINTS_REBUILT_PARAM, False)
        driver = self._driver()
        rides = [self._ride(self._client(), driver) for _ in range(3)]
        missed = self._ride(self._client(), driver, until="proposed")
        missed.action_reject(by_driver=None, expired=True)
        # L'historique dit : trois courses, puis une expiration -> 99. Le compteur a été faussé.
        base = fields.Datetime.now() - timedelta(days=10)
        for index, ride in enumerate(rides):
            ride.sudo().write({"completed_at": base + timedelta(days=index)})
        missed.rejection_ids.write({"rejected_at": base + timedelta(days=5)})
        driver.write({"ride_points": 12, "approved_at": False})
        self._movements(driver).unlink()

        self.env["babana.driver"]._babana_rebuild_ride_points_once()

        self.assertEqual(driver.ride_points, 99)
        self.assertEqual(self._movements(driver).mapped("delta"), [1, 1, 1, -1])
        self.assertEqual(driver.approved_at, driver.create_date, "approuvé sans date : sa date de création")
        driver.ride_points = 40
        self.env["babana.driver"]._babana_rebuild_ride_points_once()
        self.assertEqual(driver.ride_points, 40, "une seule fois par base")


@tagged("post_install", "-at_install")
class TestPriorityRanking(_PriorityFixtures, TransactionCase):
    def _candidate(self, driver, beeline, road=None):
        return priority.Candidate(driver.public_id, beeline, road)

    def test_within_2_km_the_highest_priority_wins_even_if_further(self):
        close, far_but_better = self._driver(ride_points=80), self._driver(ride_points=100)
        order = priority.rank_candidates(
            self.env, [self._candidate(close, 200, 250), self._candidate(far_but_better, 1500, 1900)]
        )
        self.assertEqual(order, [far_but_better.public_id, close.public_id])

    def test_equal_priority_goes_to_the_closest_by_road_then_by_beeline(self):
        a, b, c = self._driver(), self._driver(), self._driver()
        order = priority.rank_candidates(
            self.env,
            [self._candidate(a, 100, 900), self._candidate(b, 300, 400), self._candidate(c, 200)],
        )
        self.assertEqual(order, [b.public_id, a.public_id, c.public_id], "mesurés d'abord, puis à vol d'oiseau")

    def test_beyond_2_km_priority_no_longer_counts_and_comes_after(self):
        near_low = self._driver(ride_points=10)
        far_high, far_low_closer = self._driver(ride_points=100), self._driver(ride_points=10)
        order = priority.rank_candidates(
            self.env,
            [
                self._candidate(far_high, 3500, 4000),
                self._candidate(far_low_closer, 2500, 3000),
                self._candidate(near_low, 1999),
            ],
        )
        self.assertEqual(order, [near_low.public_id, far_low_closer.public_id, far_high.public_id])

    def test_exactly_2_km_is_outside_the_priority_zone(self):
        at_edge_high, inside_low = self._driver(ride_points=100), self._driver(ride_points=50)
        order = priority.rank_candidates(
            self.env, [self._candidate(at_edge_high, 2000), self._candidate(inside_low, 1900)]
        )
        self.assertEqual(order, [inside_low.public_id, at_edge_high.public_id])

    def test_the_priority_radius_is_a_setting(self):
        self._param(priority.PRIORITY_RADIUS_PARAM, "500")
        low_close, high_far = self._driver(ride_points=10), self._driver(ride_points=100)
        order = priority.rank_candidates(self.env, [self._candidate(low_close, 400), self._candidate(high_far, 600)])
        self.assertEqual(order, [low_close.public_id, high_far.public_id])

    def test_a_driver_unknown_to_odoo_is_left_to_the_beeline_fallback(self):
        known = self._driver()
        order = priority.rank_candidates(
            self.env, [priority.Candidate("inconnu", 50), self._candidate(known, 100)]
        )
        self.assertEqual(order, [known.public_id])

    def test_dispatch_hands_the_priority_order_to_the_reservation(self):
        close, better = self._driver(ride_points=70), self._driver(ride_points=100)
        nearby = [
            {"driverId": close.public_id, "latitude": 4.05, "longitude": 9.70, "distanceMeters": 150},
            {"driverId": better.public_id, "latitude": 4.06, "longitude": 9.70, "distanceMeters": 1200},
        ]
        client = self._client()
        self.env["res.users"].sudo().create({"name": "C", "login": f"prio-{client.id}@example.invalid", "partner_id": client.id})
        ride = self.env["babana.ride"].action_request(
            {"client_id": client.id, "pickup_latitude": 4.05, "pickup_longitude": 9.70,
             "dropoff_latitude": 4.06, "dropoff_longitude": 9.77}
        )
        with patch.object(realtime_client, "fetch_nearby_drivers", return_value=nearby) as fetch, \
                patch.object(realtime_client, "reserve_nearest_and_propose", return_value={"outcome": "PROPOSED", "driverId": better.public_id}) as reserve, \
                patch.object(realtime_client, "schedule_search_widening"), \
                patch("odoo.addons.babana.services.approach._road_route", return_value=None):
            driver, _widening = dispatch.propose_to_closest_driver(self.env, ride, by_partner=client)
        self.assertEqual(reserve.call_args.kwargs["preferred_driver_public_ids"], [better.public_id, close.public_id])
        self.assertEqual(fetch.call_args.kwargs["limit"], 50, "tout le cercle, pas les 5 plus proches")
        self.assertEqual(driver, better)


@tagged("post_install", "-at_install")
class TestPrioritySettings(TransactionCase):
    def test_the_priority_settings_are_editable_and_checked(self):
        settings = self.env["res.config.settings"].create(
            {"babana_priority_radius_meters": 1500, "babana_priority_new_driver_days": 45}
        )
        settings.execute()
        params = self.env["ir.config_parameter"].sudo()
        self.assertEqual(params.get_param(priority.PRIORITY_RADIUS_PARAM), "1500")
        self.assertEqual(params.get_param(priority.NEW_DRIVER_DAYS_PARAM), "45")
        with self.assertRaises(ValidationError):
            self.env["res.config.settings"].create({"babana_priority_miss_penalty": -1})
        with self.assertRaises(ValidationError):
            self.env["res.config.settings"].create({"babana_priority_radius_meters": 0})
        with self.assertRaises(ValidationError):
            self.env["res.config.settings"].create(
                {"babana_priority_star_high_threshold": 4.0, "babana_priority_star_mid_threshold": 4.0}
            )


@tagged("post_install", "-at_install")
class TestPriorityEndpoints(_PriorityFixtures, HttpCase):
    def _driver_user(self, sub):
        user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub=sub, email=f"{sub}@example.invalid", name="Chauffeur", role="driver"
        )
        driver = user._babana_driver()
        driver.write({"state": "approved", "employee_id": self.env["hr.employee"].create({"name": sub}).id})
        token, _ = _issue_access_token(user)
        return driver, token

    def _get(self, path, token):
        return self.url_open(path, headers={"Authorization": f"Bearer {token}"})

    def test_me_carries_the_priority_with_every_maximum(self):
        driver, token = self._driver_user("sub-prio-me")
        driver.write({"ride_points": 97, "approved_at": fields.Datetime.now() - timedelta(days=1)})
        body = self._get("/api/v1/me", token).json()
        priority_payload = body["driverPriority"]
        self.assertEqual(
            {key: priority_payload[key] for key in ("total", "max", "ridePoints", "ridePointsMax", "newDriverPoints",
                                                    "newDriverPointsMax", "starPoints", "starPointsMax")},
            {"total": 117, "max": 120, "ridePoints": 97, "ridePointsMax": 100, "newDriverPoints": 10,
             "newDriverPointsMax": 10, "starPoints": 10, "starPointsMax": 10},
        )
        self.assertTrue(priority_payload["newDriverUntil"].endswith("Z"))

    def test_after_the_new_driver_period_the_end_date_is_null(self):
        driver, token = self._driver_user("sub-prio-expired")
        driver.approved_at = fields.Datetime.now() - timedelta(days=40)
        payload = self._get("/api/v1/me", token).json()["driverPriority"]
        self.assertEqual((payload["newDriverPoints"], payload["newDriverUntil"]), (0, None))

    def test_a_client_has_no_priority(self):
        user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub="sub-prio-client", email="prio-client@example.invalid", name="Cliente", role="client"
        )
        token, _ = _issue_access_token(user)
        self.assertNotIn("driverPriority", self._get("/api/v1/me", token).json())

    def test_the_ride_points_log_is_paged_newest_first_and_never_shows_another_driver(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.ride_history_page_size", "2")
        driver, token = self._driver_user("sub-prio-log")
        other = self._driver()
        for _ in range(3):
            self._ride(self._client(), driver)
        missed = self._ride(self._client(), driver, until="proposed")
        missed.action_reject(by_driver=None, expired=True)
        self._ride(self._client(), other)

        first = self._get("/api/v1/drivers/me/priority/ride-points", token).json()
        self.assertEqual((first["ridePoints"], first["ridePointsMax"]), (99, 100))
        self.assertEqual([(e["kind"], e["delta"], e["balanceAfter"]) for e in first["entries"]],
                         [("missed", -1, 99), ("completed", 1, 100)])
        self.assertEqual(first["entries"][0]["rideReference"], missed.reference)
        second = self._get(f"/api/v1/drivers/me/priority/ride-points?cursor={first['nextCursor']}", token).json()
        self.assertEqual(len(second["entries"]), 2)
        self.assertIsNone(second["nextCursor"])
        self.assertEqual(self._get("/api/v1/drivers/me/priority/ride-points?cursor=999999999", token).status_code, 400)

    def test_the_star_detail_marks_only_the_tier_that_counts(self):
        _driver, token = self._driver_user("sub-prio-stars")
        body = self._get("/api/v1/drivers/me/priority/stars", token).json()
        self.assertEqual(
            body,
            {
                "starPoints": 10, "starPointsMax": 10, "smoothedAverage": 5.0, "ratingCount": 0,
                "ratingAverage": None, "priorCount": 50, "priorValue": 5.0,
                "tiers": [{"above": 4.5, "points": 10, "applied": True}, {"above": 4.0, "points": 5, "applied": False}],
            },
        )

    def test_the_priority_endpoints_require_a_driver(self):
        self.assertEqual(self.url_open("/api/v1/drivers/me/priority/stars").status_code, 401)
        self.assertEqual(self.url_open("/api/v1/drivers/me/priority/ride-points").status_code, 401)
