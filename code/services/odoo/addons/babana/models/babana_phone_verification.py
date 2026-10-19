# Vérification de numéro par OTP (L1-09) -- attributs seulement : la logique (génération du code,
# envoi SMS, limites, confirmation) arrive avec les contrôleurs /phone/verify/*.
#
# Une ligne = une vérification EN COURS. Le numéro n'atteint res.partner.babana_phone qu'à la
# confirmation ; la ligne est alors supprimée (L1-09). Le code n'est jamais stocké en clair.
from __future__ import annotations

from odoo import fields, models


class BabanaPhoneVerification(models.Model):
    _name = "babana.phone.verification"
    _description = "Vérification de numéro par OTP en cours (L1-09)"

    partner_id = fields.Many2one(
        "res.partner",
        string="Compte",
        required=True,
        index=True,
        ondelete="cascade",
    )
    phone = fields.Char(
        string="Numéro (E.164)",
        required=True,
        index=True,
        help="Numéro à vérifier, format international (+237...).",
    )
    code_hash = fields.Char(
        string="Empreinte du code",
        required=True,
        help="Haché salé du code numérique envoyé par SMS. Le code lui-même n'est ni stocké, ni "
        "renvoyé par l'API, ni journalisé en production.",
    )
    expires_at = fields.Datetime(string="Expire le", required=True)
    attempts = fields.Integer(
        string="Tentatives",
        default=0,
        help="Confirmations échouées. Au-delà du plafond (paramètre système), la vérification est "
        "annulée et il faut en redemander une.",
    )
