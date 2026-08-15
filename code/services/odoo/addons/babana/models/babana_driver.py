# Chauffeur salarié (L1-03, D5). Rattaché à hr.employee : ce n'est pas un partenaire externe,
# c'est un employé de l'entreprise dont l'application est un outil de travail.
#
# employee_id est facultatif tant que state vaut 'pending' (L1-03R2, correction du 13 août --
# amoa/questions/REPONSES-2026-08-13.md) : un sign-in chauffeur crée une candidature, pas un
# employé. L'approbation (L1-06, hors de ce lot) est le seul endroit qui crée ou rattache la
# fiche hr.employee -- la contrainte ci-dessous rend l'obligation réelle à partir de 'approved'.
from __future__ import annotations

from datetime import timedelta

from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError

# D21 : valeur par défaut plausible, explicitement provisoire. Le vrai plafond vient du
# paramètre système babana.default_cash_limit (back-office, L9-06 -- hors de ce lot), jamais
# codé en dur dans une transaction individuelle.
DEFAULT_CASH_LIMIT_PARAM = "babana.default_cash_limit"
DEFAULT_CASH_LIMIT_FALLBACK = 50000.0

# L1-01, critère 10 : limitation de débit sur la création de candidature -- par adresse IP, le
# vecteur concret décrit par la spécification (« n'importe quel compte Google appelant
# /auth/google avec role=driver »). Valeurs paramétrables (invariant 5), jamais codées en dur
# dans la vérification elle-même.
DRIVER_CANDIDACY_RATE_LIMIT_MAX_PARAM = "babana.driver_candidacy_rate_limit_max"
DRIVER_CANDIDACY_RATE_LIMIT_MAX_FALLBACK = 5
DRIVER_CANDIDACY_RATE_LIMIT_WINDOW_MINUTES_PARAM = (
    "babana.driver_candidacy_rate_limit_window_minutes"
)
DRIVER_CANDIDACY_RATE_LIMIT_WINDOW_MINUTES_FALLBACK = 60


class DriverCandidacyRateLimited(UserError):
    """Trop de candidatures chauffeur depuis la même adresse (L1-01, critère 10) -- à traduire
    en RATE_LIMITED (catalogue C-01, 429) par le contrôleur."""


class BabanaDriver(models.Model):
    _name = "babana.driver"
    _inherit = ["mail.thread"]
    _description = "Chauffeur salarié (L1-03)"

    motorcycle_id = fields.Many2one(
        "babana.motorcycle",
        string="Moto affectée",
        compute="_compute_motorcycle_id",
        help="Affectation courante (L1-07). Miroir calculé de babana.motorcycle.driver_id, seule "
        "source écrite de la relation, pour qu'une affectation ne puisse jamais diverger entre "
        "les deux sens. L'historique complet des affectations vit dans babana.assignment "
        "(L1-08).",
    )

    employee_id = fields.Many2one(
        "hr.employee",
        string="Employé",
        index=True,
        ondelete="restrict",
        help="Rattachement salarié (D5) : le chauffeur est un employé, pas un partenaire. "
        "Facultatif tant que state vaut 'pending' -- une candidature n'est pas encore un "
        "employé (L1-03R2) ; obligatoire dès 'approved' (contrainte ci-dessous).",
    )
    user_id = fields.Many2one(
        "res.users",
        string="Compte de connexion",
        index=True,
        ondelete="restrict",
    )
    signup_ip_address = fields.Char(
        string="Adresse IP d'inscription",
        help="Capturée à la création de la candidature (L1-01, critère 10), pour la limitation "
        "de débit et l'investigation d'abus. Jamais utilisée à d'autres fins.",
    )
    state = fields.Selection(
        [
            ("pending", "En attente"),
            ("approved", "Approuvé"),
            ("rejected", "Rejeté"),
            ("suspended", "Suspendu"),
        ],
        default="pending",
        required=True,
    )
    rejection_reason = fields.Text(string="Motif de rejet")
    is_online = fields.Boolean(string="En ligne", default=False)

    # Champs-pont restants (amoa/questions/L1-03.md, code/docs/bridge-fields.md) : rating_avg et
    # rating_count renvoient une valeur neutre jusqu'à ce que L4-09 (notation) existe -- la
    # méthode de calcul est déjà en place pour être branchée dessus sans changer la signature du
    # champ. ride_count n'en est plus un : babana.ride (L4-01) existe désormais (branché le
    # 11 août, amoa/questions/REPONSES-2026-08-11.md).
    rating_avg = fields.Float(
        string="Note moyenne",
        compute="_compute_rating",
        help="[PONT — remplacé par L4-09] Toujours 0.0 tant que babana.rating n'existe pas.",
    )
    rating_count = fields.Integer(
        string="Nombre d'avis",
        compute="_compute_rating",
        help="[PONT — remplacé par L4-09] Toujours 0 tant que babana.rating n'existe pas.",
    )
    ride_count = fields.Integer(
        string="Nombre de courses",
        compute="_compute_ride_count",
        help="Indicateur d'équité (C2c, L9-08) : détecte les chauffeurs jamais sélectionnés.",
    )
    currency_id = fields.Many2one(
        "res.currency",
        default=lambda self: self.env.company.currency_id.id,
        required=True,
    )
    cash_balance = fields.Monetary(
        string="Solde dû à l'entreprise",
        currency_field="currency_id",
        compute="_compute_cash_balance",
        inverse="_inverse_cash_balance",
        help="[PONT — remplacé par L5-01] Jamais écrit directement (D8) : résultat du journal "
        "des mouvements de compte courant. Toujours 0 en attendant ce modèle. L'ajout ultérieur "
        "d'un solde de commission (É3) n'exige aucune migration : un champ calculé de plus, "
        "indépendant de celui-ci.",
    )
    cash_limit = fields.Monetary(
        string="Plafond d'encaisse",
        currency_field="currency_id",
        default=lambda self: self._default_cash_limit(),
    )
    phone_verified = fields.Boolean(string="Numéro vérifié", default=False)

    _sql_constraints = [
        (
            "babana_driver_employee_unique",
            "unique(employee_id)",
            "Un employé n'a qu'une seule fiche chauffeur.",
        ),
        (
            "babana_driver_cash_balance_not_negative",
            "check(cash_balance >= 0)",
            "Un solde négatif signale une erreur de calcul, pas un cas métier (D8).",
        ),
    ]

    @api.model
    def _default_cash_limit(self) -> float:
        return float(
            self.env["ir.config_parameter"]
            .sudo()
            .get_param(DEFAULT_CASH_LIMIT_PARAM, DEFAULT_CASH_LIMIT_FALLBACK)
        )

    def _compute_rating(self):
        # Champ-pont : voir amoa/questions/L1-03.md. Recalcul réel à brancher sur babana.rating
        # (L4-09) -- le critère d'acceptation 3 de L1-03 n'est pas vérifiable avant cette tâche.
        for record in self:
            record.rating_avg = 0.0
            record.rating_count = 0

    def _compute_ride_count(self):
        for record in self:
            record.ride_count = self.env["babana.ride"].search_count(
                [("driver_id", "=", record.id)]
            )

    def _compute_motorcycle_id(self):
        for record in self:
            record.motorcycle_id = self.env["babana.motorcycle"].search(
                [("driver_id", "=", record.id)], limit=1
            )

    def _compute_cash_balance(self):
        # Champ-pont : voir amoa/questions/L1-03.md. À brancher sur le journal des mouvements de
        # compte courant (L5-01). Un compute sans inverse est en lecture seule dans l'ORM Odoo :
        # c'est ce qui rend une écriture directe impossible (critère d'acceptation 4), pas une
        # vérification ajoutée à côté.
        for record in self:
            record.cash_balance = 0.0

    def _inverse_cash_balance(self):
        # Un compute sans inverse est ignoré silencieusement par write() dans l'ORM Odoo --
        # insuffisant pour prouver le critère d'acceptation 4 (une tentative d'écriture directe
        # échoue). Cet inverse existe uniquement pour lever une erreur explicite.
        raise UserError(
            "cash_balance ne s'écrit jamais directement : il se calcule depuis le journal des "
            "mouvements de compte courant (D8, L5-01)."
        )

    @api.constrains("state", "employee_id")
    def _check_employee_required_once_approved(self):
        # L1-03R2 (correction du 13 août -- amoa/questions/REPONSES-2026-08-13.md) : un chauffeur
        # approuvé est un salarié, une candidature ne l'est pas encore. La contrainte porte sur
        # l'état, pas sur la création -- employee_id peut donc rester vide de 'pending' jusqu'à
        # ce que L1-06 (validation du dossier, hors de ce lot) le rattache ou le crée.
        for record in self:
            if record.state == "approved" and not record.employee_id:
                raise ValidationError(
                    "Un chauffeur approuvé doit être rattaché à une fiche employé (D5, L1-06)."
                )

    @api.model
    def _check_candidacy_rate_limit(self, ip_address):
        # L1-01, critère 10 : appelé avant la création d'une candidature, jamais après --
        # limiter un abus déjà commis ne protège rien.
        if not ip_address:
            return
        max_per_window = int(
            self.env["ir.config_parameter"]
            .sudo()
            .get_param(
                DRIVER_CANDIDACY_RATE_LIMIT_MAX_PARAM,
                DRIVER_CANDIDACY_RATE_LIMIT_MAX_FALLBACK,
            )
        )
        window_minutes = int(
            self.env["ir.config_parameter"]
            .sudo()
            .get_param(
                DRIVER_CANDIDACY_RATE_LIMIT_WINDOW_MINUTES_PARAM,
                DRIVER_CANDIDACY_RATE_LIMIT_WINDOW_MINUTES_FALLBACK,
            )
        )
        window_start = fields.Datetime.now() - timedelta(minutes=window_minutes)
        recent_count = self.sudo().search_count(
            [
                ("signup_ip_address", "=", ip_address),
                ("create_date", ">=", window_start),
            ]
        )
        if recent_count >= max_per_window:
            raise DriverCandidacyRateLimited(
                "Trop de candidatures chauffeur depuis cette adresse récemment -- réessayer "
                "plus tard."
            )

    @api.constrains("is_online", "state")
    def _check_online_requires_approved(self):
        for record in self:
            if record.is_online and record.state != "approved":
                raise ValidationError(
                    "Un chauffeur ne peut passer en ligne que si son dossier est approuvé."
                )

    @api.constrains("is_online")
    def _check_online_requires_valid_insurance(self):
        # Critère d'acceptation 3 de L1-07 : un chauffeur dont la moto n'est plus assurée ne peut
        # pas passer en ligne -- même blocage, même raison, que côté moto (L1-07, critère 2).
        for record in self:
            if (
                record.is_online
                and record.motorcycle_id
                and record.motorcycle_id._insurance_is_expired()
            ):
                raise ValidationError(
                    "Ce chauffeur ne peut pas passer en ligne : l'assurance de sa moto a expiré "
                    "(L1-07)."
                )

    def _current_license_expires_on(self):
        # L1-05 (correction du 13 août) : license_expires_on n'est plus un champ plat sur
        # babana.driver -- lu depuis le permis le plus récemment téléversé (babana.driver.
        # document, type 'license'). False si aucun permis n'a jamais été téléversé.
        self.ensure_one()
        document = self.env["babana.driver.document"].sudo().search(
            [("driver_id", "=", self.id), ("document_type", "=", "license")],
            order="create_date desc",
            limit=1,
        )
        return document.expires_on if document else False

    @api.constrains("is_online")
    def _check_online_requires_valid_license(self):
        # Même raisonnement que l'assurance (L1-07) : un permis expiré est un risque juridique,
        # bloqué plutôt que signalé (L1-10). fields.Date.today(), pas context_today() -- voir
        # code/docs/odoo-pitfalls.md.
        for record in self:
            expires_on = record._current_license_expires_on()
            if record.is_online and expires_on and expires_on < fields.Date.today():
                raise ValidationError(
                    "Ce chauffeur ne peut pas passer en ligne : son permis a expiré (L1-10)."
                )

    def write(self, vals):
        # Critère d'acceptation 2 : un chauffeur suspendu (ou rejeté, ou repassé en attente)
        # passe automatiquement hors ligne -- pas seulement rejeté s'il tentait de repasser en
        # ligne après coup. Forcé indépendamment de ce que l'appelant a fourni pour is_online
        # dans le même appel : être en ligne hors de l'état approuvé n'est jamais permis.
        if "state" in vals and vals["state"] != "approved":
            vals = dict(vals, is_online=False)
        return super().write(vals)

    # --- L1-10 : alertes d'échéance (permis) ----------------------------------------------

    def _cron_alert_and_block_drivers(self):
        # fields.Date.today(), pas context_today() -- un cron n'a pas d'utilisateur réel
        # connecté ; voir code/docs/odoo-pitfalls.md. Lit désormais babana.driver.document
        # (L1-05) plutôt que les champs-pont license_expires_on/license_alert_sent_on, résolus
        # par cette même tâche (code/docs/bridge-fields.md).
        today = fields.Date.today()
        window_end = today + timedelta(
            days=self.env["babana.motorcycle"]._expiry_alert_window_days()
        )

        Document = self.env["babana.driver.document"]
        upcoming = Document.search(
            [
                ("document_type", "=", "license"),
                ("expires_on", ">=", today),
                ("expires_on", "<=", window_end),
                ("alert_sent_on", "!=", today),
            ]
        )
        for document in upcoming:
            driver = document.driver_id
            driver.message_post(
                body=(
                    f"Permis du chauffeur {driver.employee_id.name or driver.user_id.name} "
                    f"expirant le {document.expires_on} (L1-10)."
                )
            )
            document.alert_sent_on = today

        online_drivers = self.search([("is_online", "=", True)])
        for driver in online_drivers:
            expires_on = driver._current_license_expires_on()
            if expires_on and expires_on < today:
                # Critère 3 : mise hors ligne automatique, pas laissée à la vigilance d'un
                # gestionnaire.
                driver.write({"is_online": False})
