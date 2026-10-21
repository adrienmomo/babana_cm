# Connexion par numéro de téléphone et code SMS (OTP) -- remplace POST /auth/google comme porte
# d'entrée des applications. Deux routes publiques :
#
#   POST /api/v1/auth/otp/request  { phoneNumber, role }        -> { verificationId, expiresIn }
#   POST /api/v1/auth/otp/verify   { verificationId, code }     -> AuthSession
#
# Aucune règle d'identité n'est dans l'app (invariant 3) : numéro valide, limites, expiration,
# nombre d'essais, création ou reprise du compte -- tout est ici. La réponse à /request est la
# même que le numéro ait déjà un compte ou non (pas d'énumération de comptes).
from __future__ import annotations

import logging
import re

from odoo import SUPERUSER_ID
from odoo.http import Controller, request, route

from .auth import (
    _PUBLIC_AUTH_ROUTE,
    _build_session,
    _error_response,
    _json_response,
    _parse_json_body,
    _superuser_env,
)
from ..models.babana_driver import DriverCandidacyRateLimited
from ..models.babana_phone_verification import OTP_CODE_LENGTH, OtpRateLimited
from ..services import sms

_logger = logging.getLogger(__name__)

# Même motif que PhoneVerifyStartRequestSchema (packages/contracts/src/http/auth.ts) : Cameroun,
# E.164. Le contrat fait foi ; ce motif doit le suivre.
_PHONE_PATTERN = re.compile(r"^\+237[6-9]\d{8}$")
_CODE_PATTERN = re.compile(rf"^\d{{{OTP_CODE_LENGTH}}}$")
_UUID_PATTERN = re.compile(r"^[0-9a-fA-F-]{36}$")


def sms_body(code: str, ttl_seconds: int) -> str:
    minutes = max(1, ttl_seconds // 60)
    return f"Babana : votre code est {code}. Il expire dans {minutes} min. Ne le partagez avec personne."


class OtpController(Controller):
    @route("/api/v1/auth/otp/request", **_PUBLIC_AUTH_ROUTE)
    def otp_request(self, **_kwargs):
        try:
            return self._otp_request()
        except Exception:
            _logger.exception("erreur interne dans POST /api/v1/auth/otp/request")
            return _error_response("INTERNAL_ERROR", "erreur interne", 500)

    def _otp_request(self):
        body = _parse_json_body()
        if body is None:
            return _error_response("VALIDATION_ERROR", "corps JSON invalide", 400)
        phone = body.get("phoneNumber")
        role = body.get("role")
        if not isinstance(phone, str) or not _PHONE_PATTERN.match(phone):
            return _error_response(
                "VALIDATION_ERROR", "phoneNumber doit être un numéro camerounais au format +237XXXXXXXXX", 400
            )
        if role not in ("client", "driver"):
            return _error_response("VALIDATION_ERROR", "role doit valoir 'client' ou 'driver'", 400)

        env = _superuser_env()
        try:
            verification, code, ttl = env["babana.phone.verification"]._issue(
                phone=phone, role=role, ip_address=request.httprequest.remote_addr
            )
        except OtpRateLimited as exc:
            return _error_response("RATE_LIMITED", str(exc), 429)

        try:
            deliveries = sms.get_sms_provider().send([phone], sms_body(code, ttl))
        except sms.SmsAccountError as exc:
            # Clé ou compte refusé : tout envoi échouera pareil. Une ligne claire, pas de détail
            # au client (il ne peut rien y faire).
            _logger.error("SMS : compte fournisseur refusé (%s) -- les connexions par OTP sont bloquées", exc.code)
            return _error_response("SMS_UNAVAILABLE", "envoi du SMS impossible", 503)
        if not all(d.sent for d in deliveries):
            _logger.error("SMS : échec d'envoi (%s)", [d.failure for d in deliveries])
            return _error_response("SMS_UNAVAILABLE", "envoi du SMS impossible", 503)

        return _json_response({"verificationId": verification.public_id, "expiresIn": ttl}, 200)

    @route("/api/v1/auth/otp/verify", **_PUBLIC_AUTH_ROUTE)
    def otp_verify(self, **_kwargs):
        try:
            return self._otp_verify()
        except Exception:
            _logger.exception("erreur interne dans POST /api/v1/auth/otp/verify")
            return _error_response("INTERNAL_ERROR", "erreur interne", 500)

    def _otp_verify(self):
        body = _parse_json_body()
        if body is None:
            return _error_response("VALIDATION_ERROR", "corps JSON invalide", 400)
        verification_id = body.get("verificationId")
        code = body.get("code")
        if not isinstance(verification_id, str) or not _UUID_PATTERN.match(verification_id):
            return _error_response("VALIDATION_ERROR", "verificationId invalide", 400)
        if not isinstance(code, str) or not _CODE_PATTERN.match(code):
            return _error_response("VALIDATION_ERROR", f"code à {OTP_CODE_LENGTH} chiffres requis", 400)

        env = request.env(user=SUPERUSER_ID)
        result, verification = env["babana.phone.verification"]._confirm(
            public_id=verification_id, code=code
        )
        if result == "expired":
            return _error_response("OTP_EXPIRED", "code expiré ou annulé : demandez-en un nouveau", 410)
        if result == "invalid":
            return _error_response("OTP_INVALID", "code incorrect", 400)

        try:
            user = env["res.users"]._babana_find_or_create_from_phone(
                phone=verification.phone,
                role=verification.role,
                ip_address=request.httprequest.remote_addr,
            )
        except DriverCandidacyRateLimited as exc:
            return _error_response("RATE_LIMITED", str(exc), 429)

        refresh_token = env["babana.token"]._issue_family(user)
        return _json_response(_build_session(user, refresh_token), 200)
