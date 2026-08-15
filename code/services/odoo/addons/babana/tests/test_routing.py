# Tests de la distance de référence et du cache (L2-05). L'API de routage est entièrement
# simulée par une réponse patchée (critère d'acceptation 5 : « les tests n'appellent jamais
# l'API réelle ») -- même technique que test_google_identity.py pour le cache JWKS (L1-01),
# choisie ici plutôt qu'un aller-retour réseau vers mock-maps pour isoler précisément le
# comportement du cache, indépendamment de la disponibilité du conteneur pendant les tests.
from __future__ import annotations

import inspect
from datetime import datetime, timedelta
from unittest.mock import patch

import requests

from odoo.tests.common import TransactionCase, tagged

from ..services import routing

_ORIGIN = (4.0483, 9.6934)
_DESTINATION = (4.0270, 9.7040)
_AT = datetime(2026, 8, 15, 10, 30, 0)


class _FakeRouteResponse:
    def __init__(self, distance_meters=4200, duration_seconds=780, polyline="abc123"):
        self._body = {
            "distanceMeters": distance_meters,
            "durationSeconds": duration_seconds,
            "polyline": polyline,
        }

    def raise_for_status(self):
        return None

    def json(self):
        return self._body


@tagged("post_install", "-at_install")
class TestRouting(TransactionCase):
    # --- Critère 1 : deux appels identiques ne produisent qu'une requête sortante -------------

    def test_two_identical_calls_make_a_single_outbound_request(self):
        with patch.object(
            routing.requests, "get", return_value=_FakeRouteResponse()
        ) as mocked:
            first = routing.get_reference_route(
                self.env, origin=_ORIGIN, destination=_DESTINATION, vehicle_class="standard",
                at_datetime=_AT,
            )
            second = routing.get_reference_route(
                self.env, origin=_ORIGIN, destination=_DESTINATION, vehicle_class="standard",
                at_datetime=_AT,
            )

        self.assertEqual(mocked.call_count, 1)
        self.assertEqual(first, second)
        self.assertEqual(first.distance_meters, 4200)

    # --- Critère 2 : le cache expire -----------------------------------------------------------

    def test_cache_expires(self):
        with patch.object(routing.requests, "get", return_value=_FakeRouteResponse()) as mocked:
            routing.get_reference_route(
                self.env, origin=_ORIGIN, destination=_DESTINATION, vehicle_class="standard",
                at_datetime=_AT,
            )
        self.assertEqual(mocked.call_count, 1)

        key = routing.cache_key(
            origin=_ORIGIN, destination=_DESTINATION, vehicle_class="standard", at_datetime=_AT
        )
        cache_entry = self.env["babana.route.cache"].sudo().search([("cache_key", "=", key)])
        self.assertTrue(cache_entry)
        cache_entry.write({"expires_at": datetime.now() - timedelta(seconds=1)})
        cache_entry.flush_recordset(["expires_at"])

        with patch.object(routing.requests, "get", return_value=_FakeRouteResponse()) as mocked:
            routing.get_reference_route(
                self.env, origin=_ORIGIN, destination=_DESTINATION, vehicle_class="standard",
                at_datetime=_AT,
            )
        self.assertEqual(mocked.call_count, 1, "l'entrée expirée doit déclencher un nouvel appel")

    # --- Critère 3 : l'indisponibilité de l'API produit une erreur explicite ------------------

    def test_api_failure_raises_route_unavailable_not_a_degraded_estimate(self):
        with patch.object(
            routing.requests, "get", side_effect=requests.ConnectionError("panne simulée")
        ):
            with self.assertRaises(routing.RouteUnavailable):
                routing.get_reference_route(
                    self.env, origin=_ORIGIN, destination=(4.09, 9.80), vehicle_class="standard",
                    at_datetime=_AT,
                )

    def test_http_error_status_raises_route_unavailable(self):
        class _FailingResponse:
            def raise_for_status(self):
                raise requests.HTTPError("503")

        with patch.object(routing.requests, "get", return_value=_FailingResponse()):
            with self.assertRaises(routing.RouteUnavailable):
                routing.get_reference_route(
                    self.env, origin=_ORIGIN, destination=(4.10, 9.82), vehicle_class="standard",
                    at_datetime=_AT,
                )

    # --- Critère 4 : le commentaire É8 est présent au point de calcul -------------------------

    def test_e8_comment_is_present_at_the_computation_point(self):
        source = inspect.getsource(routing)
        self.assertIn("É8", source)
        self.assertIn("voiture", source.lower())

    # --- Clé de cache : arrondie à la grille, sensible à la gamme et à la tranche horaire ------

    def test_cache_key_is_stable_for_nearby_points_and_varies_by_vehicle_class(self):
        key_a = routing.cache_key(
            origin=(4.04831, 9.69341), destination=_DESTINATION, vehicle_class="standard",
            at_datetime=_AT,
        )
        key_b = routing.cache_key(
            origin=(4.04829, 9.69339), destination=_DESTINATION, vehicle_class="standard",
            at_datetime=_AT,
        )
        key_premium = routing.cache_key(
            origin=_ORIGIN, destination=_DESTINATION, vehicle_class="premium", at_datetime=_AT
        )
        self.assertEqual(key_a, key_b)
        self.assertNotEqual(key_a, key_premium)
