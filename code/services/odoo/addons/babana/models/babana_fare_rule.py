# Grille tarifaire paramétrable (L2-01, D15 : base + distance x prix au km, majoré par un
# coefficient de zone et d'heure de pointe -- jamais de prix à la minute, É9).
from __future__ import annotations

from odoo import api, fields, models
from odoo.exceptions import UserError

# D21 : valeur par défaut plausible, explicitement provisoire (L2-03). Le vrai pas vient du
# paramètre système babana.fare_rounding_step, jamais codé en dur dans le calcul lui-même --
# c'est pourquoi services/pricing.py l'exige en paramètre plutôt que de le lire ici.
FARE_ROUNDING_STEP_PARAM = "babana.fare_rounding_step"
FARE_ROUNDING_STEP_FALLBACK = 25.0

# Champs qui affectent le montant calculé -- une fois la règle enregistrée, ils ne se modifient
# plus en place (critère d'acceptation 4) : toute évolution tarifaire passe par new_version(),
# qui clôt cette règle et en crée une autre. Sans FK directe de babana.ride vers babana.fare.rule
# (le gel se fait par valeur -- fare_rule_snapshot, L4-01), il n'existe aucun moyen fiable de
# savoir si UNE règle donnée a déjà servi ; l'immutabilité s'applique donc à toutes, servies ou
# non -- plus simple, et strictement plus sûr que la lecture littérale du critère.
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
        help="Avec time_end : bornes en heures (0-24). Une plage nulle (time_start == time_end, "
        "y compris 0.0 == 0.0 par défaut) signifie « aucune restriction horaire » -- un Float "
        "Odoo ne distingue pas 0.0 de « non renseigné », d'où cette convention explicite plutôt "
        "qu'un sentinel ambigu.",
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
        default=lambda self: fields.Date.context_today(self),
        required=True,
        help="Fenêtre de validité de la règle elle-même (historisation, critère 4).",
    )
    active_to = fields.Date(help="Vide = toujours valide.")

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
    def _find_applicable_rule(self, *, zone=None, vehicle_class=None, at_datetime):
        """Sélection déterministe (L2-01, critère 2) : parmi les règles applicables à cette
        zone, cette gamme et cet instant, celle de plus forte priorité gagne -- `_order` porte
        déjà le départage à égalité (création la plus récente). Il doit toujours en exister une :
        la règle de repli (data/fare_rule_default.xml) ne restreint ni zone, ni gamme, ni
        horaire. `zone` est la zone de départ résolue par babana.zone.resolve_point (L2-02) --
        c'est elle qui détermine la règle, pas la zone d'arrivée (documenté ici comme le demande
        L2-07)."""
        candidates = self.search(
            [
                ("active_from", "<=", at_datetime.date()),
                "|",
                ("active_to", "=", False),
                ("active_to", ">=", at_datetime.date()),
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
                at_datetime.hour + at_datetime.minute / 60.0
            ) and rule._applies_on_weekday(at_datetime.weekday()):
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

    def write(self, vals):
        # Comparé à la valeur réellement stockée, pas seulement à la présence du champ dans
        # vals : le chargement des données de seed (data/fare_rule_default.xml) réapplique les
        # mêmes valeurs à chaque réinstallation du module -- noupdate="1" n'en dispense pas
        # nécessairement selon le mode de chargement (constaté en développant L2-02). Un
        # write() qui ne change rien n'est pas une modification au sens du critère 4.
        if not self.env.context.get("babana_allow_versioned_write"):
            for record in self:
                changed = [
                    field
                    for field in _VERSIONED_FIELDS.intersection(vals)
                    if record._versioned_field_actually_changes(field, vals[field])
                ]
                if changed:
                    raise UserError(
                        "Une règle tarifaire existante ne se modifie pas en place : utiliser "
                        "new_version() pour créer une nouvelle version et clore celle-ci "
                        "(L2-01, critère d'acceptation 4)."
                    )
        return super().write(vals)

    def new_version(self, vals):
        """Clôt cette règle et en crée une nouvelle avec les valeurs modifiées (critère 4) :
        c'est ce qui rend une facture ancienne rejouable malgré l'évolution de la grille."""
        self.ensure_one()
        today = fields.Date.context_today(self)
        self.with_context(babana_allow_versioned_write=True).write({"active_to": today})
        new_vals = {**self.copy_data()[0], **vals, "active_from": today, "active_to": False}
        return self.create(new_vals)
