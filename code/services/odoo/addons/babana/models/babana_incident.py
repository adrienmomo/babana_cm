# Bouton d'urgence (L8-04, CDC §II.6). Un incident se déclenche depuis le client ou le chauffeur
# pendant une course active (babana_ride.py::TOGETHER_STATES) -- jamais une transition de course
# (invariant 2), et la course elle-même ne s'arrête pas : la décision de couper une course en
# alerte revient à un humain au back-office, jamais à un automatisme (spécification, point 4).
from __future__ import annotations

import logging
import uuid

from odoo import api, fields, models

_logger = logging.getLogger(__name__)

INCIDENT_TYPES = [
    ("emergency", "Urgence"),
]

INCIDENT_STATUSES = [
    ("open", "Ouvert"),
    ("acknowledged", "Pris en charge"),
    ("closed", "Clôturé"),
]


class BabanaIncident(models.Model):
    _name = "babana.incident"
    # Même défaut que babana.cash.remittance et babana.cash.discrepancy : sans ceci, le
    # formulaire back-office (<chatter/>, babana_incident_views.xml) plante à l'ouverture
    # (AttributeError sur _get_thread_with_access) -- constaté en revue visuelle du 2 septembre.
    _inherit = ["mail.thread"]
    _description = "Incident déclenché pendant une course (L8-04)"
    _order = "create_date desc, id desc"

    ride_id = fields.Many2one(
        "babana.ride", string="Course", required=True, index=True, ondelete="restrict"
    )
    public_id = fields.Char(
        index=True,
        copy=False,
        default=lambda self: str(uuid.uuid4()),
        help="Identifiant exposé à l'API mobile -- jamais l'identifiant Odoo interne, "
        "séquentiel et devinable (même discipline que babana.ride.public_id).",
    )
    trigger_actor = fields.Selection(
        [("client", "Client"), ("driver", "Chauffeur")],
        string="Déclenché par",
        required=True,
        readonly=True,
    )
    trigger_user_id = fields.Many2one(
        "res.users", string="Utilisateur à l'origine", required=True, ondelete="restrict",
        readonly=True
    )
    incident_type = fields.Selection(
        INCIDENT_TYPES, string="Type d'incident", default="emergency", required=True,
        readonly=True
    )
    latitude = fields.Float(
        string="Latitude", required=True, digits=(10, 6), readonly=True,
        help="Position exacte au déclenchement."
    )
    longitude = fields.Float(string="Longitude", required=True, digits=(10, 6), readonly=True)
    triggered_at = fields.Datetime(
        string="Déclenché à",
        required=True,
        readonly=True,
        help="Horodatage d'origine posé côté appareil -- distinct de create_date quand la "
        "requête a été mise en file hors connexion puis rejouée une fois le réseau revenu "
        "(critère d'acceptation 6).",
    )

    status = fields.Selection(
        INCIDENT_STATUSES, string="Statut", default="open", required=True, index=True
    )
    handled_by_id = fields.Many2one("res.users", string="Traité par", readonly=True)
    handled_at = fields.Datetime(string="Traité à", readonly=True)
    resolution_notes = fields.Text(string="Notes de résolution", readonly=True)

    emergency_contact_phone = fields.Char(
        string="Contact d'urgence",
        readonly=True,
        help="Copie de res.partner.babana_emergency_contact au moment du déclenchement -- une "
        "correction ultérieure de la fiche client ne doit pas réécrire l'histoire d'un incident "
        "déjà traité.",
    )
    emergency_contact_notified = fields.Boolean(
        string="Contact d'urgence prévenu", readonly=True, default=False
    )

    _sql_constraints = [
        (
            "babana_incident_public_id_unique",
            "unique(public_id)",
            "Collision d'identifiant public d'incident -- ne devrait jamais se produire (UUID).",
        ),
    ]

    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
        records._notify_emergency_contact()
        return records

    def _notify_emergency_contact(self):
        """Critère d'acceptation 4. Aucun relais SMS n'est intégré à ce dépôt (même situation
        que le masquage téléphonique, D42 : « une intégration téléphonique entière », hors de ce
        lot) -- la notification réelle est donc journalisée plutôt que réellement envoyée,
        jamais présentée comme délivrée. `emergency_contact_notified` ne veut donc dire ici que
        « un contact existait et l'intention de le notifier a été enregistrée », pas qu'un SMS
        est réellement parti. C'est un point d'intégration explicite, pas un relais fantôme :
        voir amoa/questions/L8-04-emergency-contact-relay.md."""
        for record in self:
            phone = record.ride_id.client_id.babana_emergency_contact
            if not phone:
                continue
            record.write({"emergency_contact_phone": phone, "emergency_contact_notified": True})
            _logger.warning(
                "[L8-04] contact d'urgence à notifier pour l'incident %s (course %s) : %s -- "
                "aucun relais SMS réel intégré, voir amoa/questions/"
                "L8-04-emergency-contact-relay.md",
                record.id,
                record.ride_id.reference,
                phone,
            )

    def action_acknowledge(self, *, user):
        self.ensure_one()
        self.write({"status": "acknowledged", "handled_by_id": user.id, "handled_at": fields.Datetime.now()})

    def action_close(self, *, user, notes=None):
        self.ensure_one()
        self.write(
            {
                "status": "closed",
                "handled_by_id": user.id,
                "handled_at": fields.Datetime.now(),
                "resolution_notes": notes,
            }
        )

    def button_acknowledge(self):
        """Bouton du formulaire (babana_incident_views.xml) -- self.env.user est le superviseur
        connecté, jamais transmis par le formulaire lui-même."""
        self.action_acknowledge(user=self.env.user)

    def button_close(self):
        """`resolution_notes` est déjà saisi sur le formulaire avant ce clic (le champ reste
        modifiable tant que status != 'closed', voir la vue) -- Odoo sauvegarde l'enregistrement
        avant d'appeler ce bouton, la valeur à l'écran est donc déjà celle de self."""
        self.action_close(user=self.env.user, notes=self.resolution_notes)
