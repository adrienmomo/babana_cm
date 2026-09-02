# Simulateur de tarif (L9-04, critère 2). L'API de routage est patchée, jamais réellement
# appelée -- même technique que test_routing.py, pour isoler le simulateur de la disponibilité de
# mock-maps pendant les tests.
from __future__ import annotations

from datetime import datetime
from unittest.mock import patch

from odoo.tests.common import TransactionCase, tagged

from ..services import routing


class _FakeRouteResponse:
    def __init__(self, distance_meters=4200, duration_seconds=780):
        self._body = {
            "distanceMeters": distance_meters,
            "durationSeconds": duration_seconds,
            "polyline": "abc123",
        }

    def raise_for_status(self):
        return None

    def json(self):
        return self._body


@tagged("post_install", "-at_install")
class TestFareSimulator(TransactionCase):
    def test_simulate_returns_amount_and_applied_rule(self):
        rule = self.env["babana.fare.rule"].create(
            {
                "name": "Règle simulée",
                "base_fare": 200.0,
                "price_per_km": 100.0,
                "minimum_fare": 300.0,
                "priority": 50,
            }
        )
        wizard = self.env["babana.fare.simulator"].create(
            {
                "pickup_latitude": 4.05,
                "pickup_longitude": 9.70,
                "dropoff_latitude": 4.06,
                "dropoff_longitude": 9.77,
                "vehicle_class": "standard",
                "simulated_at": datetime(2026, 9, 2, 12, 0, 0),
            }
        )

        with patch.object(routing.requests, "get", return_value=_FakeRouteResponse()):
            wizard.action_simulate()

        self.assertEqual(wizard.fare_rule_id, rule)
        self.assertTrue(wizard.simulated)
        # 200 base + 4.2 km x 100 = 620, au pas d'arrondi par défaut (25) -> 625.
        self.assertEqual(wizard.amount, 625.0)
        self.assertIn("Total : 625 FCFA", wizard.breakdown_text)

    def test_simulate_resolves_the_pickup_zone(self):
        zone = self.env["babana.zone"].create(
            {
                "name": "Zone simulée",
                "priority": 10,
                "polygon_geojson": (
                    '{"type": "Polygon", "coordinates": '
                    '[[[9.0, 4.0], [9.0, 4.1], [9.9, 4.1], [9.9, 4.0], [9.0, 4.0]]]}'
                ),
            }
        )
        wizard = self.env["babana.fare.simulator"].create(
            {
                "pickup_latitude": 4.05,
                "pickup_longitude": 9.70,
                "dropoff_latitude": 4.06,
                "dropoff_longitude": 9.77,
            }
        )

        with patch.object(routing.requests, "get", return_value=_FakeRouteResponse()):
            wizard.action_simulate()

        self.assertEqual(wizard.pickup_zone_id, zone)
