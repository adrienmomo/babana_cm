# Simulateur de tarif (L9-04, critère 2). Rejoue exactement le chemin de POST /api/v1/quote
# (controllers/quote.py) : résolution de zone, sélection de règle, distance de référence,
# calcul -- pour que le montant simulé soit celui qu'un vrai client obtiendrait, jamais un calcul
# parallèle qui pourrait diverger du moteur réel.
from __future__ import annotations

from odoo import api, fields, models
from odoo.exceptions import UserError

from ..services import routing
from ..services.pricing import FareRuleInput, compute_fare


class BabanaFareSimulator(models.TransientModel):
    _name = "babana.fare.simulator"
    _description = "Simulateur de tarif (L9-04)"

    pickup_latitude = fields.Float(string="Latitude départ", digits=(10, 6), required=True)
    pickup_longitude = fields.Float(string="Longitude départ", digits=(10, 6), required=True)
    dropoff_latitude = fields.Float(string="Latitude arrivée", digits=(10, 6), required=True)
    dropoff_longitude = fields.Float(string="Longitude arrivée", digits=(10, 6), required=True)
    vehicle_class = fields.Selection(
        [("standard", "Standard"), ("premium", "Premium")],
        default="standard",
        required=True,
        string="Gamme",
    )
    simulated_at = fields.Datetime(
        string="Date et heure simulées",
        default=lambda self: fields.Datetime.now(),
        required=True,
        help="Odoo affiche et enregistre cette valeur dans le fuseau de votre compte (Africa/"
        "Douala par défaut, D45) -- la même heure locale que celle utilisée pour saisir "
        "time_start/time_end sur une règle tarifaire. Le simulateur applique la même conversion "
        "que le moteur réel (POST /api/v1/quote), pour que la règle trouvée ici soit celle "
        "qu'une vraie cotation trouverait à cette heure.",
    )

    pickup_zone_id = fields.Many2one(
        "babana.zone", readonly=True, string="Zone de départ résolue"
    )
    fare_rule_id = fields.Many2one("babana.fare.rule", readonly=True, string="Règle appliquée")
    distance_meters = fields.Integer(readonly=True, string="Distance de référence (m)")
    amount = fields.Float(readonly=True, string="Montant simulé (FCFA)")
    breakdown_text = fields.Text(readonly=True, string="Détail décomposé")
    simulated = fields.Boolean(default=False)

    def action_simulate(self):
        self.ensure_one()
        pickup_zone = self.env["babana.zone"].resolve_point(
            latitude=self.pickup_latitude, longitude=self.pickup_longitude
        )
        rule = self.env["babana.fare.rule"]._find_applicable_rule(
            zone=pickup_zone, vehicle_class=self.vehicle_class, at_datetime=self.simulated_at
        )
        try:
            route = routing.get_reference_route(
                self.env,
                origin=(self.pickup_latitude, self.pickup_longitude),
                destination=(self.dropoff_latitude, self.dropoff_longitude),
                vehicle_class=self.vehicle_class,
                at_datetime=self.simulated_at,
            )
        except routing.RouteUnavailable as exc:
            raise UserError(str(exc)) from exc

        rounding_step = self.env["babana.fare.rule"]._default_rounding_step()
        rule_input = FareRuleInput(
            base_fare=rule.base_fare,
            price_per_km=rule.price_per_km,
            minimum_fare=rule.minimum_fare,
            surge_multiplier=rule.surge_multiplier,
        )
        breakdown = compute_fare(rule_input, route.distance_meters, rounding_step=rounding_step)
        lines = [
            "Prise en charge : %.0f FCFA" % breakdown.base_fare,
            "Distance : %.0f FCFA" % breakdown.distance_fare,
            "Heure de pointe : %.0f FCFA" % breakdown.surge_amount,
            "Remise : -%.0f FCFA" % breakdown.discount_amount,
            "Plancher : %.0f FCFA%s"
            % (breakdown.floor_amount, " (plancher appliqué)" if breakdown.minimum_fare_applied else ""),
            "Arrondi : %.0f FCFA" % breakdown.rounding_amount,
            "Total : %.0f FCFA" % breakdown.total,
        ]
        self.write(
            {
                "pickup_zone_id": pickup_zone.id,
                "fare_rule_id": rule.id,
                "distance_meters": route.distance_meters,
                "amount": breakdown.total,
                "breakdown_text": "\n".join(lines),
                "simulated": True,
            }
        )
        return {
            "type": "ir.actions.act_window",
            "res_model": "babana.fare.simulator",
            "res_id": self.id,
            "view_mode": "form",
            "target": "new",
        }

    @api.model
    def default_get(self, fields_list):
        # Point de repère par défaut à Douala plutôt que 0.0/0.0 (le golfe de Guinée) -- une
        # valeur de départ plausible que le superviseur ajuste, jamais un calcul métier.
        defaults = super().default_get(fields_list)
        defaults.setdefault("pickup_latitude", 4.05)
        defaults.setdefault("pickup_longitude", 9.70)
        defaults.setdefault("dropoff_latitude", 4.06)
        defaults.setdefault("dropoff_longitude", 9.77)
        return defaults
