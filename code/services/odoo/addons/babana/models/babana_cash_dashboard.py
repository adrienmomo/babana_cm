# Tableau de bord de caisse (L9-05). Non stocké, recalculé à chaque ouverture -- même patron que
# babana_fare_simulator.py : un TransientModel dont default_get() porte le calcul, pas un modèle
# persistant qu'il faudrait tenir à jour. "Le total détenu par la flotte est l'indicateur le plus
# important du pilote : c'est l'exposition financière de l'entreprise à un instant donné"
# (spécification) -- affiché en premier, jamais dérivé côté client.
from __future__ import annotations

from odoo import api, fields, models


class BabanaCashDashboard(models.TransientModel):
    _name = "babana.cash.dashboard"
    _description = "Tableau de bord de caisse (L9-05)"

    currency_id = fields.Many2one(
        "res.currency", default=lambda self: self.env.company.currency_id.id
    )
    total_held_amount = fields.Monetary(
        string="Total détenu par la flotte",
        currency_field="currency_id",
        readonly=True,
        help="Somme des soldes dus de tous les chauffeurs approuvés -- l'exposition financière "
        "de l'entreprise à cet instant (spécification L9-05).",
    )
    cash_limit = fields.Monetary(string="Plafond d'encaisse", currency_field="currency_id", readonly=True)
    drivers_at_limit_count = fields.Integer(string="Chauffeurs au plafond", readonly=True)
    drivers_near_limit_count = fields.Integer(string="Chauffeurs proches du plafond", readonly=True)
    pending_remittances_count = fields.Integer(
        string="Remises en attente de validation", readonly=True
    )
    oldest_pending_remittance_id = fields.Many2one(
        "babana.cash.remittance", readonly=True, string="Remise en attente la plus ancienne"
    )

    @api.model
    def default_get(self, fields_list):
        defaults = super().default_get(fields_list)
        Driver = self.env["babana.driver"].sudo()
        drivers = Driver.search([("state", "=", "approved")])
        pending_remittances = (
            self.env["babana.cash.remittance"]
            .sudo()
            .search([("state", "=", "declared")], order="create_date asc")
        )
        defaults.update(
            {
                "total_held_amount": sum(drivers.mapped("cash_balance")),
                "cash_limit": Driver._cash_limit(),
                "drivers_at_limit_count": len(drivers.filtered("cash_limit_reached")),
                "drivers_near_limit_count": len(drivers.filtered("cash_limit_near")),
                "pending_remittances_count": len(pending_remittances),
                "oldest_pending_remittance_id": pending_remittances[:1].id,
            }
        )
        return defaults

    def action_refresh(self):
        # Rouvre une instance fraîche du tableau de bord : default_get() ci-dessus recalcule tout
        # -- il n'y a rien à écrire sur l'enregistrement transitoire existant.
        return {
            "type": "ir.actions.act_window",
            "name": "Tableau de bord de caisse",
            "res_model": "babana.cash.dashboard",
            "view_mode": "form",
            "target": "current",
        }
