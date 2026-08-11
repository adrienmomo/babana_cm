# Extension de res.partner pour le client (L1-04). Pas de modèle séparé : la facturation Odoo
# (account.move, L4-06) attend un res.partner ; un modèle parallèle imposerait une
# synchronisation qui dérivera.
from __future__ import annotations

from odoo import fields, models


class ResPartner(models.Model):
    _inherit = "res.partner"

    babana_is_customer = fields.Boolean(
        string="Client babana",
        default=False,
        copy=False,
        help="Vrai pour un partenaire créé via /auth/google avec role=client (L1-01).",
    )
    babana_google_sub = fields.Char(
        string="Identifiant Google (sub)",
        index=True,
        copy=False,
        help="Miroir de res.users.google_sub côté partenaire, pour retrouver le client sans "
        "passer par le compte de connexion (facturation, back-office).",
    )
    babana_phone_verified = fields.Boolean(
        string="Numéro vérifié",
        default=False,
        copy=False,
        help="Résultat de L1-09 (OTP unique dans la vie du compte, hors de ce lot).",
    )
    babana_rides_count = fields.Integer(
        string="Nombre de courses",
        compute="_compute_babana_rides_count",
    )
    babana_emergency_contact = fields.Char(
        string="Contact d'urgence",
        help="Numéro de téléphone au format international. Sert au partage de trajet (L8-03) : "
        "notifié si renseigné, jamais obligatoire.",
    )

    _sql_constraints = [
        (
            "babana_partner_google_sub_unique",
            "unique(babana_google_sub)",
            "Ce compte Google est déjà rattaché à un autre client babana.",
        ),
    ]

    def _compute_babana_rides_count(self):
        for record in self:
            record.babana_rides_count = self.env["babana.ride"].search_count(
                [("client_id", "=", record.id)]
            )
