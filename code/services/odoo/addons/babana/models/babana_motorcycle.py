# La flotte de motos (L1-07, D6). L'entreprise possède les motos (D6, contrairement à un modèle
# de location par le chauffeur) ; ce module en tient l'inventaire, l'assurance et l'affectation
# courante. babana.assignment (L1-08) tiendra l'historique complet des affectations -- ce
# module-ci ne connaît que l'affectation active.
from __future__ import annotations

from odoo import api, fields, models
from odoo.exceptions import ValidationError

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
    _description = "Moto de la flotte (L1-07, D6)"
    _order = "license_plate"

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

    _sql_constraints = [
        (
            "babana_motorcycle_license_plate_unique",
            "unique(license_plate)",
            "Cette immatriculation est déjà enregistrée.",
        ),
    ]

    def _insurance_is_expired(self) -> bool:
        self.ensure_one()
        if not self.insurance_expires_on:
            return False
        return self.insurance_expires_on < fields.Date.context_today(self)

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
