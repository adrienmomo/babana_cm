# Extension de res.partner pour le client (L1-04). Pas de modèle séparé : la facturation Odoo
# (account.move, L4-06) attend un res.partner ; un modèle parallèle imposerait une
# synchronisation qui dérivera.
from __future__ import annotations

from odoo import api, fields, models

# États d'une course où client et chauffeur sont réellement réunis -- doit rester aligné sur
# babana_ride.py::TOGETHER_STATES (le chauffeur joint son passager pendant la course, plus
# après). Recopié plutôt qu'importé : ce module est chargé avant babana_ride, et la règle
# d'enregistrement L8-01 qui s'appuie sur ce champ doit pouvoir être relue seule.
_RIDE_TOGETHER_STATES = ("assigned", "in_progress")


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

    # --- L8-01, la règle la plus délicate : le chauffeur joint son passager pendant la course,
    #     jamais après ------------------------------------------------------------------------
    babana_reachable_by_current_driver = fields.Boolean(
        string="Joignable par le chauffeur courant",
        compute="_compute_babana_reachable_by_current_driver",
        search="_search_babana_reachable_by_current_driver",
        help="Vrai si l'utilisateur connecté est le chauffeur d'une course ACTIVE "
        "(assigned/in_progress) dont ce partenaire est le client. Sert uniquement de domaine à "
        "la règle d'enregistrement res.partner de L8-01 -- jamais affiché. Le calcul est lié à "
        "une seule et même course : un chauffeur qui a terminé une course avec ce client, puis "
        "en a une autre active avec un client différent, ne rend pas ce premier client "
        "joignable (le piège d'une règle écrite en deux conditions indépendantes).",
    )

    @api.depends_context("uid")
    def _compute_babana_reachable_by_current_driver(self):
        reachable = self.env["res.partner"].browse(
            self._babana_partners_reachable_by_driver_user(self.env.uid)
        )
        for record in self:
            record.babana_reachable_by_current_driver = record in reachable

    def _search_babana_reachable_by_current_driver(self, operator, value):
        if operator not in ("=", "!=") or not isinstance(value, bool):
            raise ValueError("babana_reachable_by_current_driver : seul `= True/False` est géré")
        ids = self._babana_partners_reachable_by_driver_user(self.env.uid)
        positive = (operator == "=") == bool(value)
        return [("id", "in" if positive else "not in", ids)]

    @api.model
    def _babana_partners_reachable_by_driver_user(self, user_id):
        """Partenaires clients d'une course active conduite par `user_id`. `sudo()` : ce lookup
        alimente la règle d'enregistrement, il ne doit pas être filtré par elle.

        Aucune condition sur `driver_id.state` (D55, amoa/questions/REPONSES-2026-09-08.md §3) :
        un chauffeur suspendu en plein trajet doit pouvoir joindre son passager -- « sa course
        en cours » reste lisible, la suspension n'agit que sur la disponibilité future. La
        fenêtre temporelle tient déjà entièrement à `state in (assigned, in_progress)`."""
        rides = self.env["babana.ride"].sudo().search(
            [
                ("state", "in", list(_RIDE_TOGETHER_STATES)),
                ("driver_id.user_id", "=", user_id),
            ]
        )
        return rides.client_id.ids
