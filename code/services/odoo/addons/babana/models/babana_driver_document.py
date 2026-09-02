# Documents chauffeur (L1-05, É2). Seuls le permis et la pièce d'identité sont demandés au
# chauffeur -- la carte grise appartient à la flotte (babana.motorcycle, L1-07), pas à lui.
#
# Le contenu du fichier lui-même ne vit jamais dans Odoo/PostgreSQL : storage_key pointe vers un
# objet du compartiment S3/MinIO babana-documents (créé sans accès anonyme, L0-01). Toute lecture
# passe par une URL signée à durée limitée (services/storage.py, controllers/documents.py) --
# jamais un accès direct à storage_key depuis un client.
from __future__ import annotations

from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError

from ..services import storage

DOCUMENT_TYPES = [("license", "Permis de conduire"), ("id_card", "Pièce d'identité")]
VERIFICATION_STATUSES = [
    ("pending", "En attente"),
    ("verified", "Vérifié"),
    ("rejected", "Rejeté"),
]


class BabanaDriverDocument(models.Model):
    _name = "babana.driver.document"
    _description = "Document chauffeur (L1-05)"
    _order = "create_date desc"

    driver_id = fields.Many2one(
        "babana.driver", required=True, index=True, ondelete="cascade"
    )
    document_type = fields.Selection(DOCUMENT_TYPES, string="Type de document", required=True)
    storage_key = fields.Char(
        required=True,
        readonly=True,
        copy=False,
        help="Clé de l'objet dans le compartiment S3/MinIO babana-documents. Jamais exposée "
        "telle quelle à un client -- seule une URL signée à durée limitée l'est.",
    )
    mime_type = fields.Char(
        readonly=True, help="Type MIME réel, détecté par signature (services/storage.py), pas "
        "l'extension ni le type déclaré par l'appelant."
    )
    expires_on = fields.Date(
        string="Expire le",
        help="Date d'expiration. Obligatoire pour un permis (critère d'acceptation 5) -- "
        "contrainte ci-dessous."
    )
    verification_status = fields.Selection(
        VERIFICATION_STATUSES, string="État de vérification", default="pending", required=True
    )
    rejection_reason = fields.Text(
        string="Motif de rejet",
        help="Motif, renseigné quand verification_status='rejected'.",
    )
    alert_sent_on = fields.Date(
        help="Idempotence de la tâche planifiée d'alerte d'échéance (L1-10, critère "
        "d'acceptation 4) -- porté par le document plutôt que par babana.driver : un chauffeur "
        "qui téléverse un nouveau permis après rejet doit pouvoir être realerté sur la nouvelle "
        "échéance, indépendamment de l'historique de l'ancien document."
    )

    @api.constrains("document_type", "expires_on")
    def _check_license_requires_expiry(self):
        # Critère d'acceptation 5 de L1-05. La pièce d'identité n'a pas cette obligation : rien
        # dans la spécification n'exige une date d'expiration pour id_card.
        for record in self:
            if record.document_type == "license" and not record.expires_on:
                raise ValidationError(
                    "La date d'expiration est obligatoire pour un permis de conduire (L1-05, "
                    "critère d'acceptation 5)."
                )

    @api.constrains("verification_status", "rejection_reason")
    def _check_rejected_requires_reason(self):
        # L6-15, critère 3 : « le rejet se dit avec son motif ». Un document rejeté sans motif
        # renvoie le chauffeur au support, ce qui coûte plus cher que le motif -- même règle que
        # babana.driver.rejection_reason pour le dossier entier. Vaut pour toute écriture, y
        # compris l'édition inline depuis la vue back-office.
        for record in self:
            if record.verification_status == "rejected" and not (record.rejection_reason or "").strip():
                raise ValidationError(
                    "Le motif est obligatoire pour rejeter un document (L6-15, critère 3)."
                )

    def action_preview(self):
        """Ouvre le fichier de la pièce (permis, carte d'identité) dans un nouvel onglet, via
        l'URL signée à durée limitée de L1-05 -- jamais une URL publique, jamais l'accès direct à
        `storage_key`. C'est le chemin que la validation de dossier L9-01 emprunte : un
        gestionnaire regarde la pièce avant de la vérifier ou de la rejeter.

        D54 (amoa/questions/REPONSES-2026-09-08.md §2, même patron que
        controllers/documents.py::_signed_url) : le contrôle d'accès passe par un `search` au nom
        de l'appelant, pas par `sudo` ni `exists()` -- `exists()` ignorerait les règles
        d'enregistrement. Un gestionnaire voit la ligne (droit `group_babana_manager`) ; un
        utilisateur portail (client) n'a aucune ligne `ir.model.access` sur ce modèle et ne peut
        pas l'atteindre. « Un gestionnaire a le droit, un client non, et c'est la règle qui le
        dit » (prompt J33)."""
        self.ensure_one()
        visible = self.search([("id", "=", self.id)])
        if not visible:
            raise UserError("Document introuvable ou accès refusé.")
        if not visible.storage_key:
            raise UserError("Ce document n'a pas de fichier associé.")
        ttl_seconds = storage.default_url_ttl_seconds(self.env)
        url = storage.generate_signed_url(visible.storage_key, ttl_seconds=ttl_seconds)
        return {"type": "ir.actions.act_url", "url": url, "target": "new"}

    def action_verify(self):
        """Marque le(s) document(s) vérifié(s) (L6-15, back-office). L'écriture sur
        babana.driver.document est réservée au gestionnaire (ir.model.access.csv) ; l'assistant
        de saisie et les boutons de la vue restent L9-01, cette méthode est utilisable dès
        maintenant depuis le shell ou l'édition inline de la vue chauffeur. Journalisé au fil du
        dossier (L1-06 fait de même pour l'état du dossier)."""
        for record in self:
            record.write({"verification_status": "verified", "rejection_reason": False})
            record.driver_id.message_post(
                body="Document « %s » vérifié." % dict(DOCUMENT_TYPES)[record.document_type]
            )

    def action_reject(self, *, reason):
        """Rejette le(s) document(s) avec un motif obligatoire, transmis au chauffeur via
        GET /api/v1/driver/documents (L6-15, critère 3). La notification push dédiée est L7-03,
        hors de ce lot."""
        if not (reason or "").strip():
            raise ValidationError(
                "Le motif est obligatoire pour rejeter un document (L6-15, critère 3)."
            )
        for record in self:
            record.write({"verification_status": "rejected", "rejection_reason": reason})
            record.driver_id.message_post(
                body="Document « %s » rejeté : %s"
                % (dict(DOCUMENT_TYPES)[record.document_type], reason)
            )
