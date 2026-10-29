from odoo import _, api, fields, models
from odoo.exceptions import ValidationError

from .babana_ride_state import NO_SHOW_GRACE_DEFAULT, NO_SHOW_GRACE_PARAM
from .babana_phone_verification import OTP_TTL_SECONDS_FALLBACK, OTP_TTL_SECONDS_PARAM
from .babana_quote import QUOTE_VALIDITY_DEFAULT, QUOTE_VALIDITY_PARAM
from ..services.approach import (
    APPROACH_SAMPLE_SIZE_DEFAULT,
    APPROACH_SAMPLE_SIZE_PARAM,
    DEFAULT_APPROACH_DISTANCE_DEFAULT,
    DEFAULT_APPROACH_DISTANCE_PARAM,
)
from ..services.dispatch import (
    DISPATCH_MAX_ATTEMPTS_DEFAULT,
    DISPATCH_MAX_ATTEMPTS_PARAM,
    DISPATCH_RADIUS_DEFAULT,
    DISPATCH_RADIUS_PARAM,
)


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

    babana_dispatch_radius_meters = fields.Integer(
        string="Rayon de recherche d'un chauffeur (mètres)",
        config_parameter=DISPATCH_RADIUS_PARAM,
        default=DISPATCH_RADIUS_DEFAULT,
        help="La course part au chauffeur disponible le plus proche par la route, parmi ceux de ce rayon.",
    )
    babana_approach_sample_size = fields.Integer(
        string="Chauffeurs mesurés par la route",
        config_parameter=APPROACH_SAMPLE_SIZE_PARAM,
        default=APPROACH_SAMPLE_SIZE_DEFAULT,
        help="Les plus proches à vol d'oiseau dont la distance routière est mesurée : pour choisir "
        "le chauffeur, et pour la prise en charge moyenne de l'estimation. Un appel de routage par "
        "chauffeur.",
    )
    babana_default_approach_distance_meters = fields.Integer(
        string="Distance d'approche de repli (mètres)",
        config_parameter=DEFAULT_APPROACH_DISTANCE_PARAM,
        default=DEFAULT_APPROACH_DISTANCE_DEFAULT,
        help="Prise en charge facturée sur cette distance quand aucun chauffeur disponible n'est "
        "mesurable au moment de l'estimation.",
    )
    babana_dispatch_max_attempts = fields.Integer(
        string="Chauffeurs sollicités par demande",
        config_parameter=DISPATCH_MAX_ATTEMPTS_PARAM,
        default=DISPATCH_MAX_ATTEMPTS_DEFAULT,
        help="Après autant de refus ou d'absences de réponse, le client est prévenu qu'aucun chauffeur n'est disponible.",
    )

    _BABANA_POSITIVE_FIELDS = (
        "babana_no_show_grace_seconds",
        "babana_quote_validity_seconds",
        "babana_otp_ttl_seconds",
        "babana_dispatch_radius_meters",
        "babana_dispatch_max_attempts",
        "babana_approach_sample_size",
        "babana_default_approach_distance_meters",
    )

    @api.constrains(*_BABANA_POSITIVE_FIELDS)
    def _check_babana_delays_positive(self):
        for settings in self:
            for name in self._BABANA_POSITIVE_FIELDS:
                if settings[name] <= 0:
                    raise ValidationError(_("Une valeur doit être strictement positive : %s.", settings._fields[name].string))
