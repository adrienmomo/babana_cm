from odoo import _, api, fields, models
from odoo.exceptions import ValidationError

from .babana_ride_state import NO_SHOW_GRACE_DEFAULT, NO_SHOW_GRACE_PARAM
from .babana_phone_verification import OTP_TTL_SECONDS_FALLBACK, OTP_TTL_SECONDS_PARAM
from .babana_quote import QUOTE_VALIDITY_DEFAULT, QUOTE_VALIDITY_PARAM


class ResConfigSettings(models.TransientModel):
    """Paramètres > Babana : les délais d'une course, modifiables par un administrateur sans le
    mode développeur. Chaque champ EST l'`ir.config_parameter` que le code lit déjà
    (`config_parameter=`) -- aucune seconde source de vérité, aucune migration.

    Seuls les délais tenus par Odoo y figurent. Ceux du service temps réel (délai d'acceptation
    d'une proposition, cadences de diffusion) vivent dans son environnement : les afficher ici
    laisserait croire qu'on les règle d'ici (canal de configuration Odoo -> temps réel, L3-15,
    jamais construit)."""

    _inherit = "res.config.settings"

    babana_no_show_grace_seconds = fields.Integer(
        string="Attente avant « client absent » (secondes)",
        config_parameter=NO_SHOW_GRACE_PARAM,
        default=NO_SHOW_GRACE_DEFAULT,
        help="Compté depuis « Sur place ». Passé ce délai, le chauffeur peut annuler pour client absent.",
    )
    babana_quote_validity_seconds = fields.Integer(
        string="Validité d'une estimation (secondes)",
        config_parameter=QUOTE_VALIDITY_PARAM,
        default=QUOTE_VALIDITY_DEFAULT,
        help="Au-delà, le client doit redemander un prix avant de commander.",
    )
    babana_otp_ttl_seconds = fields.Integer(
        string="Validité d'un code SMS (secondes)",
        config_parameter=OTP_TTL_SECONDS_PARAM,
        default=OTP_TTL_SECONDS_FALLBACK,
        help="Durée pendant laquelle le code de connexion reçu par SMS est accepté.",
    )

    @api.constrains("babana_no_show_grace_seconds", "babana_quote_validity_seconds", "babana_otp_ttl_seconds")
    def _check_babana_delays_positive(self):
        for settings in self:
            for name in ("babana_no_show_grace_seconds", "babana_quote_validity_seconds", "babana_otp_ttl_seconds"):
                if settings[name] <= 0:
                    raise ValidationError(_("Un délai doit être strictement positif : %s.", settings._fields[name].string))
