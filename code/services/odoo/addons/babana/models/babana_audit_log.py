# Journal d'audit immuable (L8-09, D67). Point d'écriture unique pour les événements que la
# spécification rend obligatoires : chaque transition de course (relayée par
# babana_ride_state.py::_babana_journalize, en place depuis le premier jour), chaque mouvement de
# compte courant, chaque remise et sa validation, chaque changement d'état de chauffeur, chaque
# ajustement (un mouvement de compte courant comme un autre), et chaque accès à un document
# chauffeur (controllers/documents.py, babana_driver_document.py -- le seul de la liste qui ne
# passe par aucune transition).
#
# Immuable au niveau du MODÈLE, pas par règle d'enregistrement : les règles ne s'appliquent pas
# en `sudo` (D54, 01-architecture.md §9 quinquies) -- une garde qui ne s'exécute jamais ne
# garantit rien. write()/unlink() lèvent donc inconditionnellement, y compris pour un
# administrateur ; seule la purge planifiée (_cron_purge) franchit l'immutabilité, par un
# drapeau de contexte posé uniquement par elle-même -- même patron que
# babana_ride_state.py::_babana_write_transition pour `state`.
#
# Écriture PostgreSQL ordinaire, dans la transaction de l'opération qu'elle journalise (D58,
# 01-architecture.md §2 quater) -- jamais au commit : elle n'a rien de la catégorie que D32/D33
# protègent (un appel sortant vers le service temps réel, qu'un ROLLBACK ne peut pas défaire).
# Mais elle ne doit JAMAIS faire échouer l'opération métier (critère d'acceptation 3) : un
# savepoint dédié absorbe tout échec de l'écriture elle-même sans laisser l'erreur remonter.
#
# D68 (01-architecture.md §9 decies) : critère 3 (ne jamais lever) et critère 2 (personne ne peut
# écrire) composaient un silence -- un échec d'écriture n'avait plus d'autre trace que
# `_logger.exception`, c'est-à-dire le journal applicatif que ce modèle existe pour remplacer.
# `_babana_record_failure_beacon` ci-dessous pose donc un signal ailleurs (`ir.config_parameter`),
# visible depuis `babana.audit.log.health` (babana_audit_log_health.py) sans ouvrir un fichier de
# logs.
from __future__ import annotations

import json
import logging
from datetime import timedelta

from odoo import api, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

# Durée de rétention paramétrable (invariant 5), jamais codée en dur dans la purge. Valeur de
# repli volontairement généreuse (deux ans) en attendant que L8-10 (hors de ce lot) affine la
# durée par catégorie : un journal qui sert à trancher un litige ne doit pas disparaître avant
# qu'on ait pu le consulter.
AUDIT_LOG_RETENTION_DAYS_PARAM = "babana.audit_log_retention_days"
AUDIT_LOG_RETENTION_DAYS_FALLBACK = 730

# D68 (01-architecture.md §9 decies) : le signal d'échec de journalisation vit dans
# ir.config_parameter -- un support qui ne dépend pas de ce qui vient d'échouer, donc encore
# lisible même si babana_audit_log est ce qui casse. Lu par babana_audit_log_health.py, jamais
# par babana.audit.log lui-même en dehors de l'écriture du signal ci-dessous.
AUDIT_LOG_FAILURE_COUNT_PARAM = "babana.audit_log_failure_count"
AUDIT_LOG_FAILURE_LAST_AT_PARAM = "babana.audit_log_failure_last_at"
AUDIT_LOG_FAILURE_LAST_EVENT_PARAM = "babana.audit_log_failure_last_event"
AUDIT_LOG_FAILURE_LAST_MODEL_PARAM = "babana.audit_log_failure_last_model"
AUDIT_LOG_FAILURE_LAST_ERROR_PARAM = "babana.audit_log_failure_last_error"


def _to_json(value):
    if not value:
        return False
    return json.dumps(value, default=str, ensure_ascii=False)


class BabanaAuditLog(models.Model):
    _name = "babana.audit.log"
    _description = "Journal d'audit immuable (L8-09)"
    _order = "create_date desc, id desc"

    actor_id = fields.Many2one(
        "res.users",
        string="Acteur",
        ondelete="set null",
        readonly=True,
        help="Utilisateur au nom duquel l'événement a eu lieu -- le mobile authentifié, un "
        "gestionnaire du back-office, ou OdooBot pour un traitement planifié.",
    )
    event = fields.Char(string="Événement", required=True, readonly=True, index=True)
    model_name = fields.Char(string="Modèle concerné", required=True, readonly=True, index=True)
    res_id = fields.Integer(string="Enregistrement concerné", readonly=True, index=True)
    record_reference = fields.Char(
        string="Référence lisible",
        readonly=True,
        help="Référence humaine de l'enregistrement au moment de l'événement (référence de "
        "course ou de remise, nom du chauffeur...) -- pour retrouver un litige sans repasser "
        "par l'identifiant technique.",
    )
    before = fields.Text(
        string="Avant",
        readonly=True,
        help="Valeurs pertinentes avant l'événement, sérialisées en JSON -- vide à la création "
        "d'un enregistrement (critère d'acceptation 4).",
    )
    after = fields.Text(
        string="Après",
        readonly=True,
        help="Valeurs pertinentes après l'événement, sérialisées en JSON (critère "
        "d'acceptation 4).",
    )
    context_json = fields.Text(
        string="Contexte technique",
        readonly=True,
        help="Détails complémentaires de l'événement (motif, montants, ttl d'un accès "
        "document...), sérialisés en JSON.",
    )

    def write(self, vals):
        raise UserError(
            "Le journal d'audit est immuable : ni modification, ni suppression, y compris pour "
            "un administrateur (L8-09, critère d'acceptation 2)."
        )

    def unlink(self):
        if not self.env.context.get("babana_allow_audit_log_purge"):
            raise UserError(
                "Le journal d'audit est immuable : ni modification, ni suppression, y compris "
                "pour un administrateur, hors de la purge planifiée par rétention (L8-09, "
                "critère d'acceptation 2)."
            )
        return super().unlink()

    @api.model
    def _babana_record(
        self,
        *,
        event,
        model_name,
        res_id=None,
        record_reference=None,
        actor=None,
        before=None,
        after=None,
        **context,
    ):
        """Point d'écriture unique du journal. Ne lève jamais (critère d'acceptation 3) : un
        savepoint dédié absorbe tout échec de l'écriture elle-même -- l'opération métier qui
        vient de se produire se poursuit sans savoir que sa trace a pu se perdre ; seul le
        journal applicatif (`_logger`) le sait, exactement comme la journalisation de secours
        que `_babana_journalize` posait déjà avant cette tâche."""
        actor_id = actor.id if actor else self.env.user.id
        try:
            with self.env.cr.savepoint():
                self.sudo().create(
                    {
                        "actor_id": actor_id,
                        "event": event,
                        "model_name": model_name,
                        "res_id": res_id or 0,
                        "record_reference": record_reference,
                        "before": _to_json(before),
                        "after": _to_json(after),
                        "context_json": _to_json(context) if context else False,
                    }
                )
        except Exception as exc:  # noqa: BLE001 - ne doit jamais faire échouer l'opération métier
            _logger.exception(
                "babana.audit.log : échec de journalisation de '%s' sur %s#%s -- l'opération "
                "métier se poursuit (critère d'acceptation 3, L8-09).",
                event, model_name, res_id,
            )
            self._babana_record_failure_beacon(event, model_name, exc)

    @api.model
    def _babana_record_failure_beacon(self, event, model_name, error):
        """D68 : la seule trace d'un échec de `_babana_record` ci-dessus ne doit pas rester
        dans le journal applicatif que L8-09 existe pour remplacer -- sinon la traçabilité peut
        s'arrêter sans que personne ne l'apprenne. Écrit dans `ir.config_parameter`, jamais dans
        `babana.audit.log` (un compteur logé dans le modèle qui vient de casser casserait avec
        lui). Même garde que `_babana_record` : ne doit JAMAIS lever, y compris si cette
        écriture-ci échoue à son tour -- un savepoint dédié l'isole, comme pour le journal
        lui-même."""
        try:
            with self.env.cr.savepoint():
                Param = self.env["ir.config_parameter"].sudo()
                count = int(Param.get_param(AUDIT_LOG_FAILURE_COUNT_PARAM, "0") or "0")
                Param.set_param(AUDIT_LOG_FAILURE_COUNT_PARAM, str(count + 1))
                Param.set_param(
                    AUDIT_LOG_FAILURE_LAST_AT_PARAM, fields.Datetime.to_string(fields.Datetime.now())
                )
                Param.set_param(AUDIT_LOG_FAILURE_LAST_EVENT_PARAM, event or "")
                Param.set_param(AUDIT_LOG_FAILURE_LAST_MODEL_PARAM, model_name or "")
                Param.set_param(AUDIT_LOG_FAILURE_LAST_ERROR_PARAM, str(error)[:500])
        except Exception:  # noqa: BLE001 - même garde : ce signal-ci ne doit pas non plus lever
            _logger.exception(
                "babana.audit.log : échec de l'écriture du signal de panne lui-même, pour "
                "l'échec de journalisation de '%s' sur %s.", event, model_name,
            )

    @api.model
    def _cron_purge(self):
        """Purge par rétention (critère d'acceptation 5). Seul appelant du drapeau de contexte
        qui franchit l'immutabilité ci-dessus -- jamais posé ailleurs."""
        retention_days = int(
            self.env["ir.config_parameter"]
            .sudo()
            .get_param(AUDIT_LOG_RETENTION_DAYS_PARAM, AUDIT_LOG_RETENTION_DAYS_FALLBACK)
        )
        threshold = fields.Datetime.now() - timedelta(days=retention_days)
        expired = self.sudo().search([("create_date", "<", threshold)])
        expired.with_context(babana_allow_audit_log_purge=True).unlink()
