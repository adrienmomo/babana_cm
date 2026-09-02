# Affectation durable moto <-> chauffeur, avec historique (L1-08, D6 et D7 combinés :
# l'affectation est gérée par l'admin, non liée à une prise de service -- il n'y en a pas).
from __future__ import annotations

from datetime import datetime

from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError

# Borne haute conventionnelle pour comparer une affectation encore active (end_date vide, donc
# "jusqu'à nouvel ordre") aux affectations closes lors de la recherche de chevauchement.
_OPEN_ENDED = datetime.max


class BabanaAssignment(models.Model):
    _name = "babana.assignment"
    _description = "Affectation moto <-> chauffeur, avec historique (L1-08)"
    _order = "start_date desc"

    motorcycle_id = fields.Many2one(
        "babana.motorcycle", string="Moto", required=True, index=True, ondelete="restrict"
    )
    driver_id = fields.Many2one(
        "babana.driver", string="Chauffeur", required=True, index=True, ondelete="restrict"
    )
    start_date = fields.Datetime(
        string="Date de début", required=True, default=lambda self: fields.Datetime.now()
    )
    end_date = fields.Datetime(
        string="Date de fin",
        help="Vide tant que l'affectation est active. La clore ouvre potentiellement une "
        "nouvelle affectation pour la même moto ou le même chauffeur -- jamais les deux "
        "simultanément (voir les index partiels ci-dessous).",
    )
    author_id = fields.Many2one(
        "res.users", string="Auteur", required=True, default=lambda self: self.env.user,
        copy=False
    )

    _sql_constraints = [
        (
            "babana_assignment_end_after_start",
            "check(end_date is null or end_date >= start_date)",
            "La fin d'une affectation ne peut pas précéder son début.",
        ),
    ]

    def init(self):
        # Critères 1 et 2 : une moto -- ou un chauffeur -- a au plus une affectation active
        # (end_date vide) à la fois. Garantie de dernier recours au niveau base, même schéma que
        # babana_ride_one_active_per_driver/client (L4-01).
        self.env.cr.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS babana_assignment_one_active_per_motorcycle
            ON babana_assignment (motorcycle_id) WHERE end_date IS NULL
            """
        )
        self.env.cr.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS babana_assignment_one_active_per_driver
            ON babana_assignment (driver_id) WHERE end_date IS NULL
            """
        )

    def _check_no_overlap_on(self, field_name):
        self.ensure_one()
        target = self[field_name]
        siblings = self.search([(field_name, "=", target.id), ("id", "!=", self.id)])
        record_end = self.end_date or _OPEN_ENDED
        for sibling in siblings:
            sibling_end = sibling.end_date or _OPEN_ENDED
            if self.start_date < sibling_end and sibling.start_date < record_end:
                raise ValidationError(
                    "Les périodes d'affectation ne peuvent pas se chevaucher (L1-08) : cette "
                    f"période recoupe l'affectation {sibling.id}."
                )

    @api.constrains("motorcycle_id", "driver_id", "start_date", "end_date")
    def _check_no_overlapping_periods(self):
        # Au-delà de l'unicité de l'affectation active (index partiel ci-dessus), les périodes
        # -- closes comprises -- ne doivent jamais se recouvrir : l'historique sert en cas de
        # litige ou d'accident, où il faut savoir sans ambiguïté qui conduisait quoi et quand.
        for record in self:
            record._check_no_overlap_on("motorcycle_id")
            record._check_no_overlap_on("driver_id")

    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
        for record in records:
            if not record.end_date:
                record.motorcycle_id.write({"driver_id": record.driver_id.id})
        return records

    def write(self, vals):
        # Critère d'acceptation 4 : une affectation close (end_date renseigné) n'est plus
        # modifiable, y compris pour la clore une seconde fois -- l'historique n'est jamais
        # modifié ni supprimé (L1-08, spécification).
        for record in self:
            if record.end_date:
                raise UserError(
                    "Une affectation close n'est plus modifiable (L1-08, critère d'acceptation 4)."
                )

        result = super().write(vals)
        # L'écriture ORM ne pousse pas systématiquement `end_date` en base avant ce point --
        # trouvé en implémentant L1-08 : clore une affectation puis en créer aussitôt une autre
        # pour la même moto échouait sur l'index partiel `..._one_active_per_motorcycle`, alors
        # que la clôture avait bien réussi côté ORM. Le flush explicite garantit que l'INSERT
        # suivant (create(), qui passe par du SQL brut) voit la ligne réellement close.
        self.flush_recordset(["end_date"])

        if vals.get("end_date"):
            for record in self:
                if record.motorcycle_id.driver_id == record.driver_id:
                    record.motorcycle_id.write({"driver_id": False})
        return result

    def unlink(self):
        # L'historique n'est jamais supprimé (L1-08, spécification) -- pas seulement rendu
        # immuable une fois clos, mais jamais retiré, actif ou non.
        raise UserError("Une affectation ne se supprime jamais (L1-08) : elle se clôt.")
