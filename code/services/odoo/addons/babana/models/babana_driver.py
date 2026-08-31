# Chauffeur salarié (L1-03, D5). Rattaché à hr.employee : ce n'est pas un partenaire externe,
# c'est un employé de l'entreprise dont l'application est un outil de travail.
#
# employee_id est facultatif tant que state vaut 'pending' (L1-03R2, correction du 13 août --
# amoa/questions/REPONSES-2026-08-13.md) : un sign-in chauffeur crée une candidature, pas un
# employé. L'approbation (L1-06, hors de ce lot) est le seul endroit qui crée ou rattache la
# fiche hr.employee -- la contrainte ci-dessous rend l'obligation réelle à partir de 'approved'.
from __future__ import annotations

import uuid
from datetime import datetime, time, timedelta

import pytz

from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError

# D28 (amoa/questions/REPONSES-2026-08-18.md, 01-architecture.md §7) : plafond FIXE POUR TOUTE LA
# FLOTTE, jamais par chauffeur -- un plafond individuel créerait une inégalité que quelqu'un
# devrait justifier à voix haute. Un seul paramètre système, jamais codé en dur (invariant 5) ;
# 50 000 FCFA au départ, à confirmer en pilote (L9-06, back-office, hors de ce lot).
CASH_LIMIT_PARAM = "babana.cash_limit"
CASH_LIMIT_FALLBACK = 50000.0

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
    public_id = fields.Char(
        string="Identifiant public",
        index=True,
        copy=False,
        default=lambda self: str(uuid.uuid4()),
        help="Identifiant exposé à l'API mobile (DriverIdSchema, C-01, L4-03) -- jamais "
        "l'identifiant Odoo interne. Même idée que res.users.babana_public_id (L1-01) et "
        "babana.ride.public_id (L4-03).",
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
    rejection_reason = fields.Text(
        string="Motif de rejet ou de suspension",
        help="Motif de la dernière décision négative sur le dossier (rejet L1-06, ou "
        "suspension). Voyage jusqu'à l'app dans la session "
        "(AuthenticatedUser.driverRejectionReason) pour que l'écran de suivi de dossier (L6-15) "
        "dise pourquoi. Effacé à l'approbation et à la réactivation.",
    )
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
    movement_ids = fields.One2many(
        "babana.cash.movement",
        "driver_id",
        string="Mouvements de compte courant",
        help="Déclaré pour que cash_balance (@api.depends) sache s'invalider quand un mouvement "
        "est créé -- sans lien déclaré, l'ORM ne peut pas deviner qu'un babana.cash.movement "
        "fraîchement créé rend le cash_balance déjà lu (et mis en cache) pour ce chauffeur "
        "périmé, la création n'écrivant aucun champ de babana.driver lui-même.",
    )
    cash_balance = fields.Monetary(
        string="Solde dû à l'entreprise",
        currency_field="currency_id",
        compute="_compute_cash_balance",
        inverse="_inverse_cash_balance",
        help="Jamais écrit directement (D8, L5-01) : somme du journal des mouvements de compte "
        "courant (babana.cash.movement). L'ajout ultérieur d'un solde de commission (É3) n'exige "
        "aucune migration : un champ calculé de plus, indépendant de celui-ci.",
    )
    cash_limit = fields.Monetary(
        string="Plafond d'encaisse",
        currency_field="currency_id",
        compute="_compute_cash_limit",
        inverse="_inverse_cash_limit",
        help="Plafond fixe pour toute la flotte (D28) : reflète le paramètre système "
        "babana.cash_limit, jamais une valeur propre à ce chauffeur -- pas de plafond "
        "individuel (L9-06, back-office, hors de ce lot, ajustera le paramètre, pas ce champ).",
    )
    phone_verified = fields.Boolean(string="Numéro vérifié", default=False)
    document_ids = fields.One2many(
        "babana.driver.document",
        "driver_id",
        string="Documents",
        help="Permis et pièce d'identité téléversés par le chauffeur (L1-05). L'inscription "
        "(L6-15) crée une ligne par téléversement -- un document renvoyé après rejet ajoute une "
        "ligne, l'ancienne reste pour l'audit. GET /api/v1/driver/documents ne renvoie que la "
        "plus récente par type.",
    )

    _sql_constraints = [
        (
            "babana_driver_employee_unique",
            "unique(employee_id)",
            "Un employé n'a qu'une seule fiche chauffeur.",
        ),
        (
            "babana_driver_public_id_unique",
            "unique(public_id)",
            "Collision d'identifiant public chauffeur -- ne devrait jamais se produire (UUID).",
        ),
    ]

    def _babana_cash_balance(self) -> float:
        """Somme du journal des mouvements (L5-01, critère 6) -- méthode Python plutôt que le
        champ calculé lui-même : babana_cash_movement.py::_check_collection_and_remittance_
        never_go_negative en a besoin AVANT que le compute du champ n'ait tourné (le mouvement
        qu'elle valide n'est pas encore visible d'un browse() mis en cache)."""
        self.ensure_one()
        movements = self.env["babana.cash.movement"].sudo().search([("driver_id", "=", self.id)])
        return sum(movements.mapped("amount"))

    def _babana_cash_collected_today(self) -> float:
        """Recette encaissée aujourd'hui (GET /drivers/me/cash, C-01) -- somme des mouvements
        `collection` du jour, pas des courses `settled` du jour : un mouvement `collection` n'est
        créé qu'à l'encaissement (L4-05), donc les deux ensembles coïncident déjà, mais interroger
        le journal du compte courant reste la source unique du solde (L5-01) plutôt que
        d'introduire une seconde façon de compter.

        `fields.Date.context_today(self)`, pas `fields.Date.today()` : ce calcul répond à un
        chauffeur qui regarde effectivement son écran dans son propre fuseau horaire -- exactement
        le cas réservé à `context_today()` par code/docs/odoo-pitfalls.md, à l'inverse d'un cron ou
        d'une valeur par défaut sans utilisateur réel connecté.

        D45 (amoa/questions/REPONSES-2026-08-29.md §1) -- la moitié qui manquait : les deux bornes
        du jour calendaire local sont construites comme des datetime naïfs puis comparées telles
        quelles à `create_date`, stocké en UTC. Entre 22h et minuit UTC (l'avance du fuseau sur
        UTC, qu'il vaille +1 comme Africa/Douala ou +2 comme Europe/Brussels en été), la fenêtre
        interrogée ne contient plus les mouvements du jour local en cours -- une course encaissée
        à l'instant disparaît de l'écran. `pytz` localise chaque borne dans le fuseau du compte
        avant de la convertir en UTC ; les deux bornes sont recalculées séparément (`combine` sur
        `today` puis sur `today + 1 jour`) plutôt qu'un simple `start + timedelta(days=1)`, pour
        rester correct un jour de changement d'heure (sans objet pour Africa/Douala, qui n'en a
        pas, mais Europe/Brussels -- le repli si le paramètre n'est pas posé -- si)."""
        self.ensure_one()
        tz_name = self.env.context.get("tz") or self.env.user.tz or "UTC"
        try:
            tz = pytz.timezone(tz_name)
        except pytz.UnknownTimeZoneError:
            tz = pytz.UTC
        today = fields.Date.context_today(self)
        start = tz.localize(datetime.combine(today, time.min)).astimezone(pytz.UTC).replace(
            tzinfo=None
        )
        end = tz.localize(datetime.combine(today + timedelta(days=1), time.min)).astimezone(
            pytz.UTC
        ).replace(tzinfo=None)
        movements = self.env["babana.cash.movement"].sudo().search(
            [
                ("driver_id", "=", self.id),
                ("movement_type", "=", "collection"),
                ("create_date", ">=", start),
                ("create_date", "<", end),
            ]
        )
        return sum(movements.mapped("amount"))

    @api.model
    def _cash_limit(self) -> float:
        return float(
            self.env["ir.config_parameter"].sudo().get_param(CASH_LIMIT_PARAM, CASH_LIMIT_FALLBACK)
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

    @api.depends("movement_ids.amount")
    def _compute_cash_balance(self):
        # Un compute sans inverse FONCTIONNEL est en lecture seule dans l'ORM Odoo : c'est ce qui
        # rend une écriture directe impossible (L5-01, critère d'acceptation 1), pas une
        # vérification ajoutée à côté -- _inverse_cash_balance ci-dessous existe uniquement pour
        # lever une erreur explicite (un compute sans inverse DU TOUT est ignoré silencieusement
        # par write(), ce qui ne prouverait rien).
        #
        # @api.depends("movement_ids.amount"), pas un recalcul manuel via _babana_cash_balance() :
        # sans dépendance déclarée, l'ORM ne sait jamais qu'un babana.cash.movement fraîchement
        # créé rend ce champ périmé pour ce chauffeur (aucun champ de babana.driver lui-même
        # n'est écrit par cette création) -- un cash_balance lu avant le mouvement resterait alors
        # en cache, à zéro, pour le reste de la transaction. Constaté en écrivant
        # _babana_apply_cash_limit (L5-02) : le franchissement du plafond n'était jamais détecté.
        for record in self:
            record.cash_balance = sum(record.movement_ids.mapped("amount"))

    def _inverse_cash_balance(self):
        raise UserError(
            "cash_balance ne s'écrit jamais directement : il se calcule depuis le journal des "
            "mouvements de compte courant (D8, L5-01)."
        )

    def _compute_cash_limit(self):
        # Même discipline que cash_balance : compute + inverse-qui-lève, pour qu'une écriture
        # directe échoue explicitement (D28 -- pas de plafond par chauffeur, un seul paramètre
        # système pour toute la flotte).
        limit = self._cash_limit()
        for record in self:
            record.cash_limit = limit

    def _inverse_cash_limit(self):
        raise UserError(
            "cash_limit ne s'écrit jamais par chauffeur : le plafond d'encaisse est un montant "
            "unique pour toute la flotte, réglé par le paramètre système babana.cash_limit (D28)."
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
    def _check_online_requires_cash_under_limit(self):
        # Même famille que les trois contraintes voisines (approbation, assurance, permis) --
        # ajoutée pour L3-04, critère 4. Un chauffeur au plafond ne peut pas se déclarer en ligne
        # via /drivers/me/availability -- complémentaire des deux points de blocage exigés par
        # L5-02 (nearby.drivers, acceptation), qui vivent côté temps réel : celle-ci empêche en
        # plus la reconnexion explicite côté Odoo.
        for record in self:
            if record.is_online and record.cash_limit and record.cash_balance >= record.cash_limit:
                raise ValidationError(
                    "Ce chauffeur ne peut pas passer en ligne : le plafond d'encaisse est "
                    "atteint (D8)."
                )

    def _babana_apply_cash_limit(self) -> bool:
        """Effet 4 de l'encaissement (L4-05, D8, D28) : si l'encaissement qui vient de se
        produire fait franchir le plafond, le chauffeur passe hors ligne IMMÉDIATEMENT, dans la
        MÊME transaction que l'encaissement (L5-02, critère 3) -- appelée depuis le bloc
        savepoint d'action_settle, jamais isolément.

        Une course en cours n'est jamais interrompue par ce franchissement (L5-02, critère 4) :
        rien ici ne touche babana.ride, seulement la disponibilité FUTURE de ce chauffeur.

        Le passage hors ligne côté Odoo ne suffit pas seul (L5-02, "deux points de blocage, tous
        deux obligatoires") : le service temps réel garde son propre état (pool géo-indexé,
        engagement), indépendant d'is_online (deux systèmes délibérément découplés, voir
        driver/availability.ts côté temps réel).

        N'appelle plus notify_cash_limit_reached elle-même (D33, amoa/questions/
        REPONSES-2026-08-19.md §2) : cet appel s'accroche au commit (cr.postcommit), qui ignore
        les savepoints -- l'enregistrer ici, à l'intérieur du savepoint d'action_settle, le
        ferait survivre à l'annulation de ce savepoint. Renvoie donc seulement si le
        franchissement a eu lieu ; c'est action_settle qui enregistre l'appel sortant, une fois
        le savepoint sorti avec succès."""
        self.ensure_one()
        if not (self.is_online and self.cash_limit and self.cash_balance >= self.cash_limit):
            return False
        self.write({"is_online": False})
        return True

    def _has_active_ride(self) -> bool:
        # DRIVER_ACTIVE_STATES (babana_ride.py, L4-01) : la même définition d'« en course » que
        # l'index unique partiel qui empêche une deuxième course active pour ce chauffeur --
        # réutilisée plutôt que réinventée (L3-04).
        self.ensure_one()
        from .babana_ride import DRIVER_ACTIVE_STATES  # import tardif : évite un cycle (babana_ride importe déjà babana_driver via Many2one)

        return bool(
            self.env["babana.ride"].sudo().search_count(
                [("driver_id", "=", self.id), ("state", "in", list(DRIVER_ACTIVE_STATES))]
            )
        )

    def _check_online_eligibility(self):
        """Motif de refus distinct pour chaque condition (L3-04, critère 1), ou None si le
        chauffeur peut passer en ligne. Les mêmes conditions sont aussi protégées par les
        contraintes ci-dessus (défense en profondeur contre une écriture directe qui
        contournerait le contrôleur) -- ici, elles sont vérifiées AVANT l'écriture pour renvoyer
        un code d'erreur distinct plutôt qu'une ValidationError généreique."""
        self.ensure_one()
        if self.state != "approved":
            return "DRIVER_NOT_APPROVED", "Le dossier n'est pas approuvé."
        if not self.motorcycle_id:
            return "MOTORCYCLE_NOT_ASSIGNED", "Aucune moto n'est affectée à ce chauffeur."
        if self.motorcycle_id._insurance_is_expired():
            return "INSURANCE_EXPIRED", "L'assurance de la moto a expiré."
        expires_on = self._current_license_expires_on()
        if expires_on and expires_on < fields.Date.today():
            return "LICENSE_EXPIRED", "Le permis a expiré."
        if self.cash_limit and self.cash_balance >= self.cash_limit:
            return "CASH_LIMIT_REACHED", "Le plafond d'encaisse est atteint."
        return None

    def _check_offline_allowed(self):
        """None si le chauffeur peut se mettre hors ligne, sinon un motif (L3-04, critère 2) :
        seul le cas "en course" bloque -- le passage hors ligne est sinon immédiat et
        inconditionnel (spécification L3-04)."""
        self.ensure_one()
        if self._has_active_ride():
            return "DRIVER_HAS_ACTIVE_RIDE", "Impossible de se mettre hors ligne pendant une course."
        return None

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


    # --- L1-06 : validation du dossier chauffeur --------------------------------------------
    # Actions réservées à group_babana_manager -- appliqué par les droits d'accès (security/
    # ir.model.access.csv : babana.driver n'est ouvert en écriture qu'aux groupes manager et
    # admin), pas par un contrôle explicite ici : ces méthodes appellent write() sans sudo(),
    # donc un utilisateur sans ce droit échoue déjà à ce niveau (AccessError), avant même
    # d'atteindre la logique métier.

    _REQUIRED_DOCUMENT_TYPES = ("license", "id_card")

    def _required_documents_are_verified(self) -> bool:
        self.ensure_one()
        Document = self.env["babana.driver.document"].sudo()
        return all(
            Document.search_count(
                [
                    ("driver_id", "=", self.id),
                    ("document_type", "=", document_type),
                    ("verification_status", "=", "verified"),
                ]
            )
            for document_type in self._REQUIRED_DOCUMENT_TYPES
        )

    def action_approve(self, *, employee_id=None, new_employee_name=None):
        """Approuve le dossier (L1-06). Le gestionnaire choisit : employee_id (fiche existante,
        cas normal d'un chauffeur déjà embauché) ou new_employee_name (nouvelle fiche) --
        exactement un des deux, jamais aucun, jamais ce choix fait à sa place."""
        self.ensure_one()
        if not self._required_documents_are_verified():
            raise UserError(
                "Impossible d'approuver : le permis et la pièce d'identité doivent être "
                "téléversés et vérifiés (L1-06, critère d'acceptation 1)."
            )
        if not self.motorcycle_id:
            raise UserError(
                "Impossible d'approuver : aucune moto n'est affectée à ce chauffeur -- un "
                "chauffeur approuvé sans moto ne peut pas travailler (L1-06, critère 2)."
            )
        if bool(employee_id) == bool(new_employee_name):
            raise UserError(
                "Choisir soit une fiche employé existante (employee_id), soit un nom pour en "
                "créer une (new_employee_name) -- pas les deux, pas aucun (L1-06, critère 1 "
                "bis)."
            )

        if employee_id:
            employee = self.env["hr.employee"].browse(employee_id)
            if not employee.exists():
                raise UserError("Fiche employé introuvable.")
        else:
            # Seul endroit du système qui écrit dans hr (critère 1 bis), et seulement ici, à la
            # décision explicite d'un gestionnaire -- jamais à l'inscription (L1-01R).
            employee = self.env["hr.employee"].create({"name": new_employee_name})

        # rejection_reason effacé : un dossier d'abord rejeté puis approuvé ne doit pas continuer
        # de porter son ancien motif jusqu'à l'app (AuthenticatedUser.driverRejectionReason).
        self.write(
            {"employee_id": employee.id, "state": "approved", "rejection_reason": False}
        )
        self.message_post(body=f"Dossier approuvé, rattaché à l'employé « {employee.name} ».")
        return self

    def action_reject(self, *, reason):
        self.ensure_one()
        if not reason:
            raise UserError(
                "Un motif est obligatoire pour rejeter un dossier (L1-06, critère 3)."
            )
        self.write({"state": "rejected", "rejection_reason": reason})
        self.message_post(body=f"Dossier rejeté : {reason}")
        return self

    def action_suspend(self, *, reason):
        """is_online passe à faux mécaniquement (write() ci-dessus force is_online=False dès
        que state != 'approved') -- pas une conséquence recalculée ici (critère 4). Une course
        en cours n'est pas interrompue (critère 5) : rien ici ne touche babana.ride, la
        machine à états (L4-02) continue son cours indépendamment de l'état du chauffeur.

        Le motif est persisté sur `rejection_reason` (et non seulement posté au fil) : c'est lui
        que la session porte jusqu'à l'app (AuthenticatedUser.driverRejectionReason,
        amoa/questions/REPONSES-2026-09-04.md §2) pour qu'un chauffeur suspendu lise « votre
        compte est suspendu : <motif> » au lieu de « déposez vos pièces »."""
        self.ensure_one()
        if not reason:
            raise UserError(
                "Un motif est obligatoire pour suspendre un chauffeur (L1-06, critère 3, même "
                "règle que le rejet)."
            )
        self.write({"state": "suspended", "rejection_reason": reason})
        if self.user_id:
            # Point d'entrée construit par L1-02 précisément pour cet appel (critère 4).
            self.env["babana.token"].sudo()._revoke_all_for_user(self.user_id)
        self.message_post(body=f"Chauffeur suspendu : {reason}")
        return self

    def action_reactivate(self):
        self.ensure_one()
        if self.state != "suspended":
            raise UserError(
                "Seul un chauffeur suspendu peut être réactivé (L1-06)."
            )
        self.write({"state": "approved", "rejection_reason": False})
        self.message_post(body="Chauffeur réactivé.")
        return self
