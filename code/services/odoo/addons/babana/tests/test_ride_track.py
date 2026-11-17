# Enregistrement du trajet pour la sécurité (L4-16, amoa/specs/L4-course.md). Un test au moins
# par critère d'acceptation, dans l'ordre.
from __future__ import annotations

import json
from datetime import datetime, timedelta
from unittest.mock import patch

from odoo import fields
from odoo.exceptions import AccessError
from odoo.tests.common import BaseCase, HttpCase, TransactionCase, tagged

from ..models.babana_ride_track import filter_phone_points
from ..services import push, realtime_client
from . import test_ride_controller as controller_tests


def _iso(value: datetime) -> str:
    return value.replace(microsecond=0).isoformat() + "Z"


def _measurement(points, km=3.0):
    return {"distance_meters": round(km * 1000), "duration_seconds": 900, "polyline": "abc", "points": points}


@tagged("post_install", "-at_install")
class TestPhonePointFilter(BaseCase):
    """La trace du téléphone vient d'un appareil qu'on ne contrôle pas (Piège de L4-16)."""

    START = datetime(2026, 11, 17, 7, 0, 0)

    def _point(self, seconds, lat=4.05, lng=9.70, **extra):
        return {"latitude": lat, "longitude": lng, "capturedAt": _iso(self.START + timedelta(seconds=seconds)),
                "accuracyMeters": 5, **extra}

    def _filter(self, points, max_points=5000):
        return filter_phone_points(
            points, window_start=self.START, window_end=self.START + timedelta(minutes=30),
            max_speed_mps=38.9, max_points=max_points,
        )

    def test_points_are_kept_in_time_order(self):
        kept = self._filter([self._point(60, lng=9.701), self._point(0)])
        self.assertEqual([round(p[2], 3) for p in kept], [9.70, 9.701])

    def test_points_outside_the_ride_window_are_dropped(self):
        kept = self._filter([self._point(-600), self._point(10), self._point(3600)])
        self.assertEqual(len(kept), 1)

    def test_an_impossible_jump_is_dropped(self):
        # 1 km en 5 s = 200 m/s, bien au-delà du plafond de plausibilité.
        kept = self._filter([self._point(0), self._point(5, lat=4.059), self._point(120, lat=4.051)])
        self.assertEqual(len(kept), 2)
        self.assertAlmostEqual(kept[1][1], 4.051)

    def test_untimed_or_malformed_points_are_dropped(self):
        kept = self._filter([{"latitude": 4.05, "longitude": 9.7}, {"capturedAt": "x"}, self._point(1), "bad"])
        self.assertEqual(len(kept), 1)

    def test_the_point_count_is_capped(self):
        kept = self._filter([self._point(i, lng=9.70 + i * 0.00001) for i in range(50)], max_points=10)
        self.assertEqual(len(kept), 10)


@tagged("post_install", "-at_install")
class TestRideTrack(TransactionCase):
    def setUp(self):
        super().setUp()
        for name in ("notify_driver_arrived", "notify_ride_completed"):
            patcher = patch.object(realtime_client, name)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(realtime_client, "notify_ride_started")
        self.notify_started = patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.object(push, "notify_users_async")
        self.push = patcher.start()
        self.addCleanup(patcher.stop)

    def _ride(self, *, start=True):
        client = self.env["res.partner"].create({"name": "Client trajet"})
        self.client_user = self.env["res.users"].sudo().create(
            {"name": "Client trajet", "login": f"track-{client.id}@example.invalid", "partner_id": client.id}
        )
        employee = self.env["hr.employee"].create({"name": "Chauffeur trajet"})
        driver = self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})
        ride = self.env["babana.ride"].action_request(
            {"client_id": client.id, "pickup_latitude": 4.05, "pickup_longitude": 9.70,
             "dropoff_latitude": 4.06, "dropoff_longitude": 9.77}
        )
        ride.action_propose(by_partner=client, driver=driver)
        ride.action_accept(by_driver=driver)
        if start:
            ride.action_start(by_driver=driver)
        return ride, driver

    def _realtime_points(self, count):
        base = fields.Datetime.now() - timedelta(minutes=20)
        return [
            {"latitude": 4.05 + i * 0.0005, "longitude": 9.70 + i * 0.0005,
             "capturedAt": _iso(base + timedelta(seconds=30 * i)), "accuracyMeters": 6}
            for i in range(count)
        ]

    # --- Critère 1 : course normale, trace horodatée, une écriture, source temps réel --------

    def test_completion_records_the_timed_track_from_realtime(self):
        ride, driver = self._ride()
        ride.action_complete(by_driver=driver, final_amount=1000, measurement=_measurement(self._realtime_points(5)))
        track = ride._babana_track()
        self.assertEqual(track.source, "realtime")
        self.assertEqual(track.point_count, 5)
        self.assertTrue(all(point["t"] for point in track._points()))
        self.assertTrue(track.first_point_at < track.last_point_at)
        self.assertTrue(ride.has_security_track)

    def test_a_measurement_without_points_records_nothing(self):
        ride, driver = self._ride()
        ride.action_complete(by_driver=driver, final_amount=1000, measurement=_measurement([]))
        self.assertFalse(ride._babana_track())

    # --- Critère 2 : le temps réel n'a rien -- la copie du téléphone est retenue --------------

    def test_the_phone_copy_is_kept_when_realtime_left_nothing(self):
        ride, driver = self._ride()
        ride.with_context(babana_allow_state_write=True).write(
            {"started_at": fields.Datetime.now() - timedelta(minutes=25)}
        )
        ride.action_complete(by_driver=driver, final_amount=1000, measurement=None)
        track = ride._babana_store_phone_track(self._realtime_points(4))
        self.assertEqual(track.source, "phone")
        self.assertEqual(track.point_count, 4)

    def test_the_phone_copy_never_replaces_a_realtime_track(self):
        ride, driver = self._ride()
        ride.action_complete(by_driver=driver, final_amount=1000, measurement=_measurement(self._realtime_points(3)))
        track = ride._babana_store_phone_track(self._realtime_points(8))
        self.assertEqual(track.source, "realtime")
        self.assertEqual(track.point_count, 3)

    def test_the_phone_copy_does_not_change_the_price(self):
        ride, driver = self._ride()
        ride.action_complete(by_driver=driver, final_amount=1000, measurement=None)
        ride._babana_store_phone_track(self._realtime_points(4))
        self.assertEqual(ride.final_amount, 1000)
        self.assertFalse(ride.trip_measured)

    # --- Critère 3 : téléversée hors connexion puis rejouée -- une seule fois ----------------

    def test_a_replayed_upload_writes_nothing_more(self):
        ride, driver = self._ride()
        ride.with_context(babana_allow_state_write=True).write(
            {"started_at": fields.Datetime.now() - timedelta(minutes=25)}
        )
        ride.action_complete(by_driver=driver, final_amount=1000, measurement=None)
        first = ride._babana_store_phone_track(self._realtime_points(4))
        second = ride._babana_store_phone_track(self._realtime_points(6))
        self.assertEqual(first, second)
        self.assertEqual(self.env["babana.ride.track"].sudo().search_count([("ride_id", "=", ride.id)]), 1)

    # --- Critère 4 : aucune écriture de trace pendant le trajet, quelle que soit sa durée ----

    def test_one_track_write_whatever_the_number_of_points(self):
        track_model = type(self.env["babana.ride.track"])
        original = track_model.create
        calls = []

        def counting(model, vals_list):
            calls.append(1)
            return original(model, vals_list)

        with patch.object(track_model, "create", counting):
            for count in (3, 900):
                ride, driver = self._ride()
                ride.action_complete(by_driver=driver, final_amount=1000, measurement=_measurement(self._realtime_points(count)))
        self.assertEqual(len(calls), 2)

    # --- Critère 5 : conservation ---------------------------------------------------------------

    def _completed_with_track(self, days_ago):
        ride, driver = self._ride()
        ride.action_complete(by_driver=driver, final_amount=1000, measurement=_measurement(self._realtime_points(2)))
        ride.with_context(babana_allow_state_write=True).write(
            {"completed_at": fields.Datetime.now() - timedelta(days=days_ago)}
        )
        return ride

    def test_retention_removes_old_tracks_and_keeps_the_ride(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.ride_track_retention_days", "365")
        old = self._completed_with_track(366)
        recent = self._completed_with_track(364)
        self.env["babana.ride.track"]._cron_purge_expired_tracks()
        self.assertFalse(old._babana_track())
        self.assertTrue(old.exists())
        self.assertEqual(old.final_amount, 1000)
        self.assertTrue(recent._babana_track())

    def test_retention_keeps_a_track_while_an_incident_is_open(self):
        old = self._completed_with_track(400)
        incident = self.env["babana.incident"].sudo().create(
            {"ride_id": old.id, "trigger_actor": "client", "trigger_user_id": self.client_user.id,
             "latitude": 4.05, "longitude": 9.70, "triggered_at": fields.Datetime.now()}
        )
        self.env["babana.ride.track"]._cron_purge_expired_tracks()
        self.assertTrue(old._babana_track())
        incident.sudo().write({"status": "closed"})
        self.env["babana.ride.track"]._cron_purge_expired_tracks()
        self.assertFalse(old._babana_track())

    # --- Critère 6 : accès réservé, chaque lecture journalisée ---------------------------------

    def _backoffice_user(self, group):
        return self.env["res.users"].sudo().create(
            {"name": f"BO {group}", "login": f"bo-{group}-{self.env.cr.now().timestamp()}@example.invalid",
             "groups_id": [(6, 0, [self.env.ref("base.group_user").id, self.env.ref(group).id])]}
        )

    def test_a_supervisor_replays_and_each_opening_is_audited(self):
        ride = self._completed_with_track(1)
        supervisor = self._backoffice_user("babana.group_babana_supervisor")
        before = self.env["babana.audit.log"].sudo().search_count([("event", "=", "ride.track_viewed")])
        action = ride.with_user(supervisor).action_open_track_replay()
        ride.with_user(supervisor).action_open_track_replay()
        after = self.env["babana.audit.log"].sudo().search_count([("event", "=", "ride.track_viewed")])
        self.assertEqual(after - before, 2)
        wizard = self.env["babana.ride.track.replay"].with_user(supervisor).browse(action["res_id"])
        self.assertIn("Points horodatés (2)", wizard.replay_html)
        self.assertIn("Démarrage de la course", wizard.replay_html)
        self.assertIn("<svg", wizard.replay_html)

    def test_a_supervisor_cannot_read_the_raw_track(self):
        ride = self._completed_with_track(1)
        supervisor = self._backoffice_user("babana.group_babana_supervisor")
        with self.assertRaises(AccessError):
            self.env["babana.ride.track"].with_user(supervisor).search([("ride_id", "=", ride.id)]).read(["points_json"])

    def test_a_user_without_the_supervisor_group_cannot_replay(self):
        ride = self._completed_with_track(1)
        plain = self.env["res.users"].sudo().create(
            {"name": "Sans droit", "login": "no-replay@example.invalid",
             "groups_id": [(6, 0, [self.env.ref("base.group_user").id])]}
        )
        with self.assertRaises(AccessError):
            ride.with_user(plain).action_open_track_replay()

    # --- Critère 7 : l'avis au démarrage, app ouverte et app fermée ----------------------------

    def test_start_sends_the_notice_with_ride_started(self):
        self._ride()
        notice = self.notify_started.call_args.kwargs["security_notice"]
        self.assertEqual(notice, "Votre trajet est enregistré pour votre sécurité.")


@tagged("post_install", "-at_install")
class TestRideTrackHttp(HttpCase):
    """Annulation en cours de route et téléversement du téléphone, par l'API réelle."""

    _BASE = controller_tests.TestRideController

    def setUp(self):
        super().setUp()
        # Même mise en place que test_ride_controller.py : position de test propre, rayon de
        # recherche des tests, une seule recherche.
        self._spot = controller_tests._next_spot()
        self.env["ir.config_parameter"].sudo().set_param(
            "babana.dispatch_radius_meters", str(controller_tests._TEST_DISPATCH_RADIUS_METERS)
        )
        self.env["ir.config_parameter"].sudo().set_param("babana.dispatch_widenings", "0")

    @classmethod
    def _request_handler(cls, s, r, **kw):
        if r.url.startswith(controller_tests._mock_google_base_url()) or "mock-maps" in r.url or r.url.startswith(
            controller_tests._realtime_internal_url()
        ):
            from odoo.tests.common import _super_send

            return _super_send(s, r, **kw)
        return super()._request_handler(s, r, **kw)

    _sign_in = _BASE._sign_in
    _make_approved_driver = _BASE._make_approved_driver
    _make_dispatchable_driver = _BASE._make_dispatchable_driver
    _post = _BASE._post
    _accept_via_internal_channel = _BASE._accept_via_internal_channel
    _make_ride = _BASE._make_ride
    _assigned_ride_over_http = _BASE._assigned_ride_over_http

    def _started(self, sub):
        ride, client_token, driver_token = self._assigned_ride_over_http(sub)
        self.assertEqual(self._post(f"/api/v1/rides/{ride.public_id}/start", driver_token).status_code, 200)
        return ride, client_token, driver_token

    def test_a_ride_cancelled_on_the_way_keeps_its_track_until_cancellation(self):
        # En route, seul le chauffeur peut annuler (L4-07 ; le client passe par un incident).
        ride, _client_token, driver_token = self._started("sub-track-cancel")
        points = [{"latitude": 4.05, "longitude": 9.70, "capturedAt": _iso(fields.Datetime.now()), "accuracyMeters": 5}]
        with patch.object(realtime_client, "fetch_ride_measurement", return_value=_measurement(points)):
            response = self._post(f"/api/v1/rides/{ride.public_id}/cancel", driver_token, {"reason": "Panne de moto"})
        self.assertEqual(response.status_code, 200, response.text)
        track = ride._babana_track()
        self.assertEqual(track.source, "realtime")
        self.assertEqual(track.point_count, 1)

    def test_the_driver_uploads_the_phone_copy_after_completion(self):
        ride, _client_token, driver_token = self._started("sub-track-upload")
        with patch.object(realtime_client, "fetch_ride_measurement", return_value=None):
            self.assertEqual(self._post(f"/api/v1/rides/{ride.public_id}/complete", driver_token).status_code, 200)
        now = fields.Datetime.now()
        body = {"points": [
            {"latitude": 4.05, "longitude": 9.70, "capturedAt": _iso(now - timedelta(seconds=40)), "accuracyMeters": 5},
            {"latitude": 4.0505, "longitude": 9.7005, "capturedAt": _iso(now - timedelta(seconds=10)), "accuracyMeters": 7},
        ]}
        response = self._post(f"/api/v1/rides/{ride.public_id}/track", driver_token, body)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"rideId": ride.public_id, "recorded": True, "source": "phone"})

    def test_uploading_before_the_end_of_the_ride_is_refused(self):
        ride, _client_token, driver_token = self._started("sub-track-early")
        response = self._post(f"/api/v1/rides/{ride.public_id}/track", driver_token, {"points": []})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "RIDE_INVALID_TRANSITION")
