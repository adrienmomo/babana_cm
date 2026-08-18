# Jeton de renouvellement applicatif (L1-02). L'accessToken n'est jamais stocké : signé HS256,
# validé par signature seule (par Odoo comme par le service temps réel, sans appel entre eux) --
# c'est le refreshToken, seul revocable, qui a besoin d'un état durable.
from __future__ import annotations

import base64
import hashlib
import secrets
import uuid
from datetime import timedelta

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from odoo import api, fields, models

REFRESH_TOKEN_TTL_DAYS_PARAM = "babana.refresh_token_ttl_days"
DEFAULT_REFRESH_TOKEN_TTL_DAYS = 30

# Séparation de domaine entre le haché stocké (token_hash) et la clé de déchiffrement du
# remplaçant (D37) : les deux dérivent du même jeton en clair, un préfixe distinct garantit que
# ce ne sont jamais la même valeur, même si ça n'aiderait de toute façon pas un attaquant --
# défense en profondeur peu coûteuse.
_REPLAY_KEY_DOMAIN = b"babana-token-replay-key-v1:"

# Fenêtre de grâce sur la rotation (D36, 22 août -- amoa/questions/REPONSES-2026-08-22.md §2).
# Le réseau de Douala coupe entre l'envoi du jeton et la réception de son remplaçant : l'ancien
# jeton est alors consommé côté serveur, aucun nouveau côté téléphone. Sans fenêtre, la
# réutilisation au démarrage suivant révoquerait toute la famille -- un chauffeur déconnecté en
# pleine journée, pour un événement qui ressemble à un vol dans les journaux mais n'en est pas
# un. Valeur par défaut choisie pour couvrir une coupure ponctuelle (le temps d'un aller-retour
# réseau manqué et d'un redémarrage d'app), pas une session entière -- un choix d'implémentation
# non spécifié par D36, donc consigné ici plutôt que deviné en silence.
TOKEN_REUSE_GRACE_SECONDS_PARAM = "babana.token_reuse_grace_seconds"
DEFAULT_TOKEN_REUSE_GRACE_SECONDS = 30


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
    rotated_at = fields.Datetime(
        help="Horodatage de la rotation qui a fait passer ce jeton à 'rotated' -- borne de la "
        "fenêtre de grâce (D36). Non posé sur un jeton 'active' ou 'revoked' directement.",
    )
    next_token_ciphertext = fields.Char(
        help="Jeton de renouvellement déjà émis en remplacement de celui-ci, chiffré (AES-GCM) "
        "avec une clé dérivée du jeton présenté à cette ligne -- jamais stocké en clair (D37, "
        "23 août : amoa/questions/REPONSES-2026-08-23.md §1). Gardé le temps de la fenêtre de "
        "grâce (D36) pour pouvoir renvoyer exactement le même couple à une réutilisation qui "
        "n'est qu'un réessai réseau, pas un vol -- déchiffrable seulement par qui présente à "
        "nouveau ce même jeton, qui est exactement le seul client habilité à rejouer. Un vidage "
        "de la base ne donne rien de déchiffrable : la clé n'y est jamais stockée, seul son "
        "haché (token_hash) l'est. Effacé au plus tard par _cron_purge_expired_replay_ciphertext "
        "-- le cas normal, où personne ne repasse jamais, ne doit rien laisser passé la fenêtre.",
    )

    _sql_constraints = [
        ("babana_token_hash_unique", "unique(token_hash)", "Collision de jeton -- ne devrait jamais se produire."),
    ]

    @api.model
    def _hash(self, raw_token: str) -> str:
        return hashlib.sha256(raw_token.encode()).hexdigest()

    @api.model
    def _replay_key(self, raw_token: str) -> bytes:
        """Clé AES-256 dérivée du jeton présenté (D37) -- jamais stockée, recalculée à chaque
        rotation et à chaque rejeu depuis le jeton en clair que le client vient de fournir."""
        return hashlib.sha256(_REPLAY_KEY_DOMAIN + raw_token.encode()).digest()

    @api.model
    def _encrypt_next_token(self, raw_token: str, next_raw_token: str) -> str:
        nonce = secrets.token_bytes(12)
        ciphertext = AESGCM(self._replay_key(raw_token)).encrypt(
            nonce, next_raw_token.encode(), None
        )
        return base64.b64encode(nonce + ciphertext).decode()

    @api.model
    def _decrypt_next_token(self, raw_token: str, ciphertext_b64: str) -> str:
        raw = base64.b64decode(ciphertext_b64)
        nonce, ciphertext = raw[:12], raw[12:]
        return AESGCM(self._replay_key(raw_token)).decrypt(nonce, ciphertext, None).decode()

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
        """Renouvelle un jeton de renouvellement (L1-02, critères 1 à 3, 3 bis).

        Renvoie (user, nouveau_jeton_en_clair). Lève TokenNotFound, TokenExpired ou TokenReused
        -- au contrôleur de les traduire en UNAUTHORIZED, TOKEN_EXPIRED, TOKEN_REVOKED
        (catalogue C-01).
        """
        record = self.sudo().search([("token_hash", "=", self._hash(raw_token))], limit=1)
        if not record:
            raise TokenNotFound()

        if record.state == "rotated":
            # Critère 3 bis (D36) : seul un jeton naturellement remplacé par la rotation --
            # jamais un jeton 'revoked' par une action explicite (vol détecté, suspension,
            # déconnexion) -- bénéficie de la fenêtre de grâce. Dans la fenêtre, on rejoue le
            # couple déjà émis : ni révocation, ni troisième jeton (sinon deux appareils
            # repartiraient avec deux familles vivantes issues du même jeton, exactement ce que
            # la rotation rend impossible).
            grace_seconds = int(
                self.env["ir.config_parameter"]
                .sudo()
                .get_param(TOKEN_REUSE_GRACE_SECONDS_PARAM, DEFAULT_TOKEN_REUSE_GRACE_SECONDS)
            )
            within_grace = (
                record.rotated_at
                and record.next_token_ciphertext
                and fields.Datetime.now() - record.rotated_at <= timedelta(seconds=grace_seconds)
            )
            if within_grace:
                # Déchiffrable uniquement parce que raw_token est exactement le jeton présenté à
                # la rotation qui a produit ce chiffré (D37) -- un vidage de base ne donnerait
                # jamais cette clé, elle n'y est jamais écrite.
                return record.user_id, self._decrypt_next_token(
                    raw_token, record.next_token_ciphertext
                )
            # Fenêtre dépassée : la réutilisation redevient ce qu'elle est censée signaler.
            # On efface aussi le couple rejouable -- il ne sert plus à rien passé ce point, et
            # ne doit pas rester en base indéfiniment, même chiffré (voir le help du champ).
            record.write({"next_token_ciphertext": False})
            self._revoke_family(record.family_id)
            raise TokenReused()

        if record.state == "revoked":
            self._revoke_family(record.family_id)
            raise TokenReused()

        if record.expires_at < fields.Datetime.now():
            record.write({"state": "revoked"})
            raise TokenExpired()

        new_raw = self._issue(record.user_id, family_id=record.family_id)
        record.write(
            {
                "state": "rotated",
                "rotated_at": fields.Datetime.now(),
                "next_token_ciphertext": self._encrypt_next_token(raw_token, new_raw),
            }
        )
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

    @api.model
    def _cron_purge_expired_replay_ciphertext(self) -> None:
        """Efface le chiffré rejouable des lignes dont la fenêtre de grâce (D36/D37) est
        dépassée, sans attendre qu'un client vienne le redemander -- le cas normal, celui où
        personne ne repasse jamais, ne doit rien laisser de déchiffrable en base passé la
        fenêtre (critère 3 quater, L1-02)."""
        grace_seconds = int(
            self.env["ir.config_parameter"]
            .sudo()
            .get_param(TOKEN_REUSE_GRACE_SECONDS_PARAM, DEFAULT_TOKEN_REUSE_GRACE_SECONDS)
        )
        threshold = fields.Datetime.now() - timedelta(seconds=grace_seconds)
        self.sudo().search(
            [
                ("state", "=", "rotated"),
                ("next_token_ciphertext", "!=", False),
                ("rotated_at", "<=", threshold),
            ]
        ).write({"next_token_ciphertext": False})
