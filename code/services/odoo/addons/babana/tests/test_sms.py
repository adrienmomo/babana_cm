# Tests de services/sms.py (L1-09) : l'interface, le simulateur et l'implémentation Tidjani &
# Brothers contre des réponses HTTP simulées. Aucun réseau, aucune pause réelle.
from __future__ import annotations

import os
from unittest.mock import patch

import requests
from odoo.tests.common import TransactionCase, tagged

from ..services import sms
from ..services.sms import (
    ConsoleSmsProvider,
    SmsAccountError,
    TidjaniAndBrothersSmsProvider,
)


class FakeResponse:
    def __init__(self, status_code, body=None):
        self.status_code = status_code
        self._body = body if body is not None else {}

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code))


class FakeSession:
    """Rejoue des réponses (ou lève des exceptions) dans l'ordre et garde les requêtes."""

    def __init__(self, *script):
        self.script = list(script)
        self.calls = []

    def _next(self, kind, url, **kwargs):
        self.calls.append((kind, url, kwargs))
        step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        return step

    def post(self, url, **kwargs):
        return self._next("post", url, **kwargs)

    def get(self, url, **kwargs):
        return self._next("get", url, **kwargs)


def _ok(numbers, failed=()):
    batches = [{"recipients": [n for n in numbers if n not in failed], "status": "submitted"}]
    if failed:
        batches.append({"recipients": list(failed), "status": "failed", "error": {"code": "X", "retryable": False}})
    return FakeResponse(201, {"id": "msg-1", "status": "partial" if failed else "sent", "parts": 1,
                              "creditsCharged": len(numbers), "batches": batches})


def _err(status, code, details=None):
    return FakeResponse(status, {"error": {"code": code, "message": "m", "details": details or {}}})


@tagged("post_install", "-at_install")
class TestTidjaniAndBrothersSms(TransactionCase):
    def _provider(self, *script):
        self.sleeps = []
        self.session = FakeSession(*script)
        provider = TidjaniAndBrothersSmsProvider(
            "https://sms.invalid/v1/", "tbsms_secret", sleep=self.sleeps.append, session=self.session
        )
        return provider

    def test_sent_batch_maps_each_number_and_normalizes(self):
        provider = self._provider(_ok(["237670000000", "237650000000"]))
        result = provider.send(["+237 670-000-000", "00237650000000", "237670000000"], "Votre code est 4821")
        self.assertEqual([d.number for d in result], ["237670000000", "237650000000"])
        self.assertTrue(all(d.sent and d.provider_message_id == "msg-1" for d in result))
        kind, url, kwargs = self.session.calls[0]
        self.assertEqual(url, "https://sms.invalid/v1/send")
        self.assertEqual(kwargs["json"]["to"], ["237670000000", "237650000000"])
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer tbsms_secret")

    def test_partial_batch_marks_only_failed_numbers(self):
        provider = self._provider(_ok(["237670000000", "237650000000"], failed=["237650000000"]))
        result = provider.send(["237670000000", "237650000000"], "m")
        self.assertEqual([(d.sent, d.failure) for d in result],
                         [(True, None), (False, sms.FAILURE_PROVIDER_ERROR)])

    def test_insufficient_credit_fails_without_retry(self):
        provider = self._provider(_err(402, "INSUFFICIENT_CREDIT", {"required": 2}))
        result = provider.send(["237670000000"], "m")
        self.assertEqual(result[0].failure, sms.FAILURE_INSUFFICIENT_CREDIT)
        self.assertEqual(len(self.session.calls), 1)

    def test_invalid_recipient_is_dropped_and_rest_resent(self):
        provider = self._provider(
            _err(422, "INVALID_RECIPIENT", {"invalid": ["237111"]}),
            _ok(["237670000000"]),
        )
        result = {d.number: d for d in provider.send(["237670000000", "237111"], "m")}
        self.assertEqual(result["237111"].failure, sms.FAILURE_INVALID_RECIPIENT)
        self.assertTrue(result["237670000000"].sent)
        self.assertEqual(self.session.calls[1][2]["json"]["to"], ["237670000000"])

    def test_invalid_recipient_without_details_does_not_loop(self):
        provider = self._provider(_err(422, "INVALID_RECIPIENT"))
        result = provider.send(["237670000000"], "m")
        self.assertEqual(result[0].failure, sms.FAILURE_INVALID_RECIPIENT)
        self.assertEqual(len(self.session.calls), 1)

    def test_rate_limited_then_success_backs_off(self):
        provider = self._provider(_err(429, "RATE_LIMITED"), _ok(["237670000000"]))
        result = provider.send(["237670000000"], "m")
        self.assertTrue(result[0].sent)
        self.assertEqual(len(self.session.calls), 2)
        self.assertIn(1, self.sleeps)

    def test_upstream_unavailable_exhausted_after_three_retries(self):
        provider = self._provider(*[_err(503, "UPSTREAM_UNAVAILABLE")] * 4)
        result = provider.send(["237670000000"], "m")
        self.assertEqual(result[0].failure, sms.FAILURE_PROVIDER_ERROR)
        self.assertEqual(len(self.session.calls), 4)
        self.assertEqual([s for s in self.sleeps if s >= 1], [1, 2, 4])

    def test_timeout_is_never_retried(self):
        provider = self._provider(requests.Timeout("lent"))
        result = provider.send(["237670000000"], "m")
        self.assertEqual(result[0].failure, sms.FAILURE_UNKNOWN_OUTCOME)
        self.assertEqual(len(self.session.calls), 1)

    def test_unauthorized_raises_account_error(self):
        provider = self._provider(_err(401, "UNAUTHORIZED"))
        with self.assertRaises(SmsAccountError) as ctx:
            provider.send(["237670000000"], "m")
        self.assertEqual(ctx.exception.code, "UNAUTHORIZED")

    def test_more_than_300_numbers_are_split(self):
        numbers = [f"237670{i:06d}" for i in range(301)]
        provider = self._provider(_ok(numbers[:300]), _ok(numbers[300:]))
        result = provider.send(numbers, "m")
        self.assertEqual(len(result), 301)
        self.assertEqual([len(c[2]["json"]["to"]) for c in self.session.calls], [300, 1])

    def test_api_key_and_body_never_logged(self):
        provider = self._provider(_err(402, "INSUFFICIENT_CREDIT"))
        with self.assertLogs(sms._logger, level="DEBUG") as logs:
            provider.send(["237670000000"], "code secret 4821")
        text = "\n".join(logs.output)
        self.assertNotIn("tbsms_secret", text)
        self.assertNotIn("4821", text)

    def test_balance(self):
        provider = self._provider(FakeResponse(200, {"credits": 498, "accountStatus": "active",
                                                     "sender": {"value": "MONSHOP", "status": "approved"}}))
        balance = provider.balance()
        self.assertEqual((balance.credits, balance.sender, balance.usable), (498, "MONSHOP", True))


@tagged("post_install", "-at_install")
class TestSmsProviderChoice(TransactionCase):
    def tearDown(self):
        sms.reset_sms_provider_cache()
        super().tearDown()

    def test_console_is_default_and_exposes_the_code(self):
        sms.reset_sms_provider_cache()
        sms.drain_sent()
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(sms.SMS_PROVIDER_ENV, None)
            provider = sms.get_sms_provider()
        self.assertIsInstance(provider, ConsoleSmsProvider)
        provider.send(["+237670000000"], "Votre code est 4821")
        self.assertIn("4821", sms.recent_sent()[-1]["message"])

    def test_real_provider_without_configuration_fails_loudly(self):
        sms.reset_sms_provider_cache()
        env = {sms.SMS_PROVIDER_ENV: "tidjani_brothers"}
        with patch.dict(os.environ, env):
            os.environ.pop(sms.TB_SMS_API_KEY_ENV, None)
            with self.assertRaises(RuntimeError):
                sms.get_sms_provider()

    def test_unknown_provider_is_refused(self):
        sms.reset_sms_provider_cache()
        with patch.dict(os.environ, {sms.SMS_PROVIDER_ENV: "nope"}):
            with self.assertRaises(RuntimeError):
                sms.get_sms_provider()
