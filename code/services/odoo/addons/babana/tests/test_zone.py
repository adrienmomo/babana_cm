# Tests de babana.zone (L2-02).
from __future__ import annotations

import json

from odoo.exceptions import UserError
from odoo.tests.common import TransactionCase, tagged

# Carré simple, indépendant de la zone Douala par défaut installée par
# data/babana_zone_default.xml -- pour ne pas dépendre de ses coordonnées précises.
_SQUARE_GEOJSON = json.dumps(
    {"type": "Polygon", "coordinates": [[[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0], [0.0, 0.0]]]}
)


@tagged("post_install", "-at_install")
class TestBabanaZone(TransactionCase):
    def setUp(self):
        super().setUp()
        # La zone Douala par défaut (data/babana_zone_default.xml) existe déjà dans toute base
        # installée -- désactivée ici pour que chaque test contrôle entièrement son propre jeu
        # de zones, y compris celles qui posent leur propre zone par défaut. flush_recordset()
        # obligatoire : l'INSERT d'une nouvelle zone par défaut juste après, plus bas dans le
        # test, passe par du SQL brut et ne verrait pas cette désactivation sinon (même piège
        # que L1-08, amoa/rapport-nuit-J3.md).
        zones = self.env["babana.zone"].search([])
        zones.write({"active": False})
        zones.flush_recordset(["active"])

    def _make_zone(self, **vals):
        base = {"name": "Zone de test", "polygon_geojson": _SQUARE_GEOJSON}
        base.update(vals)
        return self.env["babana.zone"].create(base)

    # --- Critère 1 : un point dans une zone unique renvoie cette zone -------------------------

    def test_point_inside_a_single_zone_resolves_to_it(self):
        zone = self._make_zone()
        found = self.env["babana.zone"].resolve_point(latitude=5.0, longitude=5.0)
        self.assertEqual(found, zone)

    # --- Critère 2 : un point dans deux zones renvoie celle de plus forte priorité ------------

    def test_point_in_two_overlapping_zones_resolves_to_the_higher_priority_one(self):
        self._make_zone(name="Large", priority=0)
        narrow_high_priority = self._make_zone(
            name="Centre-ville",
            priority=10,
            polygon_geojson=json.dumps(
                {"type": "Polygon", "coordinates": [[[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]]]}
            ),
        )

        found = self.env["babana.zone"].resolve_point(latitude=5.0, longitude=5.0)

        self.assertEqual(found, narrow_high_priority)

    # --- Critère 3 : un point hors de toute zone renvoie la zone par défaut, pas une erreur ---

    def test_point_outside_every_zone_resolves_to_the_default_zone(self):
        default_zone = self._make_zone(name="Défaut", is_default=True)
        self._make_zone(
            name="Ailleurs",
            polygon_geojson=json.dumps(
                {"type": "Polygon", "coordinates": [[[100, 100], [101, 100], [101, 101], [100, 101], [100, 100]]]}
            ),
        )

        found = self.env["babana.zone"].resolve_point(latitude=5.0, longitude=5.0)

        self.assertEqual(found, default_zone)

    def test_missing_default_zone_raises_explicitly(self):
        with self.assertRaises(UserError):
            self.env["babana.zone"].resolve_point(latitude=999.0, longitude=999.0)

    def test_only_one_active_default_zone_allowed(self):
        self._make_zone(name="Défaut 1", is_default=True)
        with self.assertRaises(Exception):
            self._make_zone(name="Défaut 2", is_default=True)

    # --- Critère 4 : un point sur une frontière est déterministe -----------------------------

    def test_point_exactly_on_the_boundary_is_deterministic(self):
        zone = self._make_zone()
        first = zone._point_in_polygon(0.0, 0.0)
        second = zone._point_in_polygon(0.0, 0.0)
        self.assertEqual(first, second)

    # --- L9-04, critère 3 : le tracé s'ouvre dans un éditeur externe, pré-rempli --------------

    def test_external_editor_url_embeds_the_current_polygon(self):
        # Odoo Communauté n'a pas de widget carte éditable (amoa/questions/L9-04.md) -- le champ
        # ouvre geojson.io avec le GeoJSON courant encodé dans l'URL plutôt que de partir vide.
        zone = self._make_zone(polygon_geojson=_SQUARE_GEOJSON)

        self.assertTrue(zone.external_editor_url.startswith("https://geojson.io/#data="))
        self.assertIn("10.0", zone.external_editor_url)

    def test_external_editor_url_has_a_sane_default_without_a_polygon_yet(self):
        zone = self._make_zone(polygon_geojson=False)

        self.assertTrue(zone.external_editor_url.startswith("https://geojson.io/#data="))

    def test_inactive_zone_is_never_resolved(self):
        default_zone = self._make_zone(name="Défaut", is_default=True)
        self._make_zone(name="Inactive", active=False, priority=99)

        found = self.env["babana.zone"].resolve_point(latitude=5.0, longitude=5.0)

        self.assertEqual(found, default_zone)
