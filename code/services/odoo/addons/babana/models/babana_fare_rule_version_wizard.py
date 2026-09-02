# Assistant "nouvelle version" (L9-04, critère 5) : la seule façon, depuis le back-office, de
# faire évoluer une règle tarifaire déjà servie par une course. babana_fare_rule.py::write()
# refuse toute modification en place d'un champ versionné sur une telle règle -- ce formulaire
# est le chemin qui reste, et son titre le dit explicitement plutôt que de laisser croire à une
# modification en place.
from __future__ import annotations

from odoo import fields, models


class BabanaFareRuleVersionWizard(models.TransientModel):
    _name = "babana.fare.rule.version.wizard"
    _description = "Nouvelle version d'une règle tarifaire (L9-04)"

    source_rule_id = fields.Many2one("babana.fare.rule", required=True, readonly=True)
    name = fields.Char(required=True)
    base_fare = fields.Float(string="Prise en charge (FCFA)", required=True)
    price_per_km = fields.Float(string="Prix au kilomètre (FCFA)", required=True)
    minimum_fare = fields.Float(string="Montant plancher (FCFA)", required=True)
    zone_id = fields.Many2one("babana.zone", string="Zone d'application")
    vehicle_class = fields.Selection(
        [("standard", "Standard"), ("premium", "Premium")], string="Gamme"
    )
    time_start = fields.Float(string="Début de plage horaire")
    time_end = fields.Float(string="Fin de plage horaire")
    weekday_mask = fields.Integer(string="Jours d'application (bits)")
    surge_multiplier = fields.Float(string="Coefficient heure de pointe")
    priority = fields.Integer()

    def action_confirm(self):
        self.ensure_one()
        new_rule = self.source_rule_id.new_version(
            {
                "name": self.name,
                "base_fare": self.base_fare,
                "price_per_km": self.price_per_km,
                "minimum_fare": self.minimum_fare,
                "zone_id": self.zone_id.id,
                "vehicle_class": self.vehicle_class,
                "time_start": self.time_start,
                "time_end": self.time_end,
                "weekday_mask": self.weekday_mask,
                "surge_multiplier": self.surge_multiplier,
                "priority": self.priority,
            }
        )
        return {
            "type": "ir.actions.act_window",
            "name": "Nouvelle version de la règle tarifaire",
            "res_model": "babana.fare.rule",
            "view_mode": "form",
            "res_id": new_rule.id,
            "target": "current",
        }
