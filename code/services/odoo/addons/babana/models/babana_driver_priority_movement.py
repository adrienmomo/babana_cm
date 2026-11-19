# Journal des points de course (19 novembre, amoa/questions/PRIORITE-2026-11-19.md) : une ligne par
# proposition expirée (−) et par course terminée (+), écrite dans la même transaction que la
# transition qui la cause et que le compteur babana.driver.ride_points -- aucune écriture de plus
# par événement métier (invariant 1). Le chauffeur le lit dans « Ma priorité » ; personne ne
# l'écrit à la main.
from __future__ import annotations

from odoo import fields, models


class BabanaDriverPriorityMovement(models.Model):
    _name = "babana.driver.priority.movement"
    _description = "Mouvement de points de course d'un chauffeur"
    _order = "occurred_at desc, id desc"

    driver_id = fields.Many2one(
        "babana.driver", string="Chauffeur", required=True, index=True, ondelete="cascade", readonly=True
    )
    ride_id = fields.Many2one("babana.ride", string="Course", ondelete="set null", readonly=True)
    kind = fields.Selection(
        [("missed", "Course non acceptée"), ("completed", "Course terminée")],
        string="Motif",
        required=True,
        readonly=True,
    )
    delta = fields.Integer(
        string="Points",
        required=True,
        readonly=True,
        help="Le barème du moment (−1, +1 par défaut). Le solde ne sort jamais des bornes : au "
        "plafond, un +1 laisse le solde inchangé.",
    )
    balance_after = fields.Integer(string="Solde après", required=True, readonly=True)
    occurred_at = fields.Datetime(string="Le", required=True, readonly=True, default=fields.Datetime.now)
