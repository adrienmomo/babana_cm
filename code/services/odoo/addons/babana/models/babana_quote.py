# Estimation d'une course (L2-04). C'est l'objet antérieur à babana.ride dont parle C-03 :
# « draft n'est jamais persisté, l'objet antérieur à la course est l'estimation ». La création
# de course (L4-03R) référence cette estimation plutôt que de recalculer -- c'est ce qui
# garantit que le client paie ce qu'on lui a montré. Le tarif est figé par valeur ici
# (fare_rule_snapshot), même principe que babana.ride (L4-01) : si la grille change entre
# l'estimation et la course, le montant montré reste opposable.
from __future__ import annotations

import uuid

from odoo import fields, models


class BabanaQuote(models.Model):
    _name = "babana.quote"
    _description = "Estimation d'une course (L2-04)"
    _order = "create_date desc"

    public_id = fields.Char(
        string="Identifiant public",
        index=True,
        copy=False,
        default=lambda self: str(uuid.uuid4()),
        help="Identifiant exposé à l'API mobile (quoteId, C-01) -- jamais l'identifiant Odoo "
        "interne, même convention que babana.ride.public_id (L4-03).",
    )
    client_id = fields.Many2one("res.partner", required=True, index=True, ondelete="cascade")

    # --- Géographie ----------------------------------------------------------------------------
    pickup_latitude = fields.Float(required=True, digits=(10, 6))
    pickup_longitude = fields.Float(required=True, digits=(10, 6))
    dropoff_latitude = fields.Float(required=True, digits=(10, 6))
    dropoff_longitude = fields.Float(required=True, digits=(10, 6))
    pickup_zone_id = fields.Many2one("babana.zone", required=True, ondelete="restrict")
    dropoff_zone_id = fields.Many2one("babana.zone", required=True, ondelete="restrict")
    vehicle_class = fields.Selection(
        [("standard", "Standard"), ("premium", "Premium")], default="standard", required=True
    )

    # --- Distance de référence (L2-05) ----------------------------------------------------------
    distance_meters = fields.Integer(
        help="Distance de référence, modèle voiture (É8) -- voir services/routing.py.",
    )
    duration_seconds = fields.Integer(help="Durée brute renvoyée par le routeur, avant correction.")
    eta_seconds = fields.Integer(help="Durée corrigée (facteur L10-03) -- celle affichée au client.")

    # --- Tarif figé (L2-03/L2-01) ----------------------------------------------------------------
    fare_rule_id = fields.Many2one(
        "babana.fare.rule",
        ondelete="set null",
        help="Référence vers la règle qui a servi à cette estimation -- peut pointer vers une "
        "règle supprimée ou archivée sans que l'estimation en souffre : c'est le gel par valeur "
        "ci-dessous qui fait foi pour le montant.",
    )
    fare_rule_snapshot = fields.Text(
        help="Détail décomposé (JSON) au moment de l'estimation -- même convention que "
        "babana.ride.fare_rule_snapshot (L4-01), copié tel quel sur la course à sa création "
        "(L4-03R) pour que le tarif montré reste opposable même si la grille change entre-temps.",
    )
    currency_id = fields.Many2one(
        "res.currency", default=lambda self: self.env.company.currency_id.id, required=True
    )
    amount = fields.Monetary(currency_field="currency_id")

    promo_code = fields.Char()
    promo_applied = fields.Boolean(
        help="Faux si aucun code n'a été fourni, ou si le code fourni est invalide -- "
        "babana.promotion (L2-06) n'existe pas encore, donc toujours faux pour l'instant "
        "(amoa/questions/L2-04.md). Le champ existe déjà pour que L2-06 n'ait qu'à brancher sa "
        "résolution, pas à le créer.",
    )
    discount_amount = fields.Monetary(currency_field="currency_id")

    expires_at = fields.Datetime(
        required=True,
        index=True,
        help="Durée de validité configurable (babana.quote_validity_seconds), de l'ordre de "
        "quelques minutes -- sans expiration, un client peut estimer aux heures creuses et "
        "commander aux heures de pointe.",
    )

    _sql_constraints = [
        (
            "babana_quote_public_id_unique",
            "unique(public_id)",
            "Collision d'identifiant public d'estimation -- ne devrait jamais se produire (UUID).",
        ),
    ]

    def is_expired(self) -> bool:
        self.ensure_one()
        return bool(self.expires_at) and fields.Datetime.now() > self.expires_at
