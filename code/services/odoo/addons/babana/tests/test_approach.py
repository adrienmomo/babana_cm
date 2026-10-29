# Distance d'approche routière des chauffeurs disponibles (services/approach.py) -- demande produit
# du 26 octobre. Défaut trouvé par L3-14 le 27 : le classement passait par le cache de routage de
# la cotation, dont la grille (~100 m, L2-05) confond deux chauffeurs à quelques dizaines de mètres
# l'un de l'autre -- chacun héritait de la distance mise en cache pour l'autre, et la course partait
# au mauvais chauffeur.
from __future__ import annotations

from unittest.mock import patch

from odoo import fields
from odoo.tests.common import TransactionCase, tagged

from ..services import approach, realtime_client, routing

_PICKUP = (4.0500, 9.7010)


@tagged("post_install", "-at_install")
class TestApproach(TransactionCase):
    def _nearby(self, *drivers):
        patcher = patch.object(realtime_client, "fetch_nearby_drivers", return_value=list(drivers))
        patcher.start()
        self.addCleanup(patcher.stop)

    def _api(self, distances_by_driver_latitude):
        def fake_fetch(*, origin, destination):
            return routing.RouteResult(distances_by_driver_latitude[origin[0]], 60, "")

        patcher = patch.object(routing, "_fetch_from_api", side_effect=fake_fetch)
        mock = patcher.start()
        self.addCleanup(patcher.stop)
        return mock

    def test_two_drivers_in_the_same_cache_cell_are_ranked_by_their_own_distance(self):
        on_the_pickup = {"driverId": "on-the-pickup", "latitude": 4.05001, "longitude": 9.70101, "distanceMeters": 1}
        close_by = {"driverId": "close-by", "latitude": 4.05030, "longitude": 9.70100, "distanceMeters": 33}
        # Même cellule de grille pour les deux : une entrée de cache fraîche, calculée pour un autre
        # point de cette cellule, ne doit servir ni à l'un ni à l'autre.
        for driver in (on_the_pickup, close_by):
            key = routing.cache_key(
                origin=(driver["latitude"], driver["longitude"]), destination=_PICKUP,
                vehicle_class="standard", at_datetime=fields.Datetime.now(),
            )
            self.env["babana.route.cache"].sudo()._store(
                key, distance_meters=900 if driver is on_the_pickup else 10, duration_seconds=60,
                polyline="", ttl_seconds=3600,
            )
        self._nearby(on_the_pickup, close_by)
        api = self._api({4.05001: 2, 4.05030: 45})

        ranked = approach.road_ranked_candidates(
            self.env, pickup=_PICKUP, radius_meters=500, exclude_driver_public_ids=[]
        )

        self.assertEqual([candidate.driver_public_id for candidate in ranked], ["on-the-pickup", "close-by"])
        self.assertEqual([candidate.road_distance_meters for candidate in ranked], [2, 45])
        self.assertEqual(api.call_count, 2, "une mesure par chauffeur, jamais le cache de la cotation")

    def test_an_unreachable_routing_api_leaves_the_driver_out_of_the_ranking(self):
        self._nearby({"driverId": "unmeasurable", "latitude": 4.0504, "longitude": 9.7012, "distanceMeters": 50})
        patcher = patch.object(routing, "_fetch_from_api", side_effect=routing.RouteUnavailable("panne"))
        patcher.start()
        self.addCleanup(patcher.stop)

        ranked = approach.road_ranked_candidates(
            self.env, pickup=_PICKUP, radius_meters=500, exclude_driver_public_ids=[]
        )

        self.assertEqual(ranked, [])

    def test_the_average_falls_back_to_the_configured_distance_when_nobody_is_measurable(self):
        self._nearby()
        self.env["ir.config_parameter"].sudo().set_param("babana.default_approach_distance_meters", "1300")

        estimate = approach.average_approach(self.env, pickup=_PICKUP, radius_meters=500)

        self.assertEqual((estimate.distance_meters, estimate.driver_count), (1300, 0))
