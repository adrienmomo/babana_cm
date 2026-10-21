# Connexion par numéro de téléphone et code SMS (OTP), qui remplace Google Sign-In.
#
# Une ligne = une demande de code. Le numéro n'est attaché à un compte (res.partner.babana_phone)
# qu'à la confirmation ; la ligne reste ensuite (état `consumed`) pour que les limites de demandes
# par heure comptent aussi les codes déjà utilisés, puis disparaît par autovacuum.
#
# Le code n'est jamais stocké en clair, ni renvoyé par l'API, ni journalisé hors simulateur.
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import uuid
from datetime import timedelta

from odoo import api, fields, models

from ..services import sms

# Valeurs métier paramétrables (invariant 5) : le repli ci-dessous n'est qu'un défaut, la valeur
# vit dans ir.config_parameter.
OTP_TTL_SECONDS_PARAM = "babana.otp_ttl_seconds"
OTP_TTL_SECONDS_FALLBACK = 300
OTP_MAX_ATTEMPTS_PARAM = "babana.otp_max_attempts"
OTP_MAX_ATTEMPTS_FALLBACK = 5
OTP_REQUESTS_PER_PHONE_HOUR_PARAM = "babana.otp_requests_per_phone_hour"
OTP_REQUESTS_PER_PHONE_HOUR_FALLBACK = 5
OTP_REQUESTS_PER_IP_HOUR_PARAM = "babana.otp_requests_per_ip_hour"
OTP_REQUESTS_PER_IP_HOUR_FALLBACK = 20
OTP_RETENTION_DAYS_PARAM = "babana.otp_retention_days"
OTP_RETENTION_DAYS_FALLBACK = 2

# Longueur imposée par le contrat (`code: /^\d{6}$/`, packages/contracts/src/http/phone.ts).
OTP_CODE_LENGTH = 6


class OtpRateLimited(Exception):
    pass


class BabanaPhoneVerification(models.Model):
    _name = "babana.phone.verification"
    _description = "Demande de code OTP par SMS"

    public_id = fields.Char(
        string="Identifiant public",
        required=True,
        index=True,
        copy=False,
        default=lambda self: str(uuid.uuid4()),
        help="`verificationId` du contrat : ce que l'app renvoie avec le code.",
    )
    phone = fields.Char(
        string="Numéro (E.164)",
        required=True,
        index=True,
        help="Numéro à vérifier, format international (+237...).",
    )
    role = fields.Selection(
        [("client", "Client"), ("driver", "Chauffeur")],
        string="Rôle demandé",
        required=True,
        help="Sert uniquement si la vérification crée le compte (premier passage).",
    )
    ip_address = fields.Char(string="Adresse IP", index=True)
    code_hash = fields.Char(
        string="Empreinte du code",
        required=True,
        help="HMAC du code, lié à cette demande et à ce numéro. Le code lui-même n'est jamais "
        "stocké.",
    )
    expires_at = fields.Datetime(string="Expire le", required=True)
    attempts = fields.Integer(string="Tentatives", default=0)
    state = fields.Selection(
        [("pending", "En attente"), ("consumed", "Utilisée"), ("cancelled", "Annulée")],
        string="État",
        default="pending",
        required=True,
        index=True,
    )

    # --- Code -----------------------------------------------------------------------------

    @staticmethod
    def _generate_code() -> str:
        return f"{secrets.randbelow(10 ** OTP_CODE_LENGTH):0{OTP_CODE_LENGTH}d}"

    @staticmethod
    def _hash_code(public_id: str, phone: str, code: str) -> str:
        # Clé dérivée du secret applicatif existant, avec séparation de domaine : pas de nouveau
        # secret à gérer, et un code OTP ne vaut rien en dehors de cette demande précise.
        key = hashlib.sha256(b"babana-otp:" + os.environ["JWT_SECRET"].encode()).digest()
        return hmac.new(key, f"{public_id}:{phone}:{code}".encode(), hashlib.sha256).hexdigest()

    def _param_int(self, name, fallback) -> int:
        return int(self.env["ir.config_parameter"].sudo().get_param(name, fallback))

    # --- Demande --------------------------------------------------------------------------

    @api.model
    def _issue(self, *, phone: str, role: str, ip_address):
        """Applique les limites, crée la demande et renvoie (demande, code en clair). Le code en
        clair ne sort d'ici que pour l'envoi SMS."""
        self = self.sudo()
        hour_ago = fields.Datetime.now() - timedelta(hours=1)
        per_phone = self._param_int(OTP_REQUESTS_PER_PHONE_HOUR_PARAM, OTP_REQUESTS_PER_PHONE_HOUR_FALLBACK)
        if self.search_count([("phone", "=", phone), ("create_date", ">=", hour_ago)]) >= per_phone:
            raise OtpRateLimited("Trop de codes demandés pour ce numéro. Réessayez plus tard.")
        if ip_address:
            per_ip = self._param_int(OTP_REQUESTS_PER_IP_HOUR_PARAM, OTP_REQUESTS_PER_IP_HOUR_FALLBACK)
            if self.search_count([("ip_address", "=", ip_address), ("create_date", ">=", hour_ago)]) >= per_ip:
                raise OtpRateLimited("Trop de codes demandés depuis cette connexion. Réessayez plus tard.")

        # Une nouvelle demande invalide les précédentes encore en attente pour ce numéro : un seul
        # code vivant à la fois.
        self.search([("phone", "=", phone), ("state", "=", "pending")]).write({"state": "cancelled"})

        public_id = str(uuid.uuid4())
        code = sms.dev_fixed_code() or self._generate_code()
        ttl = self._param_int(OTP_TTL_SECONDS_PARAM, OTP_TTL_SECONDS_FALLBACK)
        record = self.create(
            {
                "public_id": public_id,
                "phone": phone,
                "role": role,
                "ip_address": ip_address,
                "code_hash": self._hash_code(public_id, phone, code),
                "expires_at": fields.Datetime.now() + timedelta(seconds=ttl),
            }
        )
        return record, code, ttl

    # --- Confirmation ---------------------------------------------------------------------

    @api.model
    def _confirm(self, *, public_id: str, code: str):
        """Renvoie (résultat, demande) où résultat vaut 'ok', 'invalid' (mauvais code) ou
        'expired' (inconnue, expirée, annulée, déjà utilisée ou trop d'essais -- l'app doit
        redemander un code)."""
        self = self.sudo()
        # Vider avant le SQL brut (docs/odoo-pitfalls.md) : une demande créée plus tôt dans la même
        # transaction ne serait sinon pas encore en base.
        self.flush_model()
        self.env.cr.execute(
            "SELECT id FROM babana_phone_verification WHERE public_id = %s FOR UPDATE", (public_id,)
        )
        row = self.env.cr.fetchone()
        record = self.browse(row[0]) if row else self.browse()
        if not record or record.state != "pending":
            return "expired", record
        if record.expires_at <= fields.Datetime.now():
            record.state = "cancelled"
            return "expired", record

        expected = record.code_hash
        given = self._hash_code(record.public_id, record.phone, code)
        if hmac.compare_digest(expected, given):
            record.state = "consumed"
            return "ok", record

        record.attempts += 1
        if record.attempts >= self._param_int(OTP_MAX_ATTEMPTS_PARAM, OTP_MAX_ATTEMPTS_FALLBACK):
            record.state = "cancelled"
        return "invalid", record

    @api.autovacuum
    def _gc_old_verifications(self):
        days = self._param_int(OTP_RETENTION_DAYS_PARAM, OTP_RETENTION_DAYS_FALLBACK)
        self.sudo().search(
            [("create_date", "<", fields.Datetime.now() - timedelta(days=days))]
        ).unlink()
