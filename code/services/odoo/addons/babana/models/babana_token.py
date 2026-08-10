# Jeton de renouvellement applicatif (L1-02). L'accessToken n'est jamais stocké : signé HS256,
# validé par signature seule (par Odoo comme par le service temps réel, sans appel entre eux) --
# c'est le refreshToken, seul revocable, qui a besoin d'un état durable.
from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import timedelta

from odoo import api, fields, models

REFRESH_TOKEN_TTL_DAYS_PARAM = "babana.refresh_token_ttl_days"
DEFAULT_REFRESH_TOKEN_TTL_DAYS = 30


class TokenNotFound(Exception):
    """Aucun jeton ne correspond au hachage fourni — jeton inconnu ou jamais émis."""


class TokenExpired(Exception):
    """Le jeton de renouvellement existe mais sa date d'expiration est dépassée."""


class TokenReused(Exception):
    """Le jeton présenté a déjà été consommé (rotated) ou révoqué — signe de vol (L1-02) :
    toute la famille est révoquée avant que cette exception ne soit levée."""


class BabanaToken(models.Model):
    _name = "babana.token"
    _description = "Jeton de renouvellement applicatif (L1-02)"

    user_id = fields.Many2one("res.users", required=True, index=True, ondelete="cascade")
    family_id = fields.Char(
        required=True,
        index=True,
        help="Identifiant commun à tous les jetons issus d'une même chaîne de renouvellements. "
        "La réutilisation d'un jeton consommé révoque toute la famille (critère 3).",
    )
    token_hash = fields.Char(
        required=True,
        help="Empreinte SHA-256 du jeton de renouvellement en clair -- jamais stocké tel quel.",
    )
    state = fields.Selection(
        [("active", "Actif"), ("rotated", "Remplacé"), ("revoked", "Révoqué")],
        default="active",
        required=True,
    )
    expires_at = fields.Datetime(required=True)
    created_at = fields.Datetime(default=lambda self: fields.Datetime.now(), required=True)

    _sql_constraints = [
        ("babana_token_hash_unique", "unique(token_hash)", "Collision de jeton -- ne devrait jamais se produire."),
    ]

    @api.model
    def _hash(self, raw_token: str) -> str:
        return hashlib.sha256(raw_token.encode()).hexdigest()

    @api.model
    def _issue_family(self, user):
        """Émet le premier jeton de renouvellement d'une nouvelle famille (L1-01, à la
        connexion). Renvoie le jeton en clair -- seule occasion où il existe hors du hachage."""
        return self._issue(user, family_id=str(uuid.uuid4()))

    @api.model
    def _issue(self, user, *, family_id: str) -> str:
        raw_token = secrets.token_urlsafe(32)
        ttl_days = int(
            self.env["ir.config_parameter"]
            .sudo()
            .get_param(REFRESH_TOKEN_TTL_DAYS_PARAM, DEFAULT_REFRESH_TOKEN_TTL_DAYS)
        )
        self.sudo().create(
            {
                "user_id": user.id,
                "family_id": family_id,
                "token_hash": self._hash(raw_token),
                "expires_at": fields.Datetime.now() + timedelta(days=ttl_days),
            }
        )
        return raw_token

    @api.model
    def _rotate(self, raw_token: str):
        """Renouvelle un jeton de renouvellement (L1-02, critères 1 à 3).

        Renvoie (user, nouveau_jeton_en_clair). Lève TokenNotFound, TokenExpired ou TokenReused
        -- au contrôleur de les traduire en UNAUTHORIZED, TOKEN_EXPIRED, TOKEN_REVOKED
        (catalogue C-01).
        """
        record = self.sudo().search([("token_hash", "=", self._hash(raw_token))], limit=1)
        if not record:
            raise TokenNotFound()

        if record.state != "active":
            self._revoke_family(record.family_id)
            raise TokenReused()

        if record.expires_at < fields.Datetime.now():
            record.write({"state": "revoked"})
            raise TokenExpired()

        record.write({"state": "rotated"})
        new_raw = self._issue(record.user_id, family_id=record.family_id)
        return record.user_id, new_raw

    @api.model
    def _revoke(self, raw_token: str) -> None:
        """Révocation explicite d'un seul jeton (POST /auth/logout). Une déconnexion
        volontaire n'est pas un signe de vol : contrairement à _rotate sur réutilisation, elle
        ne révoque que ce jeton, pas toute la famille."""
        record = self.sudo().search([("token_hash", "=", self._hash(raw_token))], limit=1)
        if record and record.state == "active":
            record.write({"state": "revoked"})

    def _revoke_family(self, family_id: str) -> None:
        self.sudo().search([("family_id", "=", family_id), ("state", "=", "active")]).write(
            {"state": "revoked"}
        )

    @api.model
    def _revoke_all_for_user(self, user) -> None:
        """Révoque tous les jetons de renouvellement actifs d'un utilisateur (L1-02, critère 4).

        Point d'entrée prêt pour la suspension d'un chauffeur (L1-06, hors de ce lot) : il lui
        suffira d'appeler cette méthode, pas de la construire.
        """
        self.sudo().search([("user_id", "=", user.id), ("state", "=", "active")]).write(
            {"state": "revoked"}
        )
