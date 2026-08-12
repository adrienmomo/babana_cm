# Zones géographiques (L2-02). Test d'appartenance en Python, sans PostGIS : le volume de zones
# au pilote est faible (une seule, voir data/babana_zone_default.xml) et PostGIS complique le
# déploiement pour un bénéfice nul à cette échelle -- décision réversible si le nombre de zones
# croît fortement (amoa/specs/L2-tarification.md, L2-02).
from __future__ import annotations

import json

from odoo import api, fields, models
from odoo.exceptions import UserError


def _ray_casting_contains(x: float, y: float, ring: list[list[float]]) -> bool:
    """Point-in-polygon par lancer de rayon (algorithme PNPOLY, W. R. Franklin) sur l'anneau
    extérieur d'un polygone GeoJSON -- trous éventuels ignorés, non requis par la spécification.

    Convention pour un point exactement sur la frontière (critère d'acceptation 4) : les arêtes
    sont demi-ouvertes (`yi > y` strict d'un côté), ce qui rend le résultat déterministe pour une
    entrée donnée, mais son appartenance dépend de l'orientation de l'arête testée -- documenté
    ici plutôt que déguisé en cas particulier, comme le demande le critère."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


class BabanaZone(models.Model):
    _name = "babana.zone"
    _description = "Zone géographique (L2-02)"
    _order = "priority desc, id desc"

    name = fields.Char(required=True)
    polygon_geojson = fields.Text(
        string="Polygone (GeoJSON)",
        help='Objet GeoJSON Polygon : {"type": "Polygon", "coordinates": [[[lng, lat], ...]]}.',
    )
    priority = fields.Integer(
        default=0,
        help="Départage entre zones qui se chevauchent (critère d'acceptation 2) : la plus "
        "forte gagne. Les zones peuvent se recouvrir -- c'est voulu (ex. centre-ville aux "
        "heures de pointe recouvrant une zone plus large).",
    )
    active = fields.Boolean(default=True)
    is_default = fields.Boolean(
        string="Zone par défaut",
        help="Renvoyée quand aucune zone ne contient le point (critère d'acceptation 3), pas "
        "une erreur. Au plus une zone par défaut active à la fois.",
    )

    def init(self):
        self.env.cr.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS babana_zone_one_default_active
            ON babana_zone ((1)) WHERE is_default AND active
            """
        )

    def _point_in_polygon(self, latitude: float, longitude: float) -> bool:
        self.ensure_one()
        if not self.polygon_geojson:
            return False
        geometry = json.loads(self.polygon_geojson)
        ring = geometry["coordinates"][0]
        return _ray_casting_contains(longitude, latitude, ring)

    @api.model
    def resolve_point(self, *, latitude: float, longitude: float):
        """Résout un point vers sa zone (L2-02, critères 1 à 4). Parmi les zones qui contiennent
        le point, celle de plus forte priorité (_order la porte déjà) ; aucune ne le contient :
        la zone par défaut, jamais une erreur."""
        for zone in self.search([("active", "=", True)]):
            if zone._point_in_polygon(latitude, longitude):
                return zone

        default_zone = self.search([("active", "=", True), ("is_default", "=", True)], limit=1)
        if not default_zone:
            raise UserError(
                "Aucune zone par défaut active configurée (L2-02) : un point doit toujours "
                "résoudre une zone."
            )
        return default_zone
