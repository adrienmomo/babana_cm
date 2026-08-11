# La course (L4-01). Les transitions de babana.ride sont les seules portes d'écriture sur
# `state` (invariant 2) -- ce verrou est posé par L4-02, pas ici. L4-01 pose le modèle de
# données et ses contraintes d'intégrité.
from __future__ import annotations

from odoo import api, fields, models

# États de C-03 (docs/contracts/ride-state-machine.md), sans `draft` : jamais persisté (L4-01,
# critère hérité de C-03).
RIDE_STATES = [
    ("requested", "Demandée"),
    ("proposed", "Proposée"),
    ("assigned", "Affectée"),
    ("in_progress", "En cours"),
    ("completed", "Terminée"),
    ("settled", "Encaissée"),
    ("rejected", "Refusée"),
    ("cancelled", "Annulée"),
]

# États actifs (L4-01, critère d'acceptation 2, corrigé le 11 août -- amoa/questions/L4-01.md) :
# ils diffèrent selon la partie. En `requested`, aucun chauffeur n'est encore désigné, l'état ne
# le concerne pas ; mais pour le client, la course est bien en cours dès la demande, et deux
# demandes simultanées du même client n'ont aucun sens métier. Utilisé à la fois par les index
# partiels PostgreSQL ci-dessous et par les tests qui les prouvent.
DRIVER_ACTIVE_STATES = ("proposed", "assigned", "in_progress")
CLIENT_ACTIVE_STATES = ("requested", "proposed", "assigned", "in_progress")


class BabanaRide(models.Model):
    _name = "babana.ride"
    _description = "Course (L4-01)"
    _order = "create_date desc"

    # --- Identité --------------------------------------------------------------------------
    reference = fields.Char(required=True, readonly=True, copy=False, index=True, default="/")
    state = fields.Selection(
        RIDE_STATES,
        default="requested",
        required=True,
        index=True,
        help="Seules les méthodes de transition de L4-02 doivent écrire ce champ.",
    )

    # --- Parties -----------------------------------------------------------------------------
    client_id = fields.Many2one("res.partner", required=True, index=True, ondelete="restrict")
    driver_id = fields.Many2one("babana.driver", index=True, ondelete="restrict")
    # Moto (babana.motorcycle, L1-07) omise : le modèle n'existe pas encore, un Many2one vers un
    # modèle absent empêcherait l'installation. Voir amoa/questions/L4-01.md.

    # --- Géographie ----------------------------------------------------------------------------
    pickup_latitude = fields.Float(required=True, digits=(10, 6))
    pickup_longitude = fields.Float(required=True, digits=(10, 6))
    pickup_label = fields.Char(help="Repère ou adresse saisie par le client (Douala, D-quoi).")
    dropoff_latitude = fields.Float(required=True, digits=(10, 6))
    dropoff_longitude = fields.Float(required=True, digits=(10, 6))
    dropoff_label = fields.Char()
    # pickup_zone_id / dropoff_zone_id (babana.zone, L2-02) omis, même raison. Voir la question.

    # --- Estimation ------------------------------------------------------------------------
    quote_reference = fields.Char(
        help="Remplace un Many2one babana.quote (L2-04, absent ce soir) -- "
        "amoa/questions/L4-01.md.",
    )
    currency_id = fields.Many2one(
        "res.currency", default=lambda self: self.env.company.currency_id.id, required=True
    )
    estimated_amount = fields.Monetary(currency_field="currency_id")
    reference_distance_km = fields.Float(
        help="Distance de référence (modèle voiture, É8) -- jamais recalculée depuis le tracé.",
    )
    estimated_duration_minutes = fields.Float()

    # --- Réalisé -----------------------------------------------------------------------------
    actual_distance_km = fields.Float()
    actual_duration_minutes = fields.Float()
    track_polyline = fields.Text(help="Tracé complet, archivé en une seule écriture (L4-04).")
    distance_deviation_km = fields.Float(
        compute="_compute_distance_deviation",
        store=True,
        help="Écart entre distance parcourue et distance de référence -- signalé (L4-04), "
        "jamais corrigé automatiquement.",
    )

    # --- Tarif figé ----------------------------------------------------------------------------
    fare_rule_snapshot = fields.Text(
        help="Détail décomposé de la règle tarifaire au moment du gel (JSON) -- figé sur la "
        "course elle-même, pas seulement référencé (L4-01) : survit à toute modification "
        "ultérieure de la règle d'origine (critère d'acceptation 3).",
    )
    promotion_code = fields.Char(
        help="Remplace un Many2one babana.promotion (L2-06, absent ce soir).",
    )
    discount_amount = fields.Monetary(currency_field="currency_id")
    final_amount = fields.Monetary(currency_field="currency_id")

    # --- Paiement ------------------------------------------------------------------------------
    payment_method = fields.Selection(
        [("cash", "Espèces")], default="cash", required=True, help="D9 : espèces uniquement en v1."
    )
    invoice_id = fields.Many2one("account.move", copy=False, ondelete="restrict")
    settled_at = fields.Datetime()

    # --- Cycle -------------------------------------------------------------------------------
    requested_at = fields.Datetime()
    proposed_at = fields.Datetime()
    assigned_at = fields.Datetime()
    started_at = fields.Datetime()
    completed_at = fields.Datetime()
    cancelled_at = fields.Datetime()
    cancel_reason = fields.Text()
    cancelled_by_user_id = fields.Many2one("res.users", copy=False, ondelete="set null")

    # --- Refus ---------------------------------------------------------------------------------
    rejection_ids = fields.One2many("babana.ride.rejection", "ride_id", string="Refus")

    _sql_constraints = [
        ("babana_ride_reference_unique", "unique(reference)", "La référence de course doit être unique."),
    ]

    @api.depends("actual_distance_km", "reference_distance_km")
    def _compute_distance_deviation(self):
        for record in self:
            record.distance_deviation_km = (
                record.actual_distance_km - record.reference_distance_km
            )

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if not vals.get("reference") or vals.get("reference") == "/":
                vals["reference"] = (
                    self.env["ir.sequence"].next_by_code("babana.ride") or "/"
                )
        return super().create(vals_list)

    def init(self):
        # Contraintes de base de données, pas seulement applicatives (L4-01, critère 2 et 2 bis) :
        # un chauffeur -- ou un client -- ne peut avoir qu'une course dans un état actif, et les
        # deux listes d'états actifs diffèrent (voir DRIVER_ACTIVE_STATES / CLIENT_ACTIVE_STATES
        # ci-dessus). Un index unique partiel n'est pas exprimable via _sql_constraints (qui ne
        # produit que des contraintes de table simples), d'où sa création directe ici.
        driver_states = ", ".join(f"'{state}'" for state in DRIVER_ACTIVE_STATES)
        client_states = ", ".join(f"'{state}'" for state in CLIENT_ACTIVE_STATES)
        # DROP avant CREATE : la liste d'états actifs côté client vient de changer (L4-01R,
        # amoa/questions/REPONSES-2026-08-11.md) -- `CREATE ... IF NOT EXISTS` seul aurait laissé
        # dormir l'ancienne définition sur une base déjà installée, sans `requested`.
        self.env.cr.execute("DROP INDEX IF EXISTS babana_ride_one_active_per_client")
        self.env.cr.execute(
            f"""
            CREATE UNIQUE INDEX IF NOT EXISTS babana_ride_one_active_per_driver
            ON babana_ride (driver_id)
            WHERE state IN ({driver_states}) AND driver_id IS NOT NULL
            """
        )
        self.env.cr.execute(
            f"""
            CREATE UNIQUE INDEX IF NOT EXISTS babana_ride_one_active_per_client
            ON babana_ride (client_id)
            WHERE state IN ({client_states})
            """
        )
        # Index sur la date de création (L4-01, critère 4) : create_date n'est pas indexé par
        # défaut par l'ORM Odoo malgré son usage systématique dans les filtres de L9.
        self.env.cr.execute(
            "CREATE INDEX IF NOT EXISTS babana_ride_create_date_idx ON babana_ride (create_date)"
        )


class BabanaRideRejection(models.Model):
    _name = "babana.ride.rejection"
    _description = "Refus d'une proposition de course (L4-01, C-03)"
    _order = "rejected_at desc"

    ride_id = fields.Many2one(
        "babana.ride", required=True, index=True, ondelete="cascade"
    )
    driver_id = fields.Many2one("babana.driver", required=True, ondelete="restrict")
    reason = fields.Char()
    rejected_at = fields.Datetime(default=lambda self: fields.Datetime.now(), required=True)
