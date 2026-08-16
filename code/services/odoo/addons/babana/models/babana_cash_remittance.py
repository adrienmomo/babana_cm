# Remise de caisse chauffeur (D8, L5-03). Le chauffeur déclare ce qu'il remet (L5-04), un
# superviseur compte et valide -- la double saisie est ce qui rend un écart détectable. Ce
# fichier ne porte, pour l'instant (L5-03), que le modèle et le gel à la création : les
# transitions (action_declare, action_validate) sont ajoutées par L5-04, dans ce même fichier.
from __future__ import annotations

import uuid

from odoo import api, fields, models
from odoo.exceptions import UserError


class BabanaCashRemittance(models.Model):
    _name = "babana.cash.remittance"
    _description = "Remise de caisse chauffeur (D8, L5-03)"
    _order = "create_date desc, id desc"

    reference = fields.Char(
        required=True, copy=False, default="/", readonly=True,
        help="Référence humaine, par séquence (babana.cash.remittance) -- distincte de public_id "
        "(UUID, exposé à l'API mobile, C-01), même partition que babana.ride.",
    )
    public_id = fields.Char(
        index=True,
        copy=False,
        default=lambda self: str(uuid.uuid4()),
        help="Identifiant exposé à l'API mobile (CreateRemittanceResponseSchema, C-01) -- jamais "
        "l'identifiant Odoo interne, même règle que babana.ride.public_id et "
        "babana.driver.public_id (posée le 15 août).",
    )
    driver_id = fields.Many2one("babana.driver", required=True, index=True, ondelete="restrict")
    currency_id = fields.Many2one(
        "res.currency",
        required=True,
        default=lambda self: self.env.company.currency_id.id,
    )
    expected_amount = fields.Monetary(
        string="Montant attendu",
        currency_field="currency_id",
        readonly=True,
        help="Solde du chauffeur au moment de la création de la remise (critère d'acceptation "
        "1) -- figé une fois pour toutes par create(), jamais recalculé même si le solde change "
        "ensuite. Une course encaissée après cet instant n'y est donc jamais incluse (critère 2).",
    )
    declared_amount = fields.Monetary(
        string="Montant déclaré",
        currency_field="currency_id",
        help="Ce que le chauffeur annonce remettre (L5-04) -- saisi une fois, à la création.",
    )
    counted_amount = fields.Monetary(
        string="Montant compté",
        currency_field="currency_id",
        help="Ce que le superviseur compte réellement (L5-04) -- vide tant que la remise n'est "
        "pas validée ou contestée.",
    )
    discrepancy_amount = fields.Monetary(
        string="Écart",
        currency_field="currency_id",
        compute="_compute_discrepancy_amount",
        store=True,
        help="expected_amount - counted_amount, calculé, jamais saisi (critère d'acceptation 3) "
        "-- 0 tant que counted_amount n'a pas été renseigné (avant validation). Ne devient "
        "jamais négatif en pratique : une remise qui ferait passer le solde sous zéro est "
        "refusée par le mouvement de compte courant qu'elle tenterait de créer (L5-01, critère "
        "4) -- babana_cash_movement.py::_check_collection_and_remittance_never_go_negative.",
    )
    state = fields.Selection(
        [
            ("draft", "Brouillon"),
            ("declared", "Déclarée"),
            ("validated", "Validée"),
            ("disputed", "Contestée"),
        ],
        default="draft",
        required=True,
        help="'draft' n'est jamais atteint par le chemin normal (L5-04, action_declare crée "
        "directement en 'declared') -- conservé pour compléter l'énumération de la "
        "spécification (L5-03) et pour un usage back-office futur non prévu par ce lot.",
    )
    supervisor_id = fields.Many2one("res.users", ondelete="restrict")
    declared_at = fields.Datetime()
    validated_at = fields.Datetime()
    discrepancy_reason = fields.Text(
        help="Motif libre, renseignable par le superviseur à la validation. Distinct du "
        "traitement structuré de l'écart (babana.cash.discrepancy, L5-06), qui porte son "
        "propre motif catégorisé et sa propre exigence de clôture motivée.",
    )
    move_id = fields.Many2one(
        "account.move",
        copy=False,
        ondelete="restrict",
        help="Pièce comptable de la validation (L5-05) -- vide tant que la remise n'est pas "
        "validée. La pièce référence la remise en retour (account_move.py, L5-05) : référence "
        "mutuelle (critère d'acceptation 4 de L5-05).",
    )
    covered_movement_ids = fields.Many2many(
        "babana.cash.movement",
        string="Encaissements couverts",
        help="Mouvements de type 'collection' composant le solde attendu, gelés à la création "
        "(critère d'acceptation 5) -- jamais recalculés. Un encaissement déjà couvert par une "
        "remise précédente n'est jamais couvert deux fois (create(), ci-dessous).",
    )
    ride_ids = fields.Many2many(
        "babana.ride",
        compute="_compute_ride_ids",
        string="Courses couvertes",
        help="Dérivé de covered_movement_ids.ride_id -- 'on doit pouvoir dire quelles courses "
        "ont été réglées par quelle remise' (spécification L5-03).",
    )

    _sql_constraints = [
        (
            "babana_cash_remittance_public_id_unique",
            "unique(public_id)",
            "Collision d'identifiant public de remise -- ne devrait jamais se produire (UUID).",
        ),
    ]

    @api.depends("covered_movement_ids.ride_id")
    def _compute_ride_ids(self):
        for record in self:
            record.ride_ids = record.covered_movement_ids.ride_id

    @api.depends("counted_amount", "expected_amount", "state")
    def _compute_discrepancy_amount(self):
        for record in self:
            if record.state in ("validated", "disputed"):
                record.discrepancy_amount = record.expected_amount - record.counted_amount
            else:
                record.discrepancy_amount = 0.0

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            driver_id = vals.get("driver_id")
            if not driver_id:
                raise UserError("driver_id est requis pour créer une remise de caisse.")
            driver = self.env["babana.driver"].browse(driver_id)

            if not vals.get("reference") or vals.get("reference") == "/":
                vals["reference"] = self.env["ir.sequence"].next_by_code(
                    "babana.cash.remittance"
                ) or "/"
            vals.setdefault("currency_id", driver.currency_id.id)

            # Gel à la création (critère d'acceptation 1) : le solde ET les encaissements qui le
            # composent, jamais recalculés ensuite -- _babana_cash_balance() plutôt que
            # driver.cash_balance (le champ calculé, en cache) pour la même raison que
            # babana_cash_movement.py le fait déjà : on veut la somme réelle à cet instant.
            vals["expected_amount"] = driver._babana_cash_balance()

            already_covered_ids = (
                self.sudo()
                .search([("driver_id", "=", driver_id)])
                .covered_movement_ids.ids
            )
            movements = self.env["babana.cash.movement"].sudo().search(
                [
                    ("driver_id", "=", driver_id),
                    ("movement_type", "=", "collection"),
                    ("id", "not in", already_covered_ids),
                ]
            )
            vals["covered_movement_ids"] = [(6, 0, movements.ids)]
        return super().create(vals_list)

    def write(self, vals):
        for record in self:
            if record.state == "validated" and vals:
                raise UserError(
                    "Remise validée : plus aucune modification n'est permise (critère "
                    "d'acceptation 4, L5-03)."
                )
        if "expected_amount" in vals:
            raise UserError(
                "expected_amount est figé à la création, jamais réécrit ensuite (critère "
                "d'acceptation 1, L5-03)."
            )
        return super().write(vals)
