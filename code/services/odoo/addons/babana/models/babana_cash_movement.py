# Journal du compte courant chauffeur (D8, L5-01). Chaque encaissement espèces (L4-05) crée un
# mouvement `collection` positif ; chaque remise validée (L5-04, hors de ce lot) créera un
# mouvement `remittance` négatif ; les ajustements (`adjustment`) sont réservés au back-office,
# motif obligatoire.
#
# **Le solde n'est jamais écrit directement** (critère d'acceptation 1) : babana.driver.
# cash_balance (déjà un champ calculé sans inverse fonctionnel, [PONT -- remplacé par L5-01],
# code/docs/bridge-fields.md) somme désormais ces mouvements -- voir _babana_driver.py::
# _compute_cash_balance. Un solde stocké librement peut diverger de son historique ; c'est
# exactement ce que ce modèle empêche.
from __future__ import annotations

from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError


class BabanaCashMovement(models.Model):
    _name = "babana.cash.movement"
    _description = "Mouvement du compte courant chauffeur (D8)"
    _order = "create_date desc, id desc"

    driver_id = fields.Many2one("babana.driver", required=True, index=True, ondelete="restrict")
    movement_type = fields.Selection(
        [
            ("collection", "Encaissement"),
            ("remittance", "Remise"),
            ("adjustment", "Ajustement"),
        ],
        string="Type de mouvement",
        required=True,
    )
    amount = fields.Monetary(
        string="Montant",
        currency_field="currency_id",
        required=True,
        help="Signé : positif pour un encaissement, négatif pour une remise. Un ajustement peut "
        "porter l'un ou l'autre signe selon le sens de la correction.",
    )
    currency_id = fields.Many2one(
        "res.currency",
        required=True,
        default=lambda self: self.env.company.currency_id.id,
    )
    ride_id = fields.Many2one(
        "babana.ride",
        string="Course",
        ondelete="restrict",
        help="Course à l'origine d'un mouvement `collection`. Vide pour une remise ou un "
        "ajustement -- babana.cash.remittance (L5-03) porte la référence équivalente pour les "
        "remises (covered_movement_ids).",
    )
    discrepancy_id = fields.Many2one(
        "babana.cash.discrepancy",
        ondelete="restrict",
        help="Écart à l'origine d'un mouvement `adjustment` produit par un traitement explicite "
        "(L5-06, babana.cash.discrepancy::action_close) -- vide pour tout autre mouvement, y "
        "compris un ajustement posé directement au back-office sans écart associé.",
    )
    reason = fields.Text(
        string="Motif",
        help="Obligatoire pour un ajustement (critère d'acceptation 5) -- une correction sans "
        "motif n'est pas traçable, seulement chiffrée.",
    )

    _sql_constraints = [
        (
            "babana_cash_movement_amount_not_zero",
            "check(amount != 0)",
            "Un mouvement de compte courant à zéro n'a pas de sens.",
        ),
    ]

    @api.constrains("movement_type", "amount")
    def _check_amount_sign_matches_type(self):
        for record in self:
            if record.movement_type == "collection" and record.amount <= 0:
                raise ValidationError("Un encaissement doit être un montant strictement positif.")
            if record.movement_type == "remittance" and record.amount >= 0:
                raise ValidationError("Une remise doit être un montant strictement négatif.")

    @api.constrains("movement_type", "reason")
    def _check_adjustment_requires_reason(self):
        for record in self:
            if record.movement_type == "adjustment" and not (record.reason or "").strip():
                raise ValidationError(
                    "Un ajustement de compte courant exige un motif (critère d'acceptation 5)."
                )

    @api.constrains("driver_id", "movement_type", "amount")
    def _check_collection_and_remittance_never_go_negative(self):
        # Critère d'acceptation 4 : une remise supérieure au solde est refusée -- signale une
        # erreur de saisie, à orienter vers le traitement d'écart (L5-06, hors de ce lot). Un
        # encaissement (toujours positif) ne peut jamais faire baisser le solde ; cette
        # vérification ne se déclenche donc en pratique que sur une remise, mais elle est écrite
        # de façon générique plutôt que spécifique au type -- la même règle s'applique aux deux.
        #
        # "Seul un ajustement explicite peut produire un solde négatif" (spécification) :
        # délibérément absent de cette contrainte, jamais vérifié ici pour movement_type ==
        # 'adjustment'.
        for record in self:
            if record.movement_type not in ("collection", "remittance"):
                continue
            balance = record.driver_id._babana_cash_balance()
            if balance < 0:
                raise UserError(
                    "Ce mouvement ferait passer le solde du chauffeur sous zéro -- une remise "
                    "supérieure au solde signale une erreur de saisie (L5-01, critère 4 ; "
                    "traitement d'écart, L5-06)."
                )

    def write(self, vals):
        raise UserError(
            "Un mouvement de compte courant est immuable : ni modification, ni suppression, "
            "même pour un administrateur (D8, L5-01). Une erreur se corrige par un mouvement "
            "d'ajustement inverse, jamais par réécriture."
        )

    def unlink(self):
        raise UserError(
            "Un mouvement de compte courant est immuable : ni modification, ni suppression, "
            "même pour un administrateur (D8, L5-01)."
        )
