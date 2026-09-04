# État du journal d'audit (D68, 01-architecture.md §9 decies). Non stocké, recalculé à chaque
# ouverture -- même patron que babana_cash_dashboard.py : un TransientModel dont default_get()
# lit un état externe, pas un modèle persistant à tenir à jour.
#
# Le support qu'il lit (ir.config_parameter, écrit par
# babana_audit_log.py::_babana_record_failure_beacon) est délibérément indépendant de
# babana.audit.log : un compteur logé dans le modèle qui vient de casser casserait avec lui
# (D68). Le signal n'est donc PAS auto-effacé par la prochaine écriture réussie -- un échec
# intermittent redevenu vert au prochain événement resterait sinon invisible pour l'administrateur
# qui ouvre cet écran après coup. Il ne s'efface que par un geste humain explicite
# (action_acknowledge), volontairement du même ordre qu'un accusé de réception.
from __future__ import annotations

from odoo import api, fields, models

from .babana_audit_log import (
    AUDIT_LOG_FAILURE_COUNT_PARAM,
    AUDIT_LOG_FAILURE_LAST_AT_PARAM,
    AUDIT_LOG_FAILURE_LAST_ERROR_PARAM,
    AUDIT_LOG_FAILURE_LAST_EVENT_PARAM,
    AUDIT_LOG_FAILURE_LAST_MODEL_PARAM,
)

_ACKNOWLEDGE_PARAMS = (
    AUDIT_LOG_FAILURE_COUNT_PARAM,
    AUDIT_LOG_FAILURE_LAST_AT_PARAM,
    AUDIT_LOG_FAILURE_LAST_EVENT_PARAM,
    AUDIT_LOG_FAILURE_LAST_MODEL_PARAM,
    AUDIT_LOG_FAILURE_LAST_ERROR_PARAM,
)


class BabanaAuditLogHealth(models.TransientModel):
    _name = "babana.audit.log.health"
    _description = "État du journal d'audit (D68)"

    has_failure = fields.Boolean(
        string="Échec détecté",
        readonly=True,
        help="Au moins un échec d'écriture du journal d'audit depuis le dernier accusé de "
        "réception -- pas nécessairement en cours, mais jamais constaté par un administrateur.",
    )
    failure_count = fields.Integer(
        string="Échecs depuis le dernier accusé de réception", readonly=True
    )
    last_failure_at = fields.Datetime(string="Dernier échec le", readonly=True)
    last_failure_event = fields.Char(string="Événement concerné", readonly=True)
    last_failure_model_name = fields.Char(string="Modèle concerné", readonly=True)
    last_failure_error = fields.Text(string="Erreur", readonly=True)

    @api.model
    def default_get(self, fields_list):
        defaults = super().default_get(fields_list)
        Param = self.env["ir.config_parameter"].sudo()
        count = int(Param.get_param(AUDIT_LOG_FAILURE_COUNT_PARAM, "0") or "0")
        defaults.update(
            {
                "has_failure": count > 0,
                "failure_count": count,
                "last_failure_at": Param.get_param(AUDIT_LOG_FAILURE_LAST_AT_PARAM) or False,
                "last_failure_event": Param.get_param(AUDIT_LOG_FAILURE_LAST_EVENT_PARAM) or False,
                "last_failure_model_name": Param.get_param(AUDIT_LOG_FAILURE_LAST_MODEL_PARAM)
                or False,
                "last_failure_error": Param.get_param(AUDIT_LOG_FAILURE_LAST_ERROR_PARAM) or False,
            }
        )
        return defaults

    def action_refresh(self):
        # Rouvre une instance fraîche : default_get() ci-dessus relit le signal -- rien à
        # écrire sur l'enregistrement transitoire existant (même geste que
        # babana_cash_dashboard.py::action_refresh).
        return {
            "type": "ir.actions.act_window",
            "name": "État du journal d'audit",
            "res_model": "babana.audit.log.health",
            "view_mode": "form",
            "target": "current",
        }

    def action_acknowledge(self):
        """Efface le signal -- volontairement un geste humain distinct de « ça a réussi la
        prochaine fois » : un échec intermittent doit rester visible jusqu'à ce que quelqu'un
        l'ait réellement vu, pas jusqu'à ce que le prochain événement écrive sans encombre."""
        Param = self.env["ir.config_parameter"].sudo()
        for key in _ACKNOWLEDGE_PARAMS:
            Param.set_param(key, False)
        return self.action_refresh()
