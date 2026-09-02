# Traitement des écarts de remise de caisse (D29, L5-06). Un écart silencieusement absorbé est
# une fraude rendue invisible -- ce modèle rend visible toute différence entre attendu et remis,
# et détecte une série d'écarts avant qu'elle ne devienne un détournement avéré.
from __future__ import annotations

from datetime import timedelta

from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError

# Seuil d'alerte et fenêtre glissante paramétrables (invariant 5), jamais codés en dur. Deux
# mécanismes indépendants, l'un et l'autre suffisant à déclencher : un montant cumulé qui
# dépasse le seuil (critère 4), ou un nombre d'écarts de même sens qui atteint le seuil de série
# (critère 5) -- une série de petits écarts qui ne cumulerait jamais assez pour le premier
# mécanisme reste détectable par le second.
DISCREPANCY_ALERT_WINDOW_DAYS_PARAM = "babana.cash_discrepancy_alert_window_days"
DISCREPANCY_ALERT_WINDOW_DAYS_FALLBACK = 30
DISCREPANCY_ALERT_AMOUNT_THRESHOLD_PARAM = "babana.cash_discrepancy_alert_amount_threshold"
DISCREPANCY_ALERT_AMOUNT_THRESHOLD_FALLBACK = 5000.0
DISCREPANCY_ALERT_SERIES_COUNT_PARAM = "babana.cash_discrepancy_alert_series_count"
DISCREPANCY_ALERT_SERIES_COUNT_FALLBACK = 3

_REASON_CATEGORIES = [
    ("change_shortage", "Appoint manquant"),
    ("counting_error", "Erreur de comptage"),
    ("disputed_ride", "Course contestée"),
    ("other", "Autre"),
]

_DECISIONS = [
    ("left_on_balance", "Laissé au solde (par défaut, D29)"),
    ("adjustment", "Ajustement motivé"),
    ("withheld", "Retenue selon la politique de l'entreprise"),
]


class BabanaCashDiscrepancy(models.Model):
    _name = "babana.cash.discrepancy"
    # Sans ceci, le formulaire back-office (<chatter/>, babana_discrepancy_views.xml) plante à
    # l'ouverture : AttributeError 'babana.cash.discrepancy' object has no attribute
    # '_get_thread_with_access' -- constaté en revue visuelle du 2 septembre (même défaut que
    # babana.cash.remittance et babana.incident, jamais vu avant faute d'identifiant admin,
    # amoa/questions/REPONSES-2026-09-11.md §1).
    _inherit = ["mail.thread"]
    _description = "Écart de remise de caisse (D29, L5-06)"
    _order = "create_date asc, id asc"  # triés par ancienneté (spécification, vue back-office)

    remittance_id = fields.Many2one(
        "babana.cash.remittance", string="Remise", required=True, index=True,
        ondelete="restrict"
    )
    driver_id = fields.Many2one(
        "babana.driver", string="Chauffeur", required=True, index=True, ondelete="restrict"
    )
    currency_id = fields.Many2one(
        "res.currency", required=True, default=lambda self: self.env.company.currency_id.id
    )
    amount = fields.Monetary(
        string="Montant",
        currency_field="currency_id",
        required=True,
        help="Toujours positif -- le sens de l'écart est porté par `direction`, pas par le "
        "signe de ce champ.",
    )
    direction = fields.Selection(
        [("shortfall", "Manque"), ("surplus", "Excédent")],
        string="Sens",
        required=True,
        default="shortfall",
        help="'shortfall' dans ce lot : une remise ne peut jamais dépasser le solde attendu "
        "(L5-01, critère 4 -- le mouvement `remittance` correspondant serait refusé), donc "
        "`counted_amount` ne dépasse jamais `expected_amount`. Le champ reste générique -- un "
        "futur mécanisme d'ajustement pourrait un jour produire un excédent.",
    )
    reason_category = fields.Selection(_REASON_CATEGORIES, string="Motif")
    reason_comment = fields.Text(
        string="Commentaire",
        help="Obligatoire quand `reason_category` vaut 'other' (critère d'acceptation 2).",
    )
    status = fields.Selection(
        [("pending", "En attente"), ("closed", "Clôturé")],
        string="Statut", default="pending", required=True
    )
    decision = fields.Selection(_DECISIONS, string="Décision")
    decided_by = fields.Many2one("res.users", string="Décidé par", ondelete="restrict")
    closed_at = fields.Datetime(string="Clôturé à")
    adjustment_movement_id = fields.Many2one(
        "babana.cash.movement",
        string="Mouvement d'ajustement",
        ondelete="restrict",
        help="Mouvement de compte courant produit par un traitement explicite (critère "
        "d'acceptation 3) -- vide pour le traitement par défaut (D29, `left_on_balance`), qui "
        "ne modifie rien : l'écart pèse déjà sur le solde par construction, rien à journaliser "
        "de plus.",
    )
    write_off_move_id = fields.Many2one(
        "account.move",
        string="Pièce d'apurement",
        ondelete="restrict",
        help="Pièce comptable qui éteint le reliquat de créance (D34, "
        "babana_cash_remittance.py::_babana_post_discrepancy_writeoff) -- vide pour le "
        "traitement par défaut, exactement comme adjustment_movement_id : c'est ici, et "
        "seulement ici, que le compte d'écart entre en comptabilité (spécification L5-05).",
    )
    driver_other_discrepancy_ids = fields.Many2many(
        "babana.cash.discrepancy",
        "babana_cash_discrepancy_driver_history_rel",
        "discrepancy_id",
        "other_discrepancy_id",
        compute="_compute_driver_other_discrepancy_ids",
        string="Historique d'écarts du chauffeur",
        help="Les autres écarts du même chauffeur, les plus récents en tête (L9-05, critère 2) "
        "-- juxtaposés à celui-ci sur le même écran : « un écart isolé ne dit rien, trois écarts "
        "dans le même sens disent quelque chose » (spécification). Non stocké : recalculé à "
        "chaque lecture, même choix que overlap_rule_ids (babana_fare_rule.py).",
    )
    same_direction_recent_count = fields.Integer(
        compute="_compute_driver_other_discrepancy_ids",
        string="Écarts de même sens récents",
        help="Nombre d'écarts de même sens (celui-ci compris) sur la fenêtre glissante d'alerte "
        "(babana.cash_discrepancy_alert_window_days) -- ce que "
        "_babana_check_alert_thresholds compare déjà au seuil de série, exposé ici pour que le "
        "superviseur le voie sans consulter le message posté sur la fiche chauffeur.",
    )
    part_of_a_series = fields.Boolean(
        compute="_compute_driver_other_discrepancy_ids",
        search="_search_part_of_a_series",
        string="Fait partie d'une série",
        help="same_direction_recent_count a atteint le seuil de série (critère d'acceptation 5) "
        "-- repère visuel direct, sans faire le calcul de tête.",
    )

    def _compute_driver_other_discrepancy_ids(self):
        # L9-05, critères 2 et 5 : même fenêtre et même seuil que _babana_check_alert_thresholds
        # (l'alerte posée à la création) -- deux lectures indépendantes du même seuil
        # divergeraient sinon en silence (D23, toujours la même famille de défaut).
        Params = self.env["ir.config_parameter"].sudo()
        window_days = int(
            Params.get_param(
                DISCREPANCY_ALERT_WINDOW_DAYS_PARAM, DISCREPANCY_ALERT_WINDOW_DAYS_FALLBACK
            )
        )
        series_count = int(
            Params.get_param(
                DISCREPANCY_ALERT_SERIES_COUNT_PARAM, DISCREPANCY_ALERT_SERIES_COUNT_FALLBACK
            )
        )
        window_start = fields.Datetime.now() - timedelta(days=window_days)
        for record in self:
            all_for_driver = self.sudo().search(
                [("driver_id", "=", record.driver_id.id)], order="create_date desc"
            )
            record.driver_other_discrepancy_ids = all_for_driver - record
            recent_same_direction = all_for_driver.filtered(
                lambda d, record=record: d.direction == record.direction
                and d.create_date
                and d.create_date >= window_start
            )
            record.same_direction_recent_count = len(recent_same_direction)
            record.part_of_a_series = len(recent_same_direction) >= series_count

    def _search_part_of_a_series(self, operator, value):
        # Non stocké (même raison que driver_other_discrepancy_ids) -- le filtre "En série" de
        # la vue de recherche passe par un balayage Python, même patron que
        # babana_fare_rule.py::_search_has_overlap pour "En recouvrement".
        if operator not in ("=", "!="):
            raise ValueError("Filtre 'série' : opérateur non supporté.")
        wants_series = (operator == "=" and value) or (operator == "!=" and not value)
        series_ids = [record.id for record in self.search([]) if record.part_of_a_series]
        return [("id", "in" if wants_series else "not in", series_ids)]

    @api.constrains("reason_category", "reason_comment")
    def _check_other_requires_comment(self):
        for record in self:
            if record.reason_category == "other" and not (record.reason_comment or "").strip():
                raise ValidationError(
                    "Motif 'Autre' exige un commentaire (critère d'acceptation 2, L5-06)."
                )

    def write(self, vals):
        for record in self:
            if record.status == "closed" and vals:
                raise UserError("Écart clôturé : plus aucune modification n'est permise (L5-06).")
        return super().write(vals)

    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
        records._babana_check_alert_thresholds()
        return records

    def _babana_check_alert_thresholds(self):
        """Critères 4 et 5 : alerte au-delà d'un seuil cumulé, ou dès qu'une série de même sens
        est détectée -- appelée à chaque création, jamais en cron différé : un détournement
        progressif se détecte au fil de l'eau, pas le lendemain."""
        Params = self.env["ir.config_parameter"].sudo()
        window_days = int(
            Params.get_param(
                DISCREPANCY_ALERT_WINDOW_DAYS_PARAM, DISCREPANCY_ALERT_WINDOW_DAYS_FALLBACK
            )
        )
        amount_threshold = float(
            Params.get_param(
                DISCREPANCY_ALERT_AMOUNT_THRESHOLD_PARAM,
                DISCREPANCY_ALERT_AMOUNT_THRESHOLD_FALLBACK,
            )
        )
        series_count = int(
            Params.get_param(
                DISCREPANCY_ALERT_SERIES_COUNT_PARAM, DISCREPANCY_ALERT_SERIES_COUNT_FALLBACK
            )
        )
        window_start = fields.Datetime.now() - timedelta(days=window_days)

        for record in self:
            recent = self.sudo().search(
                [
                    ("driver_id", "=", record.driver_id.id),
                    ("direction", "=", record.direction),
                    ("create_date", ">=", window_start),
                ]
            )
            total = sum(recent.mapped("amount"))
            if total < amount_threshold and len(recent) < series_count:
                continue
            record.driver_id.message_post(
                body=(
                    "Alerte écarts de caisse (L5-06, D29) : %d écart(s) de sens '%s' sur les "
                    "%d derniers jours, totalisant %s. Seuil : %s cumulé ou %d écarts."
                    % (
                        len(recent),
                        record.direction,
                        window_days,
                        total,
                        amount_threshold,
                        series_count,
                    )
                )
            )

    def action_close(self, *, decided_by, decision, reason_category, reason_comment=None):
        """Clôture le traitement de l'écart (L5-06). `left_on_balance` (défaut, D29) ne produit
        aucun mouvement -- l'écart pèse déjà sur le solde du chauffeur par construction (le
        mouvement `remittance` de la validation ne portait que le montant compté). Les deux
        autres décisions sont des décisions humaines explicites, jamais le comportement par
        défaut, et produisent chacune un mouvement `adjustment` tracé (critère d'acceptation 3)
        qui réduit le solde du montant de l'écart -- la différence entre elles n'est pas
        mécanique, seulement le motif consigné pour l'audit."""
        self.ensure_one()
        if self.status == "closed":
            raise UserError("Cet écart est déjà clôturé (L5-06).")
        if not reason_category:
            raise UserError(
                "Un écart ne peut pas être clos sans motif (critère d'acceptation 2, L5-06)."
            )
        if reason_category == "other" and not (reason_comment or "").strip():
            raise UserError("Motif 'Autre' exige un commentaire (L5-06).")
        if decision not in dict(_DECISIONS):
            raise UserError("Décision de traitement d'écart inconnue (L5-06).")

        vals = {
            "status": "closed",
            "decision": decision,
            "decided_by": decided_by.id,
            "closed_at": fields.Datetime.now(),
            "reason_category": reason_category,
            "reason_comment": reason_comment,
        }

        with self.env.cr.savepoint():
            if decision != "left_on_balance":
                # La pièce comptable d'abord (même discipline que action_validate,
                # babana_cash_remittance.py) : son échec (compte non configuré) ne doit laisser
                # ni le mouvement de compte courant ni la clôture appliqués. C'est ici, et
                # seulement ici (decision != 'left_on_balance'), que le compte d'écart entre en
                # comptabilité (D34) -- le reliquat de créance restait dû depuis la validation.
                write_off_move = self.remittance_id.sudo()._babana_post_discrepancy_writeoff(
                    amount=self.amount
                )
                vals["write_off_move_id"] = write_off_move.id

                # -self.amount : correct pour 'shortfall', le seul sens atteignable dans ce lot
                # (voir le help de `direction`) -- un futur mécanisme produisant un `surplus`
                # devra revoir ce signe, pas le réutiliser tel quel.
                movement = self.env["babana.cash.movement"].sudo().create(
                    {
                        "driver_id": self.driver_id.id,
                        "movement_type": "adjustment",
                        "amount": -self.amount,
                        "reason": (
                            f"Traitement de l'écart sur la remise {self.remittance_id.reference} "
                            f"({dict(_DECISIONS)[decision]})."
                        ),
                        "discrepancy_id": self.id,
                    }
                )
                vals["adjustment_movement_id"] = movement.id
            self.write(vals)

        return self

    def button_close(self):
        """Bouton du formulaire (vue back-office, spécification) : `decision`,
        `reason_category` et `reason_comment` sont des champs de formulaire, déjà modifiables et
        déjà enregistrés au moment du clic -- même patron que
        `babana_cash_remittance.py::button_validate`. Pas de `sudo()` : l'appartenance à
        `group_babana_supervisor` autorise déjà l'écriture (`ir.model.access.csv`)."""
        self.ensure_one()
        return self.action_close(
            decided_by=self.env.user,
            decision=self.decision or "left_on_balance",
            reason_category=self.reason_category,
            reason_comment=self.reason_comment,
        )
