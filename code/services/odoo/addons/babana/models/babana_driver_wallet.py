# Solde prépayé du chauffeur (15 novembre, demande du maître d'ouvrage) : le chauffeur recharge en
# espèces à l'agence (le back-office l'enregistre), chaque course terminée débite une commission en
# pourcentage de son prix, et à 0 FCFA ou moins il ne peut plus passer en ligne. Le plafond
# d'encaisse (D8, babana.cash.movement) reste : ce sont deux comptes distincts.
#
# **Modifie D5** (« chauffeurs salariés en phase 1, commission en phase ultérieure ») : proposé au
# débrief dans le rapport du 15 novembre, pas tranché ici.
#
# Journal immuable, comme le compte courant (L5-01) : jamais modifié ni supprimé ; une erreur se
# corrige par un ajustement. Une écriture par recharge (geste du back-office) et par course terminée
# (la décision du chauffeur de terminer) -- jamais par le temps ni la distance (invariant 1).
from __future__ import annotations

from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError

COMMISSION_RATE_PARAM = "babana.commission_rate_percent"
COMMISSION_RATE_DEFAULT = 10.0
MIN_BALANCE_PARAM = "babana.wallet_min_balance"
MIN_BALANCE_DEFAULT = 0

MOVEMENT_TYPES = [
    ("topup", "Recharge"),
    ("commission", "Commission de course"),
    ("adjustment", "Ajustement"),
]


class BabanaDriverWalletMovement(models.Model):
    _name = "babana.driver.wallet.movement"
    _description = "Mouvement du solde prépayé du chauffeur"
    _order = "create_date desc, id desc"

    driver_id = fields.Many2one("babana.driver", required=True, index=True, ondelete="restrict", string="Chauffeur")
    movement_type = fields.Selection(MOVEMENT_TYPES, string="Type", required=True, readonly=True)
    amount = fields.Monetary(
        string="Montant",
        currency_field="currency_id",
        required=True,
        readonly=True,
        help="Positif pour une recharge, négatif pour une commission ; un ajustement peut être l'un ou l'autre.",
    )
    currency_id = fields.Many2one("res.currency", required=True, readonly=True, default=lambda self: self.env.ref("base.XAF"))
    ride_id = fields.Many2one("babana.ride", string="Course", readonly=True, index=True, ondelete="restrict")
    reference = fields.Char(string="Référence (reçu)", readonly=True)
    note = fields.Text(string="Motif", readonly=True)
    recorded_by_id = fields.Many2one("res.users", string="Enregistré par", readonly=True, default=lambda self: self.env.uid)

    @api.constrains("movement_type", "amount", "ride_id", "note")
    def _check_shape(self):
        for record in self:
            if record.movement_type == "topup" and record.amount <= 0:
                raise ValidationError("Une recharge est un montant positif.")
            if record.movement_type == "commission" and (record.amount > 0 or not record.ride_id):
                raise ValidationError("Une commission est un débit, rattaché à une course.")
            if record.movement_type == "adjustment" and not (record.note or "").strip():
                raise ValidationError("Un ajustement dit pourquoi.")

    @api.constrains("ride_id", "movement_type")
    def _check_one_commission_per_ride(self):
        for record in self.filtered(lambda r: r.movement_type == "commission"):
            if self.search_count([("ride_id", "=", record.ride_id.id), ("movement_type", "=", "commission")]) > 1:
                raise ValidationError("Une course n'est commissionnée qu'une fois.")

    def write(self, vals):
        raise UserError("Un mouvement du solde prépayé ne se modifie pas : corrigez par un ajustement.")

    def unlink(self):
        raise UserError("Un mouvement du solde prépayé ne se supprime pas : corrigez par un ajustement.")

    @api.model
    def _commission_rate(self) -> float:
        try:
            rate = float(self.env["ir.config_parameter"].sudo().get_param(COMMISSION_RATE_PARAM, COMMISSION_RATE_DEFAULT))
        except (TypeError, ValueError):
            return COMMISSION_RATE_DEFAULT
        return rate if 0 <= rate <= 100 else COMMISSION_RATE_DEFAULT

    @api.model
    def _min_balance(self) -> int:
        try:
            return int(self.env["ir.config_parameter"].sudo().get_param(MIN_BALANCE_PARAM, MIN_BALANCE_DEFAULT))
        except (TypeError, ValueError):
            return MIN_BALANCE_DEFAULT

    @api.model
    def _babana_charge_commission(self, ride, final_amount):
        """Fin de course : la commission, en pourcentage du prix final (arrondi au franc), débitée
        dans la même transaction que la transition. Rien si le taux ou le prix est nul."""
        commission = round((final_amount or 0) * self._commission_rate() / 100)
        if commission <= 0 or not ride.driver_id:
            return self.browse()
        return self.sudo().create(
            {"driver_id": ride.driver_id.id, "movement_type": "commission", "amount": -commission, "ride_id": ride.id}
        )


class BabanaDriverWalletTopupWizard(models.TransientModel):
    """Recharge en espèces à l'agence : le gestionnaire saisit le montant reçu et le numéro du reçu."""

    _name = "babana.driver.wallet.topup.wizard"
    _description = "Recharge du solde prépayé"

    driver_id = fields.Many2one("babana.driver", required=True)
    amount = fields.Integer(string="Montant reçu (FCFA)", required=True)
    reference = fields.Char(string="Numéro du reçu", required=True)

    def action_confirm(self):
        self.ensure_one()
        if self.amount <= 0:
            raise ValidationError("Le montant d'une recharge est positif.")
        self.env["babana.driver.wallet.movement"].create(
            {"driver_id": self.driver_id.id, "movement_type": "topup", "amount": self.amount, "reference": self.reference}
        )
        self.driver_id.message_post(body="Solde rechargé de %s FCFA (reçu %s)." % (self.amount, self.reference))
        return {"type": "ir.actions.act_window_close"}
