# Assistant de décision sur un dossier chauffeur (L9-01) : un simple bouton type="object" ne peut
# pas collecter le motif (rejet, suspension -- L1-06 critère 3) ni le choix de fiche employé
# (approbation -- L1-06 critère 1 bis) sans une saisie intermédiaire. Cet assistant transitoire
# la porte, puis délègue aux méthodes de babana.driver, seules dépositaires des règles (invariant
# 2). La réactivation, elle, ne prend aucun argument : elle reste un bouton direct sur la fiche.
from __future__ import annotations

from odoo import fields, models
from odoo.exceptions import UserError


class BabanaDriverDecision(models.TransientModel):
    _name = "babana.driver.decision"
    _description = "Décision sur un dossier chauffeur (L9-01)"

    driver_id = fields.Many2one(
        "babana.driver",
        string="Chauffeur",
        required=True,
        default=lambda self: self.env.context.get("active_id"),
    )
    driver_state = fields.Selection(related="driver_id.state", string="État actuel", readonly=True)
    decision = fields.Selection(
        [
            ("approve", "Approuver"),
            ("reject", "Rejeter"),
            ("suspend", "Suspendre"),
        ],
        required=True,
    )
    reason = fields.Text(
        string="Motif",
        help="Obligatoire pour un rejet ou une suspension (L1-06, critère 3). Voyage jusqu'à "
        "l'écran de suivi du chauffeur (AuthenticatedUser.driverRejectionReason).",
    )
    employee_mode = fields.Selection(
        [
            ("existing", "Rattacher à une fiche employé existante"),
            ("new", "Créer une nouvelle fiche employé"),
        ],
        default="existing",
        string="Fiche employé",
    )
    employee_id = fields.Many2one("hr.employee", string="Employé existant")
    new_employee_name = fields.Char(string="Nom de la nouvelle fiche")

    def action_confirm(self):
        self.ensure_one()
        if self.decision == "approve":
            if self.employee_mode == "existing":
                if not self.employee_id:
                    raise UserError("Choisir la fiche employé à rattacher.")
                self.driver_id.action_approve(employee_id=self.employee_id.id)
            else:
                if not (self.new_employee_name or "").strip():
                    raise UserError("Saisir le nom de la nouvelle fiche employé.")
                self.driver_id.action_approve(new_employee_name=self.new_employee_name.strip())
        elif self.decision == "reject":
            self.driver_id.action_reject(reason=self.reason)
        elif self.decision == "suspend":
            self.driver_id.action_suspend(reason=self.reason)
        return {"type": "ir.actions.act_window_close"}
