# Jetons d'appareil pour la notification push (L7-01, Firebase Cloud Messaging).
#
# Le piège de cette tâche est le CYCLE DE VIE, pas l'intégration : un jeton périmé qui reste en
# base envoie dans le vide et fait croire que le chauffeur a été prévenu. Deux règles le tiennent :
#
#  - un jeton n'est jamais écrasé, il est ajouté (un compte, plusieurs appareils) ; le même jeton
#    peut appartenir à plusieurs comptes (appareil partagé, ou réinstallé -- la première
#    réinstallation produirait sinon un doublon silencieux) ;
#  - le nettoyage se fait QUAND le fournisseur le signale (retour d'envoi, jeton invalidé), jamais
#    par un balayage périodique qui devine -- voir services/push.py, `dispatch`.
#
# Le champ `active` d'Odoo (archivage) porte cette désactivation : un jeton désactivé sort
# automatiquement des recherches (`_active_tokens_for_users`), la table ne se vide jamais (audit),
# et un jeton qui redevient valide se réactive sans doublon (`_register_token`).
from __future__ import annotations

from odoo import api, fields, models


class BabanaDeviceToken(models.Model):
    _name = "babana.device.token"
    _description = "Jeton d'appareil pour notification push (L7-01)"

    user_id = fields.Many2one(
        "res.users",
        string="Compte",
        required=True,
        index=True,
        ondelete="cascade",
        help="Le compte pour lequel ce jeton reçoit des notifications. Un compte peut en avoir "
        "plusieurs (un par appareil).",
    )
    token = fields.Char(
        string="Jeton d'enregistrement",
        required=True,
        index=True,
        help="Jeton d'enregistrement Firebase Cloud Messaging (ou équivalent APNs via FCM).",
    )
    platform = fields.Selection(
        [("android", "Android"), ("ios", "iOS"), ("web", "Web")],
        string="Plateforme",
        required=True,
    )
    registered_at = fields.Datetime(
        string="Enregistré le",
        required=True,
        default=fields.Datetime.now,
        help="Dernier (ré)enregistrement du jeton -- connexion ou rotation signalée par Firebase.",
    )
    last_used_at = fields.Datetime(
        string="Dernier envoi",
        help="Dernière fois qu'une notification a réellement été poussée vers ce jeton. Sert à "
        "interpréter un taux d'échec et à repérer un jeton mort passé inaperçu.",
    )
    active = fields.Boolean(
        string="Actif",
        default=True,
        index=True,
        help="Désactivé automatiquement quand Firebase signale le jeton invalide sur un envoi "
        "(L7-01, critère 2), ou explicitement à la déconnexion de l'appareil. Jamais supprimé : "
        "la ligne reste pour l'audit.",
    )

    _sql_constraints = [
        (
            "user_token_uniq",
            "unique(user_id, token)",
            "Ce jeton est déjà enregistré pour ce compte.",
        ),
    ]

    # --- Cycle de vie -----------------------------------------------------------------------

    @api.model
    def _register_token(self, user, token, platform):
        """Enregistrement à la connexion et à chaque rotation (L7-01). Ajoute, n'écrase pas : un
        jeton déjà connu pour ce compte est réactivé et réhorodaté, jamais dupliqué. Un jeton
        déjà connu pour un AUTRE compte crée une seconde ligne (appareil partagé) -- la
        contrainte ne porte que sur le couple (compte, jeton)."""
        existing = self.with_context(active_test=False).search(
            [("user_id", "=", user.id), ("token", "=", token)], limit=1
        )
        now = fields.Datetime.now()
        if existing:
            existing.write(
                {"active": True, "platform": platform, "registered_at": now, "last_used_at": now}
            )
            return existing
        return self.create(
            {
                "user_id": user.id,
                "token": token,
                "platform": platform,
                "registered_at": now,
                "last_used_at": now,
            }
        )

    @api.model
    def _deactivate_for_user(self, user, token):
        """Déconnexion volontaire de cet appareil pour ce compte. Idempotent : un jeton inconnu
        ou déjà désactivé ne fait rien."""
        rows = self.with_context(active_test=False).search(
            [("user_id", "=", user.id), ("token", "=", token)]
        )
        if rows:
            rows.write({"active": False})

    @api.model
    def _deactivate_tokens(self, token_values):
        """Nettoyage sur retour d'envoi (L7-01, critère 2) : Firebase a signalé ces jetons
        invalides. Un jeton d'enregistrement invalide l'est pour QUI QUE CE SOIT qui le porte --
        on désactive toutes les lignes qui l'ont, tous comptes confondus."""
        values = [t for t in (token_values or []) if t]
        if not values:
            return
        rows = self.with_context(active_test=False).search([("token", "in", values)])
        if rows:
            rows.write({"active": False})

    @api.model
    def _active_tokens_for_users(self, users):
        """Jetons vers lesquels une notification pour ces comptes doit réellement partir. Les
        jetons désactivés sont exclus par le filtre `active` implicite d'Odoo -- pas de clause
        à répéter, et impossible d'oublier."""
        if not users:
            return self.browse()
        return self.search([("user_id", "in", users.ids)])

    def _mark_sent(self):
        """`last_used_at` après un envoi réellement parti -- pas à la mise en file."""
        if self:
            self.write({"last_used_at": fields.Datetime.now()})
