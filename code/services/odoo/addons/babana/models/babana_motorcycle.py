# La flotte de motos (L1-07, D6). L'entreprise possède les motos (D6, contrairement à un modèle
# de location par le chauffeur) ; ce module en tient l'inventaire, l'assurance et l'affectation
# courante. babana.assignment (L1-08) tiendra l'historique complet des affectations -- ce
# module-ci ne connaît que l'affectation active.
from __future__ import annotations

from datetime import timedelta

from odoo import api, fields, models
from odoo.exceptions import ValidationError

# D21 : valeur par défaut plausible, explicitement provisoire (L1-10). Le vrai délai vient du
# paramètre système babana.expiry_alert_window_days (back-office), jamais codé en dur ailleurs.
EXPIRY_ALERT_WINDOW_PARAM = "babana.expiry_alert_window_days"
EXPIRY_ALERT_WINDOW_FALLBACK_DAYS = 15

MOTORCYCLE_STATES = [
    ("available", "Disponible"),
    ("assigned", "Affectée"),
    ("maintenance", "En maintenance"),
    ("retired", "Retirée"),
]

# États que l'affectation automatique (critère d'acceptation 4) ne doit jamais écraser : une moto
# en maintenance ou retirée le reste tant qu'un gestionnaire ne l'en sort pas explicitement, même
# si son chauffeur est désaffecté entre-temps.
_STICKY_STATES = ("maintenance", "retired")

VEHICLE_CLASSES = [("standard", "Standard"), ("premium", "Premium")]


class BabanaMotorcycle(models.Model):
    _name = "babana.motorcycle"
    _inherit = ["mail.thread"]
    _description = "Moto de la flotte (L1-07, D6)"
    _order = "license_plate"
    # Sans ceci, Odoo n'a ni "name" ni _rec_name et affiche le repli technique "babana.motorcycle,1"
    # partout où le Many2one apparaît (liste et fiche chauffeur : "Moto affectée", historique
    # d'affectations) -- constaté en revue visuelle du back-office du 2 septembre, jamais vu
    # avant faute d'identifiant admin (amoa/questions/REPONSES-2026-09-11.md §1).
    _rec_name = "license_plate"

    license_plate = fields.Char(string="Immatriculation", required=True, index=True, copy=False)
    brand = fields.Char(string="Marque")
    model = fields.Char(string="Modèle")
    year = fields.Integer(string="Année")
    vehicle_class = fields.Selection(
        VEHICLE_CLASSES,
        string="Gamme",
        required=True,
        default="standard",
        help="Alimente le choix du client en L6-07 (CDC §II.2).",
    )
    registration_reference = fields.Char(string="Référence de carte grise")
    registration_document = fields.Binary(string="Carte grise (document)", attachment=True)
    insurer = fields.Char(string="Assureur")
    insurance_policy_number = fields.Char(string="Numéro de police")
    insurance_expires_on = fields.Date(string="Expiration de l'assurance")
    insurance_alert_sent_on = fields.Date(
        string="Dernière alerte d'échéance envoyée",
        help="Idempotence de la tâche planifiée (L1-10, critère d'acceptation 4) : deux "
        "exécutions le même jour ne renvoient pas deux fois la même alerte.",
    )
    state = fields.Selection(
        MOTORCYCLE_STATES,
        default="available",
        required=True,
        help="available/assigned suivent l'affectation automatiquement (critère 4) ; "
        "maintenance/retired sont posés explicitement par un gestionnaire et restent stables "
        "tant qu'il ne les lève pas lui-même.",
    )
    driver_id = fields.Many2one(
        "babana.driver",
        string="Chauffeur affecté",
        index=True,
        copy=False,
        help="Source unique de l'affectation courante -- babana.driver.motorcycle_id (L1-03) en "
        "est le miroir calculé, jamais l'inverse, pour qu'une affectation ne puisse jamais "
        "diverger entre les deux sens de la relation.",
    )

    # L9-02 : affichés en lecture seule dans la fiche flotte back-office.
    assignment_ids = fields.One2many(
        "babana.assignment",
        "motorcycle_id",
        string="Historique d'affectations",
        readonly=True,
        help="Historique complet (L1-08), non modifiable : chaque ligne est posée par le "
        "write() de babana.motorcycle, jamais à la main.",
    )
    ride_ids = fields.One2many(
        related="driver_id.ride_ids",
        string="Courses du chauffeur affecté",
        readonly=True,
        help="Il n'existe pas de lien direct course <-> moto (une course porte un chauffeur, "
        "L4-01). Ceci reflète les courses du chauffeur actuellement affecté -- indicatif.",
    )
    insurance_expired = fields.Boolean(
        string="Assurance expirée",
        compute="_compute_insurance_expired",
        search="_search_insurance_expired",
        help="Code couleur et filtre de la vue flotte (L9-02). Une moto à l'assurance expirée "
        "ne peut plus être affectée (L1-07).",
    )

    _sql_constraints = [
        (
            "babana_motorcycle_license_plate_unique",
            "unique(license_plate)",
            "Cette immatriculation est déjà enregistrée.",
        ),
    ]

    def _compute_insurance_expired(self):
        for record in self:
            record.insurance_expired = record._insurance_is_expired()

    def _search_insurance_expired(self, operator, value):
        if operator not in ("=", "!="):
            raise ValueError("Filtre 'assurance expirée' : opérateur non supporté.")
        wants_expired = (operator == "=" and value) or (operator == "!=" and not value)
        today = fields.Date.today()
        domain = [("insurance_expires_on", "!=", False), ("insurance_expires_on", "<", today)]
        return domain if wants_expired else ["!", "&"] + domain

    def action_end_assignment(self):
        """Fin d'affectation depuis la fiche flotte (L9-02, critère 2) : clôt la ligne
        d'historique active (babana.assignment), ce qui, via son write(), efface `driver_id` et
        repasse la moto à 'available' (sauf maintenance / retirée). Repli sur l'écriture directe
        de `driver_id` si aucune ligne d'historique n'existe (moto affectée par la voie courte
        `write({'driver_id': ...})`, sans assignment -- cas des jeux de test anciens)."""
        for record in self:
            active = self.env["babana.assignment"].search(
                [("motorcycle_id", "=", record.id), ("end_date", "=", False)], limit=1
            )
            if active:
                active.write({"end_date": fields.Datetime.now()})
            elif record.driver_id:
                record.write({"driver_id": False})

    def _insurance_is_expired(self) -> bool:
        self.ensure_one()
        if not self.insurance_expires_on:
            return False
        # fields.Date.today(), pas context_today() -- voir code/docs/odoo-pitfalls.md.
        return self.insurance_expires_on < fields.Date.today()

    @api.constrains("driver_id")
    def _check_insurance_before_assignment(self):
        # Critère d'acceptation 2 : rouler sans assurance est un risque juridique que le système
        # doit rendre impossible, pas seulement signaler -- un blocage, pas un avertissement.
        # Déclenché seulement par driver_id, pas par insurance_expires_on : le blocage porte sur
        # l'affectation elle-même, pas sur la correction ultérieure d'une date pendant qu'une
        # moto déjà affectée voit son assurance expirer avec le temps qui passe (aucune écriture
        # n'accompagne alors le passage de la date) -- c'est le critère 3, côté chauffeur, qui
        # couvre ce cas en le vérifiant à la demande, pas en le figeant dans une contrainte.
        for record in self:
            if record.driver_id and record._insurance_is_expired():
                raise ValidationError(
                    "Cette moto a une assurance expirée : elle ne peut pas être affectée à un "
                    "chauffeur (L1-07)."
                )

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if "driver_id" in vals and "state" not in vals:
                vals["state"] = "assigned" if vals.get("driver_id") else "available"
        return super().create(vals_list)

    def write(self, vals):
        if "driver_id" not in vals or "state" in vals:
            return super().write(vals)

        if vals["driver_id"]:
            if any(record.state in _STICKY_STATES for record in self):
                raise ValidationError(
                    "Une moto en maintenance ou retirée ne peut pas être affectée à un "
                    "chauffeur (L1-07, critère d'acceptation 4)."
                )
            return super().write(dict(vals, state="assigned"))

        # Désaffectation : chaque moto assignable retrouve "available" ; celles déjà en
        # maintenance ou retirée gardent cet état (voir _STICKY_STATES ci-dessus).
        assignable = self.filtered(lambda m: m.state not in _STICKY_STATES)
        sticky = self - assignable
        result = True
        if assignable:
            result = super(BabanaMotorcycle, assignable).write(dict(vals, state="available"))
        if sticky:
            result = super(BabanaMotorcycle, sticky).write(vals) and result
        return result

    # --- L1-10 : alertes d'échéance -----------------------------------------------------------

    @api.model
    def _expiry_alert_window_days(self) -> int:
        return int(
            self.env["ir.config_parameter"]
            .sudo()
            .get_param(EXPIRY_ALERT_WINDOW_PARAM, EXPIRY_ALERT_WINDOW_FALLBACK_DAYS)
        )

    @api.model
    def _cron_check_expiry_alerts(self):
        """Tâche planifiée quotidienne (L1-10) : alerte avant échéance, blocage à l'échéance.
        Couvre l'assurance des motos et le permis des chauffeurs -- ce dernier lu depuis
        babana.driver.document (L1-05) depuis la résolution du champ-pont correspondant."""
        self._cron_alert_and_block_motorcycles()
        self.env["babana.driver"]._cron_alert_and_block_drivers()

    def _cron_alert_and_block_motorcycles(self):
        # fields.Date.today(), pas context_today() -- voir code/docs/odoo-pitfalls.md.
        today = fields.Date.today()
        window_end = today + timedelta(days=self._expiry_alert_window_days())

        upcoming = self.search(
            [
                ("insurance_expires_on", ">=", today),
                ("insurance_expires_on", "<=", window_end),
                ("insurance_alert_sent_on", "!=", today),
            ]
        )
        for moto in upcoming:
            moto.message_post(
                body=(
                    f"Assurance de la moto {moto.license_plate} expirant le "
                    f"{moto.insurance_expires_on} (L1-10)."
                )
            )
            moto.insurance_alert_sent_on = today

        expired = self.search(
            [
                ("insurance_expires_on", "<", today),
                ("state", "not in", ["maintenance", "retired"]),
            ]
        )
        for moto in expired:
            # Critère 2 : blocage automatique de l'affectation, pas laissé à la vigilance d'un
            # gestionnaire. "maintenance" réutilise l'état déjà bloquant de L1-07 plutôt que
            # d'introduire une valeur de plus pour le même effet.
            moto.write({"state": "maintenance"})
            if moto.driver_id and moto.driver_id.is_online:
                moto.driver_id.write({"is_online": False})
