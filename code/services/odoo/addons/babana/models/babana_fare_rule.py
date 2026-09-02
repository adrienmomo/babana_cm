# Grille tarifaire paramétrable (L2-01, D15 : base + distance x prix au km, majoré par un
# coefficient de zone et d'heure de pointe -- jamais de prix à la minute, É9).
from __future__ import annotations

from datetime import date

import pytz

from odoo import api, fields, models
from odoo.exceptions import UserError

from .res_users import DEFAULT_ACCOUNT_TZ_FALLBACK, DEFAULT_ACCOUNT_TZ_PARAM

# D21 : valeur par défaut plausible, explicitement provisoire (L2-03). Le vrai pas vient du
# paramètre système babana.fare_rounding_step, jamais codé en dur dans le calcul lui-même --
# c'est pourquoi services/pricing.py l'exige en paramètre plutôt que de le lire ici.
FARE_ROUNDING_STEP_PARAM = "babana.fare_rounding_step"
FARE_ROUNDING_STEP_FALLBACK = 25.0

# Champs qui affectent le montant calculé -- une fois qu'une règle a servi à au moins une course,
# ils ne se modifient plus en place (critère d'acceptation 4) : toute évolution tarifaire passe
# par new_version(), qui clôt cette règle et en crée une autre.
#
# Une règle jamais utilisée reste librement modifiable (L2-01R, correction du 13 août -- amoa/
# questions/REPONSES-2026-08-13.md) : la version précédente de ce module rendait TOUTE règle
# immuable dès sa création, faute de moyen fiable de savoir si UNE règle donnée avait servi. La
# référence babana.ride.fare_rule_id (L4-01R2) lève cette incertitude -- _is_used_by_a_ride()
# ci-dessous l'interroge directement. Sans cet assouplissement, corriger une faute de frappe dans
# une règle créée cinq minutes plus tôt aurait exigé une version, une friction quotidienne au
# back-office pendant le pilote.
_VERSIONED_FIELDS = {
    "base_fare",
    "price_per_km",
    "minimum_fare",
    "zone_id",  # amoa/questions/L2-01.md : ajouté par L2-02, déjà dans cet ensemble par avance.
    "vehicle_class",
    "time_start",
    "time_end",
    "weekday_mask",
    "surge_multiplier",
    "priority",
}

ALL_WEEKDAYS_MASK = 0b1111111


class BabanaFareRule(models.Model):
    _name = "babana.fare.rule"
    _description = "Grille tarifaire (L2-01, D15)"
    _order = "priority desc, create_date desc, id desc"

    name = fields.Char(required=True)
    base_fare = fields.Float(string="Prise en charge (FCFA)", required=True)
    price_per_km = fields.Float(string="Prix au kilomètre (FCFA)", required=True)
    minimum_fare = fields.Float(string="Montant plancher (FCFA)", required=True)
    zone_id = fields.Many2one(
        "babana.zone",
        string="Zone d'application",
        help="Vide = toutes les zones. Ajouté par L2-02 (amoa/questions/L2-01.md) : absent le "
        "temps que babana.zone n'existe pas encore, plus tôt cette même nuit.",
    )
    vehicle_class = fields.Selection(
        [("standard", "Standard"), ("premium", "Premium")],
        string="Gamme",
        help="Vide = toutes les gammes.",
    )
    time_start = fields.Float(
        string="Début de plage horaire",
        help="Avec time_end : bornes en heures (0-24), en HEURE LOCALE DOUALA (fuseau "
        "d'exploitation posé par babana.default_account_tz, D45) -- jamais en UTC. Le moteur "
        "convertit l'horodatage UTC de chaque cotation vers ce fuseau avant de comparer, "
        "précisément pour que ce que le superviseur saisit ici et ce que le moteur applique "
        "parlent de la même heure. Une plage nulle (time_start == time_end, y compris 0.0 == "
        "0.0 par défaut) signifie « aucune restriction horaire » -- un Float Odoo ne distingue "
        "pas 0.0 de « non renseigné », d'où cette convention explicite plutôt qu'un sentinel "
        "ambigu.",
    )
    time_end = fields.Float(string="Fin de plage horaire")
    weekday_mask = fields.Integer(
        string="Jours d'application (bits)",
        default=ALL_WEEKDAYS_MASK,
        help="Bit 0 = lundi ... bit 6 = dimanche. Toutes les valeurs à 1 par défaut (tous les "
        "jours).",
    )
    surge_multiplier = fields.Float(string="Coefficient heure de pointe", default=1.0)
    priority = fields.Integer(
        default=0,
        help="Départage entre règles concurrentes (critère d'acceptation 2) : la plus forte "
        "gagne. À égalité, la plus récemment créée (_order).",
    )
    active_from = fields.Date(
        default=lambda self: fields.Date.today(),
        required=True,
        help="Fenêtre de validité de la règle elle-même (historisation, critère 4). "
        "fields.Date.today(), pas context_today() -- voir code/docs/odoo-pitfalls.md.",
    )
    active_to = fields.Date(help="Vide = toujours valide.")

    overlap_rule_ids = fields.Many2many(
        "babana.fare.rule",
        "babana_fare_rule_overlap_rel",
        "rule_id",
        "overlap_rule_id",
        compute="_compute_overlap_rule_ids",
        string="Règles en recouvrement",
        help="Autres règles encore valides dont la zone, la gamme, le jour et la plage horaire "
        "peuvent s'appliquer en même temps que celle-ci (L9-04, critère 1). Non stocké -- "
        "recalculé à chaque lecture sur le petit nombre de règles d'un pilote ; pas destiné à "
        "un tri ou un filtre en base.",
    )
    has_overlap = fields.Boolean(
        compute="_compute_overlap_rule_ids",
        string="Recouvre une autre règle",
    )
    locked_by_usage = fields.Boolean(
        compute="_compute_locked_by_usage",
        string="Verrouillée (déjà utilisée par une course)",
        help="Une règle déjà servie (critère 4) ne se modifie plus en place -- toute évolution "
        "passe par « Nouvelle version », qui clôt celle-ci et en crée une autre (critère 5).",
    )

    _sql_constraints = [
        (
            "babana_fare_rule_no_negative_amounts",
            "check(base_fare >= 0 and price_per_km >= 0 and minimum_fare >= 0)",
            "Les montants d'une règle tarifaire ne peuvent pas être négatifs.",
        ),
    ]

    @api.model
    def _default_rounding_step(self) -> float:
        return float(
            self.env["ir.config_parameter"]
            .sudo()
            .get_param(FARE_ROUNDING_STEP_PARAM, FARE_ROUNDING_STEP_FALLBACK)
        )

    @api.depends(
        "zone_id", "vehicle_class", "time_start", "time_end", "weekday_mask", "active_from",
        "active_to",
    )
    def _compute_overlap_rule_ids(self):
        # L9-04, critère 1 -- "l'erreur de paramétrage la plus probable". Comparé uniquement aux
        # règles encore ouvertes (active_to vide ou dans le futur) : une règle close par
        # new_version() a cessé de s'appliquer, son ancien recouvrement avec sa remplaçante
        # n'a plus rien d'une erreur.
        today = fields.Date.today()
        open_rules = self.search(["|", ("active_to", "=", False), ("active_to", ">=", today)])
        for rule in self:
            if rule.active_to and rule.active_to < today:
                rule.overlap_rule_ids = [(5, 0, 0)]
                rule.has_overlap = False
                continue
            others = open_rules - rule
            overlapping = others.filtered(lambda other, rule=rule: rule._overlaps_with(other))
            rule.overlap_rule_ids = [(6, 0, overlapping.ids)]
            rule.has_overlap = bool(overlapping)

    def _is_generic(self) -> bool:
        # Une règle totalement sans restriction (data/fare_rule_default.xml : ni zone, ni gamme,
        # ni plage horaire, tous les jours) est un repli assumé -- elle recouvre TOUJOURS toute
        # autre règle par construction. La signaler serait du bruit sur chaque règle jamais
        # créée, pas l'erreur de paramétrage que le critère 1 vise à repérer.
        self.ensure_one()
        return (
            not self.zone_id
            and not self.vehicle_class
            and not self._has_time_restriction()
            and self.weekday_mask == ALL_WEEKDAYS_MASK
        )

    def _overlaps_with(self, other) -> bool:
        self.ensure_one()
        other.ensure_one()
        if self._is_generic() or other._is_generic():
            return False
        if not self._date_ranges_overlap(other):
            return False
        if self.zone_id and other.zone_id and self.zone_id != other.zone_id:
            # Zones distinctes toutes deux renseignées : recouvrement géographique possible
            # entre deux polygones (L9-04, "les polygones se recouvrent ou laissent des trous"),
            # non calculé ici -- au pilote une seule zone existe (data/babana_zone_default.xml),
            # donc ce cas n'est en pratique pas encore atteignable. Documenté plutôt que
            # silencieusement approximé (amoa/questions/L9-04.md ne le couvre pas : ce n'est pas
            # une impossibilité, seulement hors du périmètre utile ce soir).
            return False
        if self.vehicle_class and other.vehicle_class and self.vehicle_class != other.vehicle_class:
            return False
        if not (self.weekday_mask & other.weekday_mask):
            return False
        return self._time_windows_overlap(other)

    def _date_ranges_overlap(self, other) -> bool:
        self.ensure_one()
        other.ensure_one()
        self_end = self.active_to or date.max
        other_end = other.active_to or date.max
        return self.active_from <= other_end and other.active_from <= self_end

    def _time_windows_overlap(self, other) -> bool:
        self.ensure_one()
        other.ensure_one()
        for start_a, end_a in self._time_subintervals():
            for start_b, end_b in other._time_subintervals():
                if start_a <= end_b and start_b <= end_a:
                    return True
        return False

    def _time_subintervals(self) -> list[tuple[float, float]]:
        # Une plage à cheval sur minuit (ex. 22h -> 5h) se décompose en deux intervalles
        # [22, 24] et [0, 5] pour ramener la comparaison au cas simple (voir _applies_at_time,
        # qui traite ce même cas pour une seule règle plutôt qu'une paire).
        self.ensure_one()
        if not self._has_time_restriction():
            return [(0.0, 24.0)]
        if self.time_start <= self.time_end:
            return [(self.time_start, self.time_end)]
        return [(self.time_start, 24.0), (0.0, self.time_end)]

    def _compute_locked_by_usage(self):
        for rule in self:
            rule.locked_by_usage = rule._is_used_by_a_ride()

    def action_open_new_version_wizard(self):
        # Critère 5 : l'interface doit dire "nouvelle version", pas laisser modifier en place.
        # Le formulaire de la règle bloque déjà l'écriture directe (write() ci-dessous) ; ce
        # bouton est le chemin qui reste pour faire évoluer une règle servie.
        self.ensure_one()
        return {
            "type": "ir.actions.act_window",
            "name": "Nouvelle version de « %s »" % self.name,
            "res_model": "babana.fare.rule.version.wizard",
            "view_mode": "form",
            "target": "new",
            "context": {
                "default_source_rule_id": self.id,
                "default_name": self.name,
                "default_base_fare": self.base_fare,
                "default_price_per_km": self.price_per_km,
                "default_minimum_fare": self.minimum_fare,
                "default_zone_id": self.zone_id.id,
                "default_vehicle_class": self.vehicle_class,
                "default_time_start": self.time_start,
                "default_time_end": self.time_end,
                "default_weekday_mask": self.weekday_mask,
                "default_surge_multiplier": self.surge_multiplier,
                "default_priority": self.priority,
            },
        }

    def _has_time_restriction(self) -> bool:
        self.ensure_one()
        return self.time_start != self.time_end

    def _applies_at_time(self, hour: float) -> bool:
        self.ensure_one()
        if not self._has_time_restriction():
            return True
        if self.time_start <= self.time_end:
            return self.time_start <= hour <= self.time_end
        # Plage à cheval sur minuit (ex. 22h -> 5h) : hors de [end, start], donc dans la plage.
        return hour >= self.time_start or hour <= self.time_end

    def _applies_on_weekday(self, weekday: int) -> bool:
        self.ensure_one()
        return bool(self.weekday_mask & (1 << weekday))

    @api.model
    def _operating_timezone(self):
        """Fuseau d'exploitation (D45) : le même paramètre que celui posé sur chaque compte à
        la création (models/res_users.py), réutilisé ici plutôt que dupliqué -- une règle
        tarifaire n'a pas d'utilisateur connecté à sa propre échelle (une cotation anonyme, un
        cron), donc pas de `env.user.tz` significatif à lire, contrairement à
        babana_driver.py::_babana_cash_collected_today qui, lui, répond à un compte précis."""
        tz_name = (
            self.env["ir.config_parameter"]
            .sudo()
            .get_param(DEFAULT_ACCOUNT_TZ_PARAM, DEFAULT_ACCOUNT_TZ_FALLBACK)
        )
        try:
            return pytz.timezone(tz_name)
        except pytz.UnknownTimeZoneError:
            return pytz.UTC

    @api.model
    def _find_applicable_rule(self, *, zone=None, vehicle_class=None, at_datetime):
        """Sélection déterministe (L2-01, critère 2) : parmi les règles applicables à cette
        zone, cette gamme et cet instant, celle de plus forte priorité gagne -- `_order` porte
        déjà le départage à égalité (création la plus récente). Il doit toujours en exister une :
        la règle de repli (data/fare_rule_default.xml) ne restreint ni zone, ni gamme, ni
        horaire. `zone` est la zone de départ résolue par babana.zone.resolve_point (L2-02) --
        c'est elle qui détermine la règle, pas la zone d'arrivée (documenté ici comme le demande
        L2-07).

        `at_datetime` arrive en UTC naïf (fields.Datetime.now(), comme partout ailleurs dans ce
        module -- controllers/quote.py). time_start/time_end et weekday_mask, eux, sont saisis
        par le superviseur en heure locale de Douala (voir l'aide du champ time_start) : sans
        conversion, une plage « 17h-20h » voulue par le superviseur aurait été comparée à
        l'heure UTC, décalée d'une heure -- le même défaut que D45 avait déjà corrigé pour la
        recette du jour (babana_driver.py), ici sur la face horaire plutôt que calendaire.
        `zone` participe déjà à la sélection ; borner aussi sur l'heure locale, pas l'UTC, c'est
        ce qui fait que ce que le superviseur voit dans la grille et ce que le moteur applique
        parlent bien de la même heure."""
        local_datetime = pytz.UTC.localize(at_datetime).astimezone(self._operating_timezone())
        candidates = self.search(
            [
                ("active_from", "<=", local_datetime.date()),
                "|",
                ("active_to", "=", False),
                ("active_to", ">=", local_datetime.date()),
                "|",
                ("zone_id", "=", False),
                ("zone_id", "=", zone.id if zone else False),
                "|",
                ("vehicle_class", "=", False),
                ("vehicle_class", "=", vehicle_class or False),
            ]
        )
        for rule in candidates:
            if rule._applies_at_time(
                local_datetime.hour + local_datetime.minute / 60.0
            ) and rule._applies_on_weekday(local_datetime.weekday()):
                return rule
        raise UserError(
            "Aucune règle tarifaire applicable : une course sans tarif calculable est une "
            "panne, pas un cas métier (L2-01). Vérifier que la règle de repli existe toujours."
        )

    def _versioned_field_actually_changes(self, field_name, new_value) -> bool:
        self.ensure_one()
        current = self[field_name]
        if self._fields[field_name].type == "many2one":
            return (current.id if current else False) != (new_value or False)
        return current != new_value

    def _is_used_by_a_ride(self) -> bool:
        # L2-01R (correction du 13 août) : seule une règle réellement servie est immuable
        # (critère 4) -- une règle jamais utilisée reste librement modifiable (critère 4 bis).
        self.ensure_one()
        return bool(
            self.env["babana.ride"].sudo().search_count([("fare_rule_id", "=", self.id)])
        )

    def write(self, vals):
        # Comparé à la valeur réellement stockée, pas seulement à la présence du champ dans
        # vals : le chargement des données de seed (data/fare_rule_default.xml) réapplique les
        # mêmes valeurs à chaque réinstallation du module -- noupdate="1" n'en dispense pas
        # nécessairement selon le mode de chargement (constaté en développant L2-02). Un
        # write() qui ne change rien n'est pas une modification au sens du critère 4 (critère 4
        # ter : ce qui permet aux données initiales du module de se recharger).
        if not self.env.context.get("babana_allow_versioned_write"):
            for record in self:
                changed = [
                    field
                    for field in _VERSIONED_FIELDS.intersection(vals)
                    if record._versioned_field_actually_changes(field, vals[field])
                ]
                if changed and record._is_used_by_a_ride():
                    raise UserError(
                        "Une règle tarifaire déjà utilisée par une course ne se modifie pas en "
                        "place : utiliser new_version() pour créer une nouvelle version et "
                        "clore celle-ci (L2-01, critère d'acceptation 4)."
                    )
        return super().write(vals)

    def new_version(self, vals):
        """Clôt cette règle et en crée une nouvelle avec les valeurs modifiées (critère 4) :
        c'est ce qui rend une facture ancienne rejouable malgré l'évolution de la grille."""
        self.ensure_one()
        # fields.Date.today(), pas context_today() -- voir code/docs/odoo-pitfalls.md.
        today = fields.Date.today()
        self.with_context(babana_allow_versioned_write=True).write({"active_to": today})
        new_vals = {**self.copy_data()[0], **vals, "active_from": today, "active_to": False}
        return self.create(new_vals)
