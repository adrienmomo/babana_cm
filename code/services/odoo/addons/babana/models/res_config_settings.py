from odoo import _, api, fields, models
from odoo.exceptions import ValidationError

from .babana_ride_state import NO_SHOW_GRACE_DEFAULT, NO_SHOW_GRACE_PARAM
from .babana_phone_verification import OTP_TTL_SECONDS_FALLBACK, OTP_TTL_SECONDS_PARAM
from .babana_quote import QUOTE_VALIDITY_DEFAULT, QUOTE_VALIDITY_PARAM
from .babana_rating import RATING_MIN_COUNT_DEFAULT, RATING_MIN_COUNT_PARAM
from ..services.approach import (
    APPROACH_SAMPLE_SIZE_DEFAULT,
    APPROACH_SAMPLE_SIZE_PARAM,
    DEFAULT_APPROACH_DISTANCE_DEFAULT,
    DEFAULT_APPROACH_DISTANCE_PARAM,
)
from ..services import priority, stops
from ..services.dispatch import (
    PROPOSAL_WINDOW_DEFAULT,
    PROPOSAL_WINDOW_PARAM,
    DISPATCH_MAX_ATTEMPTS_DEFAULT,
    DISPATCH_MAX_ATTEMPTS_PARAM,
    DISPATCH_RADIUS_DEFAULT,
    DISPATCH_RADIUS_PARAM,
    DISPATCH_RADIUS_STEP_DEFAULT,
    DISPATCH_RADIUS_STEP_PARAM,
    DISPATCH_WIDENING_DELAY_DEFAULT,
    DISPATCH_WIDENING_DELAY_PARAM,
    DISPATCH_WIDENINGS_DEFAULT,
    DISPATCH_WIDENINGS_PARAM,
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
        string="Premier rayon de recherche (mètres)",
        config_parameter=DISPATCH_RADIUS_PARAM,
        default=DISPATCH_RADIUS_DEFAULT,
        help="La course est d'abord cherchée parmi les chauffeurs disponibles de ce rayon (ordre : Priorité des chauffeurs).",
    )
    babana_dispatch_radius_step_meters = fields.Integer(
        string="Élargissement du rayon (mètres)",
        config_parameter=DISPATCH_RADIUS_STEP_PARAM,
        default=DISPATCH_RADIUS_STEP_DEFAULT,
        help="Personne dans le rayon courant : la recherche suivante va aussi loin plus ce pas.",
    )
    babana_dispatch_widenings = fields.Integer(
        string="Élargissements avant « aucun chauffeur »",
        config_parameter=DISPATCH_WIDENINGS_PARAM,
        default=DISPATCH_WIDENINGS_DEFAULT,
        help="Nombre de recherches dans un rayon élargi après la première. 0 : une seule recherche.",
    )
    babana_dispatch_widening_delay_seconds = fields.Integer(
        string="Délai avant chaque élargissement (secondes)",
        config_parameter=DISPATCH_WIDENING_DELAY_PARAM,
        default=DISPATCH_WIDENING_DELAY_DEFAULT,
        help="Le temps laissé à un chauffeur pour se libérer ou se mettre en ligne avant d'élargir.",
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

    babana_proposal_window_seconds = fields.Integer(
        string="Délai d'acceptation par le chauffeur (secondes)",
        config_parameter=PROPOSAL_WINDOW_PARAM,
        default=PROPOSAL_WINDOW_DEFAULT,
        help="Temps laissé au chauffeur pour glisser « Accepter ». Passé ce délai, la course part au "
        "chauffeur suivant.",
    )

    babana_rating_min_count = fields.Integer(
        string="Avis avant d'afficher une note",
        config_parameter=RATING_MIN_COUNT_PARAM,
        default=RATING_MIN_COUNT_DEFAULT,
        help="En dessous, le chauffeur est présenté comme « nouveau » plutôt qu'avec une moyenne "
        "peu significative.",
    )

    # --- Priorité des chauffeurs (19 novembre, services/priority.py) -------------------------
    babana_priority_radius_meters = fields.Integer(
        string="Rayon de priorité (mètres)",
        config_parameter=priority.PRIORITY_RADIUS_PARAM,
        default=priority.PRIORITY_RADIUS_DEFAULT,
        help="À moins de cette distance du client (à vol d'oiseau), la course va au chauffeur le plus prioritaire ; au-delà, au plus proche par la route.",
    )
    babana_priority_ride_points_max = fields.Integer(
        string="Points de course (maximum)",
        config_parameter=priority.RIDE_POINTS_MAX_PARAM,
        default=priority.RIDE_POINTS_MAX_DEFAULT,
        help="Points de départ d'un chauffeur, et plafond qu'une course terminée ne fait jamais dépasser.",
    )
    babana_priority_miss_penalty = fields.Integer(
        string="Points perdus par course non acceptée",
        config_parameter=priority.MISS_PENALTY_PARAM,
        default=priority.MISS_PENALTY_DEFAULT,
        help="Retirés à chaque proposition qui expire sans acceptation.",
    )
    babana_priority_completion_reward = fields.Integer(
        string="Points regagnés par course terminée",
        config_parameter=priority.COMPLETION_REWARD_PARAM,
        default=priority.COMPLETION_REWARD_DEFAULT,
        help="Rendus à chaque fin de course, sans dépasser le maximum.",
    )
    babana_priority_new_driver_points = fields.Integer(
        string="Bonus « nouveau chauffeur » (points)",
        config_parameter=priority.NEW_DRIVER_POINTS_PARAM,
        default=priority.NEW_DRIVER_POINTS_DEFAULT,
        help="Ajoutés pendant la période qui suit l'approbation du dossier.",
    )
    babana_priority_new_driver_days = fields.Integer(
        string="Période « nouveau chauffeur » (jours)",
        config_parameter=priority.NEW_DRIVER_DAYS_PARAM,
        default=priority.NEW_DRIVER_DAYS_DEFAULT,
        help="Comptée depuis la première approbation du dossier.",
    )
    babana_priority_star_high_threshold = fields.Float(
        string="Note du palier haut",
        config_parameter=priority.STAR_HIGH_THRESHOLD_PARAM,
        default=priority.STAR_HIGH_THRESHOLD_DEFAULT,
        help="Note lissée strictement au-dessus de laquelle le chauffeur reçoit les points du palier haut.",
    )
    babana_priority_star_high_points = fields.Integer(
        string="Points du palier haut",
        config_parameter=priority.STAR_HIGH_POINTS_PARAM,
        default=priority.STAR_HIGH_POINTS_DEFAULT,
    )
    babana_priority_star_mid_threshold = fields.Float(
        string="Note du palier moyen",
        config_parameter=priority.STAR_MID_THRESHOLD_PARAM,
        default=priority.STAR_MID_THRESHOLD_DEFAULT,
        help="Note lissée strictement au-dessus de laquelle le chauffeur reçoit les points du palier moyen.",
    )
    babana_priority_star_mid_points = fields.Integer(
        string="Points du palier moyen",
        config_parameter=priority.STAR_MID_POINTS_PARAM,
        default=priority.STAR_MID_POINTS_DEFAULT,
    )
    babana_priority_star_prior_count = fields.Integer(
        string="Notes imaginaires de départ",
        config_parameter=priority.STAR_PRIOR_COUNT_PARAM,
        default=priority.STAR_PRIOR_COUNT_DEFAULT,
        help="Comptées dans la moyenne de chaque chauffeur, pour que quelques avis ne décident pas seuls de ses points.",
    )
    babana_priority_star_prior_value = fields.Float(
        string="Valeur des notes imaginaires",
        config_parameter=priority.STAR_PRIOR_VALUE_PARAM,
        default=priority.STAR_PRIOR_VALUE_DEFAULT,
    )
    babana_priority_max_total = fields.Integer(
        string="Priorité maximale (points)",
        config_parameter=priority.MAX_TOTAL_PARAM,
        default=priority.MAX_TOTAL_DEFAULT,
        help="Plafond du total des trois sortes de points.",
    )
    babana_priority_candidate_limit = fields.Integer(
        string="Chauffeurs classés par demande",
        config_parameter=priority.CANDIDATE_LIMIT_PARAM,
        default=priority.CANDIDATE_LIMIT_DEFAULT,
        help="Les plus proches du cercle de recherche lus pour le classement de priorité.",
    )

    # --- Arrêts (L2-08) ----------------------------------------------------------------------
    babana_max_stops_per_ride = fields.Integer(
        string="Arrêts par course (maximum)",
        config_parameter=stops.MAX_STOPS_PARAM,
        default=stops.MAX_STOPS_DEFAULT,
        help="Arrêts intermédiaires qu'un client peut demander, à la commande et en cours de course.",
    )
    babana_stop_arrival_radius_m = fields.Integer(
        string="Rayon d'arrivée à un arrêt (mètres)",
        config_parameter=stops.ARRIVAL_RADIUS_PARAM,
        default=stops.ARRIVAL_RADIUS_DEFAULT,
        help="L'app chauffeur déclare l'arrivée d'elle-même à cette distance de l'arrêt.",
    )
    babana_stop_departure_distance_m = fields.Integer(
        string="Départ d'un arrêt : distance (mètres)",
        config_parameter=stops.DEPARTURE_DISTANCE_PARAM,
        default=stops.DEPARTURE_DISTANCE_DEFAULT,
        help="Avec la vitesse et la durée ci-dessous : la moto est repartie, l'attente s'arrête.",
    )
    babana_stop_departure_speed_kmh = fields.Integer(
        string="Départ d'un arrêt : vitesse (km/h)",
        config_parameter=stops.DEPARTURE_SPEED_PARAM,
        default=stops.DEPARTURE_SPEED_DEFAULT,
    )
    babana_stop_departure_duration_s = fields.Integer(
        string="Départ d'un arrêt : durée (secondes)",
        config_parameter=stops.DEPARTURE_DURATION_PARAM,
        default=stops.DEPARTURE_DURATION_DEFAULT,
    )

    _BABANA_POSITIVE_FIELDS = (
        "babana_no_show_grace_seconds",
        "babana_quote_validity_seconds",
        "babana_otp_ttl_seconds",
        "babana_dispatch_radius_meters",
        "babana_dispatch_radius_step_meters",
        "babana_dispatch_widening_delay_seconds",
        "babana_dispatch_max_attempts",
        "babana_proposal_window_seconds",
        "babana_approach_sample_size",
        "babana_default_approach_distance_meters",
        "babana_rating_min_count",
        "babana_stop_arrival_radius_m",
        "babana_stop_departure_distance_m",
        "babana_stop_departure_speed_kmh",
        "babana_stop_departure_duration_s",
        "babana_priority_radius_meters",
        "babana_priority_ride_points_max",
        "babana_priority_star_high_threshold",
        "babana_priority_star_mid_threshold",
        "babana_priority_star_prior_value",
        "babana_priority_max_total",
        "babana_priority_candidate_limit",
    )
    _BABANA_NON_NEGATIVE_FIELDS = (
        "babana_priority_miss_penalty",
        "babana_priority_completion_reward",
        "babana_priority_new_driver_points",
        "babana_priority_new_driver_days",
        "babana_priority_star_high_points",
        "babana_priority_star_mid_points",
        "babana_priority_star_prior_count",
    )

    @api.constrains("babana_dispatch_widenings", "babana_max_stops_per_ride")
    def _check_babana_widenings_not_negative(self):
        for settings in self:
            if settings.babana_max_stops_per_ride < 0:
                raise ValidationError(_("Le nombre d'arrêts maximal ne peut pas être négatif."))
            if settings.babana_dispatch_widenings < 0:
                raise ValidationError(_("Le nombre d'élargissements ne peut pas être négatif."))

    @api.constrains(*_BABANA_POSITIVE_FIELDS)
    def _check_babana_delays_positive(self):
        for settings in self:
            for name in self._BABANA_POSITIVE_FIELDS:
                if settings[name] <= 0:
                    raise ValidationError(_("Une valeur doit être strictement positive : %s.", settings._fields[name].string))

    @api.constrains(*_BABANA_NON_NEGATIVE_FIELDS)
    def _check_babana_non_negative(self):
        for settings in self:
            for name in self._BABANA_NON_NEGATIVE_FIELDS:
                if settings[name] < 0:
                    raise ValidationError(_("Une valeur ne peut pas être négative : %s.", settings._fields[name].string))

    @api.constrains("babana_priority_star_high_threshold", "babana_priority_star_mid_threshold")
    def _check_babana_star_thresholds(self):
        for settings in self:
            if settings.babana_priority_star_mid_threshold >= settings.babana_priority_star_high_threshold:
                raise ValidationError(_("La note du palier moyen doit être inférieure à celle du palier haut."))
