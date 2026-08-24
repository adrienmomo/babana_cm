# Partage de trajet (L8-03, CDC §II.6). Odoo possède le jeton et sa validité -- le service
# temps réel (services/realtime/src/share/) ne fait jamais confiance à une expiration calculée
# de son côté, il la redemande à chaque page servie (voir controllers/internal.py::
# resolve_ride_share). Invariant 1 respecté : rien de ceci n'écrit à un tick GPS, seules la
# création et la révocation du jeton sont des événements métier.
from __future__ import annotations

import secrets
from datetime import timedelta

from odoo import api, fields, models

# Durée de vie du lien après la fin de la course (L9-06, table des paramètres de dispatch) --
# assez courte pour qu'un lien oublié dans une conversation WhatsApp ne reste pas éternellement
# consultable, assez longue pour qu'un proche qui l'ouvre juste après l'arrivée voie encore
# quelque chose plutôt qu'une page "trajet terminé" immédiate.
SHARE_LINK_GRACE_MINUTES_PARAM = "babana.share_link_grace_minutes"
SHARE_LINK_GRACE_MINUTES_FALLBACK = 30

# États où la course est physiquement terminée -- le partage n'a plus de raison de rester
# "en direct" au-delà du délai de grâce. `settled` implique toujours `completed` (une course
# s'encaisse après être arrivée, jamais avant, C-03) : `completed_at` reste donc posé même une
# fois `settled`, et c'est lui qui compte comme fin réelle du trajet -- pas `settled_at`, qui
# peut survenir bien après si l'encaissement traîne, ce qui prolongerait à tort un lien déjà
# périmé du point de vue du proche qui le suit.
#
# `rejected` en est délibérément absent : ce n'est pas un état terminal pour le client (D11) --
# une course refusée par un chauffeur retourne à la sélection, jamais à une fin de trajet, et
# babana.ride ne porte d'ailleurs aucun horodatage de refus (seul babana.ride.rejection, par
# chauffeur, en porte un).
_ENDED_STATES = ("settled", "completed", "cancelled")


class BabanaRideShare(models.Model):
    _name = "babana.ride.share"
    _description = "Jeton de partage de trajet public (L8-03)"
    _order = "create_date desc, id desc"

    ride_id = fields.Many2one("babana.ride", required=True, index=True, ondelete="restrict")
    token = fields.Char(required=True, index=True, copy=False, readonly=True)
    revoked_at = fields.Datetime(readonly=True)

    _sql_constraints = [
        (
            "babana_ride_share_token_unique",
            "unique(token)",
            "Collision de jeton de partage -- ne devrait jamais se produire (aléa cryptographique).",
        ),
    ]

    @api.model
    def _generate_token(self) -> str:
        # 32 octets d'aléa (secrets, générateur cryptographique -- critère d'acceptation 1),
        # jamais dérivé de ride.public_id ou de ride.id : deviner l'un ne doit rien apprendre
        # sur l'autre. token_urlsafe produit ~43 caractères, assez long pour être non devinable
        # par force brute et assez court pour tenir dans une URL lisible sur petit écran.
        return secrets.token_urlsafe(32)

    @api.model
    def action_get_or_create(self, ride):
        """Réutilise le jeton actif existant plutôt que d'en émettre un nouveau à chaque appel
        (le client peut rouvrir l'écran de suivi et redéclencher le partage plusieurs fois pour
        la même course) -- un lien déjà envoyé par SMS doit rester le même lien, pas un nouveau
        qui invaliderait silencieusement celui déjà entre les mains du proche."""
        existing = self.sudo().search(
            [("ride_id", "=", ride.id), ("revoked_at", "=", False)], limit=1
        )
        if existing:
            return existing
        return self.sudo().create({"ride_id": ride.id, "token": self._generate_token()})

    def action_revoke(self):
        # Idempotent (critère d'acceptation 4, "immédiate") : révoquer un jeton déjà révoqué ne
        # doit jamais échouer, un client qui appuie deux fois sur "arrêter le partage" ne doit
        # jamais voir d'erreur.
        for record in self:
            if not record.revoked_at:
                record.write({"revoked_at": fields.Datetime.now()})

    def _is_expired(self) -> bool:
        self.ensure_one()
        if self.revoked_at:
            return True
        ride = self.ride_id
        if ride.state not in _ENDED_STATES:
            # requested/proposed/assigned/in_progress : jamais expiré par le seul écoulement du
            # temps tant que la course n'est pas arrivée à son terme.
            return False
        terminal_at = ride.completed_at or ride.cancelled_at
        if not terminal_at:
            return False
        grace_minutes = int(
            self.env["ir.config_parameter"]
            .sudo()
            .get_param(SHARE_LINK_GRACE_MINUTES_PARAM, SHARE_LINK_GRACE_MINUTES_FALLBACK)
        )
        return fields.Datetime.now() > terminal_at + timedelta(minutes=grace_minutes)

    def _is_active(self) -> bool:
        self.ensure_one()
        return not self._is_expired()
