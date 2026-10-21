# Tests de la connexion par OTP (POST /auth/otp/request et /auth/otp/verify). Le simulateur SMS
# (`console`) garde le message en mémoire du processus : HttpCase sert l'application dans le même
# processus, le test lit donc le code comme le ferait un développeur dans les journaux.
from __future__ import annotations

import json
import re
from datetime import timedelta
from unittest.mock import patch

from odoo import fields
from odoo.tests.common import HttpCase, tagged

from ..services import sms

PHONE = "+237691234567"


@tagged("post_install", "-at_install")
class TestOtpLogin(HttpCase):
    def setUp(self):
        super().setUp()
        sms.reset_sms_provider_cache()
        sms.drain_sent()
        self.addCleanup(sms.reset_sms_provider_cache)
        # Les limites par adresse ne doivent pas lier les tests entre eux.
        self.env["ir.config_parameter"].sudo().set_param("babana.otp_requests_per_ip_hour", "1000")

    def _post(self, path, payload):
        return self.url_open(
            f"/api/v1/auth/otp/{path}",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )

    def _request(self, phone=PHONE, role="client"):
        response = self._post("request", {"phoneNumber": phone, "role": role})
        return response, (response.json() if response.status_code == 200 else None)

    def _last_code(self):
        message = sms.recent_sent()[-1]["message"]
        return re.search(r"\b(\d{6})\b", message).group(1)

    def _verify(self, verification_id, code):
        return self._post("verify", {"verificationId": verification_id, "code": code})

    # --- Parcours nominal -------------------------------------------------------------------

    def test_full_flow_creates_client_with_verified_phone(self):
        response, body = self._request()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(body), {"verificationId", "expiresIn"})
        self.assertNotIn(self._last_code(), response.text)  # le code ne sort jamais de l'API

        session = self._verify(body["verificationId"], self._last_code())
        self.assertEqual(session.status_code, 200)
        data = session.json()
        self.assertEqual(data["user"]["role"], "client")
        self.assertTrue(data["user"]["phoneVerified"])
        self.assertTrue(data["accessToken"] and data["refreshToken"])

        partner = self.env["res.partner"].sudo().search([("babana_phone", "=", PHONE)])
        self.assertEqual(len(partner), 1)
        self.assertTrue(partner.babana_is_customer)

    def test_second_login_reuses_the_account(self):
        _, first = self._request()
        a = self._verify(first["verificationId"], self._last_code()).json()
        _, second = self._request()
        b = self._verify(second["verificationId"], self._last_code()).json()
        self.assertEqual(a["user"]["id"], b["user"]["id"])
        self.assertEqual(self.env["res.partner"].sudo().search_count([("babana_phone", "=", PHONE)]), 1)

    def test_driver_role_creates_pending_candidacy(self):
        _, body = self._request(role="driver")
        data = self._verify(body["verificationId"], self._last_code()).json()
        self.assertEqual(data["user"]["role"], "driver")
        self.assertEqual(data["user"]["driverStatus"], "pending")
        self.assertTrue(data["user"]["phoneVerified"])

    def test_existing_account_keeps_its_original_role(self):
        _, body = self._request(role="client")
        self._verify(body["verificationId"], self._last_code())
        _, again = self._request(role="driver")
        data = self._verify(again["verificationId"], self._last_code()).json()
        self.assertEqual(data["user"]["role"], "client")

    # --- Validation -------------------------------------------------------------------------

    def test_invalid_phone_or_role_is_refused_without_sending(self):
        for payload in (
            {"phoneNumber": "0691234567", "role": "client"},
            {"phoneNumber": "+33612345678", "role": "client"},
            {"phoneNumber": PHONE, "role": "admin"},
            {"role": "client"},
        ):
            self.assertEqual(self._post("request", payload).status_code, 400, payload)
        self.assertEqual(sms.recent_sent(), [])

    # --- Code incorrect, essais, expiration -----------------------------------------------------

    def test_wrong_code_is_refused_then_right_code_still_works(self):
        _, body = self._request()
        good = self._last_code()
        bad = "000000" if good != "000000" else "111111"
        refused = self._verify(body["verificationId"], bad)
        self.assertEqual(refused.status_code, 400)
        self.assertEqual(refused.json()["error"]["code"], "OTP_INVALID")
        self.assertEqual(self._verify(body["verificationId"], good).status_code, 200)

    def test_attempts_are_limited_then_verification_is_cancelled(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.otp_max_attempts", "3")
        _, body = self._request()
        good = self._last_code()
        bad = "000000" if good != "000000" else "111111"
        for _ in range(3):
            self.assertEqual(self._verify(body["verificationId"], bad).status_code, 400)
        # Même le bon code ne passe plus : il faut recommencer.
        after = self._verify(body["verificationId"], good)
        self.assertEqual(after.status_code, 410)
        self.assertEqual(after.json()["error"]["code"], "OTP_EXPIRED")

    def test_expired_code_is_refused(self):
        _, body = self._request()
        record = self.env["babana.phone.verification"].sudo().search([("public_id", "=", body["verificationId"])])
        record.expires_at = fields.Datetime.now() - timedelta(seconds=1)
        refused = self._verify(body["verificationId"], self._last_code())
        self.assertEqual(refused.status_code, 410)
        self.assertEqual(refused.json()["error"]["code"], "OTP_EXPIRED")

    def test_code_is_single_use(self):
        _, body = self._request()
        code = self._last_code()
        self.assertEqual(self._verify(body["verificationId"], code).status_code, 200)
        self.assertEqual(self._verify(body["verificationId"], code).status_code, 410)

    def test_new_request_invalidates_the_previous_code(self):
        _, first = self._request()
        old_code = self._last_code()
        self._request()
        self.assertEqual(self._verify(first["verificationId"], old_code).status_code, 410)

    def test_unknown_verification_id_is_expired_not_a_crash(self):
        refused = self._verify("00000000-0000-4000-8000-000000000000", "123456")
        self.assertEqual(refused.status_code, 410)

    # --- Limites de demandes ------------------------------------------------------------------

    def test_requests_per_phone_per_hour_are_limited(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.otp_requests_per_phone_hour", "2")
        self.assertEqual(self._request()[0].status_code, 200)
        self.assertEqual(self._request()[0].status_code, 200)
        limited = self._request()[0]
        self.assertEqual(limited.status_code, 429)
        self.assertEqual(limited.json()["error"]["code"], "RATE_LIMITED")
        # Un autre numéro n'est pas touché.
        self.assertEqual(self._request(phone="+237692345678")[0].status_code, 200)

    # --- Secret du code ---------------------------------------------------------------------------

    def test_code_is_stored_hashed_only(self):
        _, body = self._request()
        code = self._last_code()
        record = self.env["babana.phone.verification"].sudo().search([("public_id", "=", body["verificationId"])])
        self.assertNotIn(code, (record.code_hash or ""))
        self.assertEqual(len(record.code_hash), 64)

    # --- Passerelle en défaut -------------------------------------------------------------------

    def test_sms_failure_is_reported_as_unavailable(self):
        failing = sms.ConsoleSmsProvider()
        failure = [sms.SmsDelivery(PHONE.lstrip("+"), False, sms.FAILURE_PROVIDER_ERROR)]
        with patch.object(failing, "send", return_value=failure), \
                patch("odoo.addons.babana.controllers.otp.sms.get_sms_provider", return_value=failing):
            response, _ = self._request()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"]["code"], "SMS_UNAVAILABLE")

    def test_sms_account_error_is_reported_as_unavailable(self):
        failing = sms.ConsoleSmsProvider()
        with patch.object(failing, "send", side_effect=sms.SmsAccountError("UNAUTHORIZED")), \
                patch("odoo.addons.babana.controllers.otp.sms.get_sms_provider", return_value=failing):
            response, _ = self._request()
        self.assertEqual(response.status_code, 503)


@tagged("post_install", "-at_install")
class TestOtpDevFixedCode(HttpCase):
    def setUp(self):
        super().setUp()
        sms.reset_sms_provider_cache()
        sms.drain_sent()
        self.addCleanup(sms.reset_sms_provider_cache)
        self.env["ir.config_parameter"].sudo().set_param("babana.otp_requests_per_ip_hour", "1000")

    def _login(self, env, code="000000"):
        with patch.dict("os.environ", env):
            sms.reset_sms_provider_cache()
            body = self.url_open(
                "/api/v1/auth/otp/request",
                data=json.dumps({"phoneNumber": PHONE, "role": "client"}).encode(),
                headers={"Content-Type": "application/json"},
            ).json()
            return self.url_open(
                "/api/v1/auth/otp/verify",
                data=json.dumps({"verificationId": body["verificationId"], "code": code}).encode(),
                headers={"Content-Type": "application/json"},
            )

    def test_fixed_code_works_with_console_provider(self):
        response = self._login({"SMS_PROVIDER": "console", "OTP_DEV_FIXED_CODE": "000000"})
        self.assertEqual(response.status_code, 200)

    def test_fixed_code_is_ignored_with_a_real_provider(self):
        # Avec une vraie passerelle la variable ne doit rien ouvrir : le code est aléatoire.
        real_env = {
            "SMS_PROVIDER": "tidjani_brothers",
            "TB_SMS_API_URL": "https://sms.invalid/v1",
            "TB_SMS_API_KEY": "tbsms_x",
            "OTP_DEV_FIXED_CODE": "000000",
        }
        fake = sms.ConsoleSmsProvider()
        with patch("odoo.addons.babana.controllers.otp.sms.get_sms_provider", return_value=fake):
            response = self._login(real_env)
        self.assertEqual(response.status_code, 400)  # OTP_INVALID, sauf 1 chance sur 10^6

    def test_malformed_fixed_code_is_ignored(self):
        self.assertIsNone(self._dev_code({"SMS_PROVIDER": "console", "OTP_DEV_FIXED_CODE": "12"}))

    def _dev_code(self, env):
        with patch.dict("os.environ", env):
            return sms.dev_fixed_code()
