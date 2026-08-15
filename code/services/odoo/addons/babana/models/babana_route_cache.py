# Cache de distance de référence (L2-05). Une entrée par clé (coordonnées arrondies à une grille
# de l'ordre de cent mètres, gamme, tranche horaire -- voir services/routing.py:cache_key) : deux
# appels identiques ne produisent qu'une requête sortante vers l'API de routage, et deux
# estimations proches restent cohérentes entre elles.
from __future__ import annotations

from datetime import timedelta

from odoo import api, fields, models


class BabanaRouteCache(models.Model):
    _name = "babana.route.cache"
    _description = "Cache de distance de référence (L2-05)"

    cache_key = fields.Char(required=True, index=True)
    distance_meters = fields.Integer(required=True)
    duration_seconds = fields.Integer(required=True)
    polyline = fields.Text()
    expires_at = fields.Datetime(required=True, index=True)

    _sql_constraints = [
        ("babana_route_cache_key_unique", "unique(cache_key)", "Une seule entrée de cache par clé."),
    ]

    @api.model
    def _get_fresh(self, key: str):
        return self.search(
            [("cache_key", "=", key), ("expires_at", ">", fields.Datetime.now())], limit=1
        )

    @api.model
    def _store(self, key: str, *, distance_meters: int, duration_seconds: int, polyline: str,
               ttl_seconds: int):
        expires_at = fields.Datetime.now() + timedelta(seconds=ttl_seconds)
        vals = {
            "distance_meters": distance_meters,
            "duration_seconds": duration_seconds,
            "polyline": polyline,
            "expires_at": expires_at,
        }
        existing = self.search([("cache_key", "=", key)], limit=1)
        if existing:
            existing.write(vals)
            return existing
        return self.create({**vals, "cache_key": key})
