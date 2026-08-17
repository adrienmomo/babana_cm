# Tests de GET /me (C-01 auth.ts, D35) -- même patron que TestDriverCashController
# (test_driver_cash_controller.py) : jeton réel émis directement, pas le parcours Google mock
# complet.
from __future__ import annotations

import os
import time

import jwt

from odoo.tests.common import HttpCase, tagged


@tagged("post_install", "-at_install")
class TestMeController(HttpCase):
    def _get(self, token=None):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        return self.url_open("/api/v1/me", headers=headers)

    def test_client_profile_matches_the_session_shape(self):
        from ..controllers.auth import _issue_access_token

        user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub="sub-me-client", email="me-client@example.invalid", name="Amina N.", role="client"
        )
        access_token, _ = _issue_access_token(user)

        response = self._get(access_token)

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["id"], user.babana_public_id)
        self.assertEqual(body["role"], "client")
        self.assertEqual(body["displayName"], "Amina N.")
        self.assertFalse(body["phoneVerified"])
        self.assertNotIn("driverStatus", body)

    def test_driver_profile_carries_the_approval_status(self):
        # Même objet que la réponse d'une session (D35) : un chauffeur `pending` reçoit tout de
        # même son profil, avec le statut explicite -- même raison que L1-01 critère 8.
        from ..controllers.auth import _issue_access_token

        user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub="sub-me-driver", email="me-driver@example.invalid", name="Chauffeur", role="driver"
        )
        access_token, _ = _issue_access_token(user)

        response = self._get(access_token)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["driverStatus"], "pending")

    def test_missing_token_is_rejected(self):
        response = self._get()

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "UNAUTHORIZED")

    def test_garbage_token_is_rejected(self):
        response = self._get("ceci-n-est-pas-un-jwt")

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "UNAUTHORIZED")

    def test_expired_token_is_rejected_with_token_expired(self):
        user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub="sub-me-expired", email="me-expired@example.invalid", name="Expiré", role="client"
        )
        expired_claims = {
            "sub": user.babana_public_id,
            "role": "client",
            "iat": int(time.time()) - 7200,
            "exp": int(time.time()) - 3600,
            "jti": "11111111-2222-4333-8444-555555555555",
        }
        expired_token = jwt.encode(expired_claims, os.environ["JWT_SECRET"], algorithm="HS256")

        response = self._get(expired_token)

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "TOKEN_EXPIRED")
