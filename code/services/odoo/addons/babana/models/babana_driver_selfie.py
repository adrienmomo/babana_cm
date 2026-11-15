# Contrôle par selfie (15 novembre, demande du maître d'ouvrage) : le chauffeur prend une photo de
# lui-même, à la caméra avant, au moins toutes les `babana.selfie_interval_hours` heures (24 par
# défaut) ; un gestionnaire la compare à la photo de profil validée.
#
# Réponses du maître d'ouvrage : le chauffeur travaille pendant la revue (un selfie en attente
# compte) ; un selfie refusé le met hors ligne (à la fin de la course en cours) et en demande un
# nouveau ; un selfie dû est demandé au passage en ligne. Pas de reconnaissance faciale
# automatique (service payant, nouvelle dépendance).
#
# Une écriture par selfie pris et par décision de revue -- des décisions humaines (invariant 1).
from __future__ import annotations

from datetime import timedelta

from odoo import api, fields, models
from odoo.exceptions import ValidationError

SELFIE_INTERVAL_HOURS_PARAM = "babana.selfie_interval_hours"
SELFIE_INTERVAL_HOURS_DEFAULT = 24
SELFIE_MIME_TYPES = ("image/jpeg", "image/png")

SELFIE_STATES = [
    ("pending", "À vérifier"),
    ("approved", "Validé"),
    ("rejected", "Refusé"),
]


class BabanaDriverSelfie(models.Model):
    _name = "babana.driver.selfie"
    _description = "Selfie de contrôle du chauffeur"
    _order = "taken_at desc, id desc"

    driver_id = fields.Many2one("babana.driver", required=True, index=True, ondelete="cascade", string="Chauffeur")
    storage_key = fields.Char(required=True, readonly=True, copy=False)
    mime_type = fields.Char(readonly=True)
    taken_at = fields.Datetime(string="Pris le", required=True, readonly=True, default=fields.Datetime.now, index=True)
    state = fields.Selection(SELFIE_STATES, string="État", default="pending", required=True, readonly=True, index=True)
    rejection_reason = fields.Text(string="Motif du refus", readonly=True)
    reviewed_by_id = fields.Many2one("res.users", string="Vérifié par", readonly=True)
    reviewed_at = fields.Datetime(string="Vérifié le", readonly=True)

    @api.constrains("mime_type")
    def _check_is_an_image(self):
        for record in self:
            if record.mime_type and record.mime_type not in SELFIE_MIME_TYPES:
                raise ValidationError("Un selfie est une image (JPEG ou PNG).")

    @api.model
    def _interval_hours(self) -> int:
        try:
            value = int(self.env["ir.config_parameter"].sudo().get_param(SELFIE_INTERVAL_HOURS_PARAM, SELFIE_INTERVAL_HOURS_DEFAULT))
        except (TypeError, ValueError):
            return SELFIE_INTERVAL_HOURS_DEFAULT
        return value if value > 0 else SELFIE_INTERVAL_HOURS_DEFAULT

    @api.model
    def _latest_for(self, driver):
        return self.sudo().search([("driver_id", "=", driver.id)], limit=1)

    @api.model
    def _status_for(self, driver) -> dict:
        """Ce que l'app montre : faut-il un selfie, et pourquoi. Un selfie en attente ou validé de
        moins de `interval` heures suffit ; le dernier refusé en exige un nouveau."""
        latest = self._latest_for(driver)
        interval = timedelta(hours=self._interval_hours())
        now = fields.Datetime.now()
        if not latest:
            return {"due": True, "lastState": None, "rejectionReason": None, "dueAt": None}
        due_at = latest.taken_at + interval
        due = latest.state == "rejected" or due_at <= now
        return {
            "due": due,
            "lastState": latest.state,
            "rejectionReason": latest.rejection_reason if latest.state == "rejected" else None,
            "dueAt": due_at,
        }

    def action_approve(self):
        for record in self:
            if record.state != "pending":
                continue
            record.write({"state": "approved", "reviewed_by_id": self.env.uid, "reviewed_at": fields.Datetime.now()})
            record.driver_id.message_post(body="Selfie validé.")

    def action_reject(self, *, reason):
        if not (reason or "").strip():
            raise ValidationError("Le motif est obligatoire pour refuser un selfie.")
        for record in self:
            if record.state != "pending":
                continue
            record.write(
                {"state": "rejected", "rejection_reason": reason, "reviewed_by_id": self.env.uid, "reviewed_at": fields.Datetime.now()}
            )
            record.driver_id.message_post(body="Selfie refusé : %s" % reason)
            # Réponse du maître d'ouvrage : hors ligne -- à la fin de la course en cours s'il en a
            # une, jamais au milieu -- et un nouveau selfie sera demandé.
            record.driver_id.sudo()._babana_enforce_compliance()

    def action_open_reject_wizard(self):
        self.ensure_one()
        return {
            "type": "ir.actions.act_window",
            "res_model": "babana.driver.selfie.reject.wizard",
            "view_mode": "form",
            "target": "new",
            "context": {"default_selfie_id": self.id},
        }

    def action_preview(self):
        """Ouvre le selfie (URL signée à durée limitée), comme `babana.driver.document`."""
        from ..services import storage

        self.ensure_one()
        visible = self.search([("id", "=", self.id)])
        if not visible:
            raise ValidationError("Selfie introuvable ou accès refusé.")
        url = storage.generate_signed_url(self.sudo().storage_key, ttl_seconds=storage.default_url_ttl_seconds(self.env))
        return {"type": "ir.actions.act_url", "url": url, "target": "new"}

    def action_preview_profile_photo(self):
        """La photo de profil validée du chauffeur, pour la comparaison."""
        self.ensure_one()
        photo = self.env["babana.driver.document"].search(
            [("driver_id", "=", self.driver_id.id), ("document_type", "=", "profile_photo"), ("verification_status", "=", "verified")],
            limit=1,
        )
        if not photo:
            raise ValidationError("Ce chauffeur n'a pas encore de photo de profil validée.")
        return photo.action_preview()


class BabanaDriverSelfieRejectWizard(models.TransientModel):
    _name = "babana.driver.selfie.reject.wizard"
    _description = "Refus d'un selfie (motif)"

    selfie_id = fields.Many2one("babana.driver.selfie", required=True)
    reason = fields.Text(string="Motif", required=True)

    def action_confirm(self):
        self.ensure_one()
        self.selfie_id.action_reject(reason=self.reason)
        return {"type": "ir.actions.act_window_close"}
