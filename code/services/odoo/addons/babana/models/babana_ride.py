# La course (L4-01). Les transitions de babana.ride sont les seules portes d'écriture sur
# `state` (invariant 2) -- ce verrou est posé par L4-02, pas ici. L4-01 pose le modèle de
# données et ses contraintes d'intégrité.
from __future__ import annotations

import logging
import uuid

from odoo import api, fields, models

_logger = logging.getLogger(__name__)

# Seuil d'écart entre distance parcourue et distance de référence, au-delà duquel la course est
# signalée (L4-04, critère d'acceptation 3) -- jamais corrigée automatiquement : peut révéler un
# détour, un problème GPS, ou une adresse mal saisie, et c'est au back-office de trancher. Valeur
# plausible explicitement provisoire (D21), à confirmer par L10-05 sur données de pilote.
DISTANCE_DEVIATION_THRESHOLD_KM_PARAM = "babana.distance_deviation_threshold_km"
DISTANCE_DEVIATION_THRESHOLD_KM_DEFAULT = 2.0

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

# États "pendant une course", au sens où client et chauffeur sont physiquement réunis (L8-03,
# L8-04) : ni avant l'affectation (personne n'est encore ensemble), ni après un état terminal
# (la course n'a plus lieu). Distinct de DRIVER_ACTIVE_STATES (qui inclut `proposed`, où le
# chauffeur n'a pas encore accepté) et de CLIENT_ACTIVE_STATES (qui inclut `requested`, avant
# tout chauffeur désigné) -- ni le partage de trajet ni le bouton d'urgence n'ont de sens
# avant que les deux parties ne soient réellement en présence l'une de l'autre.
TOGETHER_STATES = ("assigned", "in_progress")


class BabanaRide(models.Model):
    _name = "babana.ride"
    _description = "Course (L4-01)"
    _order = "create_date desc"

    # --- Identité --------------------------------------------------------------------------
    reference = fields.Char(required=True, readonly=True, copy=False, index=True, default="/")
    public_id = fields.Char(
        string="Identifiant public",
        index=True,
        copy=False,
        default=lambda self: str(uuid.uuid4()),
        help="Identifiant exposé à l'API mobile (RideIdSchema, C-01, L4-03) -- jamais "
        "l'identifiant Odoo interne, séquentiel et devinable. Même idée que "
        "res.users.babana_public_id (L1-01).",
    )
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
    # pickup_zone_id / dropoff_zone_id (babana.zone, L2-02) : posés par L2-04 (affectation du 13
    # août -- L9-07 doit produire les zones les plus actives, impossible sans elles). Résolus une
    # fois à la cotation (controllers/quote.py) et copiés sur la course à sa création (L4-03R) --
    # pas recalculés ici, même principe que le tarif figé ci-dessous.
    pickup_zone_id = fields.Many2one("babana.zone", index=True, ondelete="restrict")
    dropoff_zone_id = fields.Many2one("babana.zone", index=True, ondelete="restrict")

    # --- Estimation ------------------------------------------------------------------------
    quote_id = fields.Many2one(
        "babana.quote",
        string="Estimation référencée",
        index=True,
        ondelete="restrict",
        help="Remplace le champ-pont quote_reference (L4-01) -- L2-04 crée babana.quote, ce "
        "champ est la vraie relation annoncée à sa création. La course référence l'estimation "
        "plutôt que de recalculer (L4-03R) : c'est ce qui garantit que le client paie ce qu'on "
        "lui a montré.",
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
    trip_measured = fields.Boolean(
        default=False,
        help="Vrai si le service temps réel a fourni un relevé de trajet réel (distance, durée, "
        "tracé accumulés pendant la course, L3-10). Faux : la course s'est terminée sans "
        "accumulation disponible -- aucune distance parcourue, aucun tracé n'est enregistré, et "
        "l'écart de distance (L4-04) n'est pas calculé. Une absence explicite plutôt qu'une "
        "valeur plausible et fausse (D30, D43, J24 -- amoa/questions/L6-13.md).",
    )
    distance_deviation_km = fields.Float(
        compute="_compute_distance_deviation",
        store=True,
        help="Écart entre distance parcourue et distance de référence -- signalé (L4-04), "
        "jamais corrigé automatiquement.",
    )
    distance_deviation_flagged = fields.Boolean(
        compute="_compute_distance_deviation_flagged",
        store=True,
        help="Écart au-delà du seuil configurable (babana.distance_deviation_threshold_km, "
        "L4-04, critère d'acceptation 3) -- un signalement, jamais une correction automatique : "
        "peut révéler un détour, un problème GPS, ou une adresse mal saisie. Au back-office de "
        "trancher.",
    )

    # --- Tarif figé ----------------------------------------------------------------------------
    fare_rule_id = fields.Many2one(
        "babana.fare.rule",
        string="Règle tarifaire appliquée",
        index=True,
        ondelete="set null",
        help="Référence vers la règle qui a servi (L4-01R2, correction du 13 août -- amoa/"
        "questions/REPONSES-2026-08-13.md), en plus du gel par valeur ci-dessous. Les deux ne "
        "s'opposent pas : le gel rend la facture explicable pour toujours, la référence dit "
        "QUELLE règle a servi -- c'est elle qui permet à babana.fare.rule (L2-01R) de limiter "
        "son immutabilité aux règles réellement utilisées plutôt qu'à toutes. Peut pointer vers "
        "une règle supprimée ou archivée sans que la facture en souffre (ondelete='set null') : "
        "c'est le gel par valeur ci-dessous qui fait foi pour le montant, pas cette référence.",
    )
    fare_rule_snapshot = fields.Text(
        help="Détail décomposé de la règle tarifaire au moment du gel (JSON) -- figé sur la "
        "course elle-même, pas seulement référencé (L4-01) : survit à toute modification "
        "ultérieure de la règle d'origine (critère d'acceptation 3).",
    )
    promotion_code = fields.Char(
        help="[PONT — remplacé par L2-06] Remplace un Many2one babana.promotion, absent ce soir.",
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
        ("babana_ride_public_id_unique", "unique(public_id)", "Collision d'identifiant public de course -- ne devrait jamais se produire (UUID)."),
    ]

    @api.depends("actual_distance_km", "reference_distance_km", "trip_measured")
    def _compute_distance_deviation(self):
        for record in self:
            # Pas de mesure réelle (L3-10 absente ou injoignable à la fin de course) : aucun écart
            # n'a de sens -- `actual_distance_km` vaut 0.0 par défaut, un `0 - reference` donnerait
            # un écart énorme et armerait l'alerte de L4-04 sur *chaque* course non mesurée
            # (J24, amoa/questions/L6-13.md). L'écart reste à 0 jusqu'à une mesure réelle.
            record.distance_deviation_km = (
                (record.actual_distance_km - record.reference_distance_km)
                if record.trip_measured
                else 0.0
            )

    @api.depends("distance_deviation_km", "state", "trip_measured")
    def _compute_distance_deviation_flagged(self):
        threshold = float(
            self.env["ir.config_parameter"].sudo().get_param(
                DISTANCE_DEVIATION_THRESHOLD_KM_PARAM, DISTANCE_DEVIATION_THRESHOLD_KM_DEFAULT
            )
        )
        for record in self:
            flagged = (
                record.trip_measured
                and record.state in ("completed", "settled")
                and abs(record.distance_deviation_km) > threshold
            )
            record.distance_deviation_flagged = flagged
            if flagged:
                # Signalement (L4-04, critère 3) : jamais une correction automatique, seulement
                # visible pour le back-office -- le flag stocké ci-dessus en est la trace
                # durable, ce message en est la trace immédiate.
                _logger.warning(
                    "babana.ride %s : écart de distance signalé (%.2f km, seuil %.2f km).",
                    record.reference, record.distance_deviation_km, threshold,
                )

    def _babana_compute_final_amount(self):
        """Montant final (L4-04, critère d'acceptation 2) : calculé sur la distance de
        référence (L2-05), jamais sur la distance parcourue -- reproductible et connue du
        client à l'avance, contrairement à la distance parcourue qui dépend des raccourcis du
        chauffeur et de la qualité du GPS. `estimated_amount` a déjà été calculé sur cette même
        distance de référence à la création de la course (L2-04/L4-03R) et gelé avec la règle
        tarifaire (fare_rule_snapshot) : ce montant n'a donc rien à recalculer aujourd'hui,
        seulement à être reporté. Il ne peut différer de l'estimé que si une promotion devient
        invalide entre l'estimation et la fin de course (critère 5) -- babana.promotion (L2-06)
        n'existe pas encore, ce cas ne peut donc pas encore se produire ; ce point d'accroche
        existe pour que L2-06 n'ait qu'à brancher sa résolution, pas à créer ce mécanisme."""
        self.ensure_one()
        return self.estimated_amount

    def _babana_client_public_id(self):
        """Identifiant public du CLIENT (res.users.babana_public_id, L1-01) de cette course --
        pas res.partner.id (interne, séquentiel), pas babana_google_sub (res.partner, L1-04) qui
        n'est pas l'identifiant exposé aux apps mobiles. `client_id` est un res.partner ; l'app
        s'authentifie comme un res.users (UserIdSchema, C-01) -- une seule requête pour faire le
        pont, ajoutée pour L3-19 (notify_ride_started/notify_ride_completed, realtime_client.py),
        qui ont besoin de la même identité que reserve_and_propose (controllers/ride.py) déjà
        connaît via `user.babana_public_id` côté appelant client, mais que action_start/
        action_complete (chauffeur appelant) n'ont pas sous la main."""
        self.ensure_one()
        user = self.env["res.users"].sudo().search([("partner_id", "=", self.client_id.id)], limit=1)
        return user.babana_public_id or None

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
