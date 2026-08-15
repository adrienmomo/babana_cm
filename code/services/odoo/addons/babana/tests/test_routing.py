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

from odoo import fields
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

    # --- Critère 4 (D24) : une entrée de cache PÉRIMÉE est servie si l'API est indisponible ----

    def test_stale_cache_entry_is_served_when_api_unavailable(self):
        with patch.object(
            routing.requests, "get", return_value=_FakeRouteResponse(distance_meters=5555)
        ):
            first = routing.get_reference_route(
                self.env, origin=_ORIGIN, destination=_DESTINATION, vehicle_class="standard",
                at_datetime=_AT,
            )
        self.assertEqual(first.distance_meters, 5555)

        key = routing.cache_key(
            origin=_ORIGIN, destination=_DESTINATION, vehicle_class="standard", at_datetime=_AT
        )
        cache_entry = self.env["babana.route.cache"].sudo().search([("cache_key", "=", key)])
        cache_entry.write({"expires_at": datetime.now() - timedelta(seconds=1)})
        cache_entry.flush_recordset(["expires_at"])

        with patch.object(
            routing.requests, "get", side_effect=requests.ConnectionError("panne simulée")
        ):
            # Ne lève PAS RouteUnavailable : l'entrée périmée de la même clé existe (D24), elle
            # n'est pas une estimation dégradée -- juste calculée par la vraie API un peu plus
            # tôt (critère d'acceptation 4).
            fallback = routing.get_reference_route(
                self.env, origin=_ORIGIN, destination=_DESTINATION, vehicle_class="standard",
                at_datetime=_AT,
            )
        self.assertEqual(fallback.distance_meters, 5555)

    def test_route_unavailable_without_any_cache_entry_still_raises(self):
        # Critère d'acceptation 3, préservé : sans AUCUNE entrée (même périmée) pour ce trajet,
        # l'erreur explicite subsiste -- jamais d'estimation dégradée silencieuse.
        with patch.object(
            routing.requests, "get", side_effect=requests.ConnectionError("panne simulée")
        ):
            with self.assertRaises(routing.RouteUnavailable):
                routing.get_reference_route(
                    self.env, origin=(4.11, 9.83), destination=(4.12, 9.84),
                    vehicle_class="standard", at_datetime=_AT,
                )

    def test_stale_cache_fallback_does_not_record_quota_usage(self):
        # Servir une entrée périmée ne fait aucun appel sortant -- il n'y a donc rien à
        # comptabiliser pour le quota (services/routing.py:get_reference_route).
        with patch.object(routing.requests, "get", return_value=_FakeRouteResponse()):
            routing.get_reference_route(
                self.env, origin=_ORIGIN, destination=_DESTINATION, vehicle_class="standard",
                at_datetime=_AT,
            )
        key = routing.cache_key(
            origin=_ORIGIN, destination=_DESTINATION, vehicle_class="standard", at_datetime=_AT
        )
        cache_entry = self.env["babana.route.cache"].sudo().search([("cache_key", "=", key)])
        cache_entry.write({"expires_at": datetime.now() - timedelta(seconds=1)})
        cache_entry.flush_recordset(["expires_at"])

        count_key = f"babana.routing_quota_count_{fields.Date.today().isoformat()}"
        param_model = self.env["ir.config_parameter"].sudo()
        before = int(param_model.get_param(count_key, 0))

        with patch.object(
            routing.requests, "get", side_effect=requests.ConnectionError("panne simulée")
        ):
            routing.get_reference_route(
                self.env, origin=_ORIGIN, destination=_DESTINATION, vehicle_class="standard",
                at_datetime=_AT,
            )
        after = int(param_model.get_param(count_key, 0))
        self.assertEqual(after, before)

    # --- Critère 7 : le compteur de quota s'incrémente en une seule instruction (C3) ----------

    def test_quota_counter_increments_atomically_across_calls(self):
        # Pas un test de concurrence réelle (TransactionCase, une seule connexion) -- celui-là
        # vit dans test/concurrency (pile réelle, comme L3-13/L4-11). Celui-ci prouve que
        # _record_quota_usage incrémente correctement par une seule instruction SQL, appelée
        # plusieurs fois de suite (amoa/questions/REPONSES-2026-08-15.md §4).
        count_key = f"babana.routing_quota_count_{fields.Date.today().isoformat()}"
        param_model = self.env["ir.config_parameter"].sudo()
        before = int(param_model.get_param(count_key, 0))

        routing._record_quota_usage(self.env)
        routing._record_quota_usage(self.env)
        routing._record_quota_usage(self.env)

        after = int(param_model.get_param(count_key, 0))
        self.assertEqual(after, before + 3)

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
