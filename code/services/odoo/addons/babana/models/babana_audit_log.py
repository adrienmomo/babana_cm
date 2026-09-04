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
        except Exception:  # noqa: BLE001 - ne doit jamais faire échouer l'opération métier
            _logger.exception(
                "babana.audit.log : échec de journalisation de '%s' sur %s#%s -- l'opération "
                "métier se poursuit (critère d'acceptation 3, L8-09).",
                event, model_name, res_id,
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
