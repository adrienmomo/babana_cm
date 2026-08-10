# Tests du contrôleur d'authentification Google (L1-01). Contre mock-google-identity (L0-08) :
# c'est ce service simulé qui rend les tests négatifs écrivables — impossible contre le vrai
# Google (D19).
from __future__ import annotations

import json
import os

import requests

from odoo.tests.common import HttpCase, tagged
from odoo.tests.common import _super_send


def _mock_google_base_url() -> str:
    return os.environ.get("GOOGLE_MOCK_IDENTITY_URL", "http://mock-google-identity:4000")


def _first_allowed_audience() -> str:
    raw = os.environ.get("GOOGLE_OAUTH_CLIENT_IDS", "")
    first = raw.split(",")[0].strip()
    assert first, "GOOGLE_OAUTH_CLIENT_IDS doit être configurée pour exécuter ces tests"
    return first


def _mint_google_token(**overrides) -> str:
    payload = dict(overrides)
    # Un champ explicite du corps l'emporte toujours sur la variante "invalid" côté mock (voir
    # services/mocks/google-identity) : ne pas fixer `aud` ici quand le test veut précisément un
    # `aud` hors liste blanche, sinon la valeur par défaut écraserait la variante testée.
    if "aud" not in payload and payload.get("invalid") != "aud":
        payload["aud"] = _first_allowed_audience()
    response = requests.post(f"{_mock_google_base_url()}/token", json=payload, timeout=5)
    response.raise_for_status()
    return response.json()["id_token"]


@tagged("post_install", "-at_install")
class TestGoogleAuth(HttpCase):
    @classmethod
    def _request_handler(cls, s, r, **kw):
        # Le garde-fou du framework de test Odoo bloque toute requête HTTP externe non prévue
        # (BlockedRequest) sauf vers HOST/localhost. mock-google-identity (L0-08) est un
        # conteneur distinct, délibérément joignable pour rendre ces tests écrivables (D19) —
        # ce n'est pas un vrai service externe, c'est l'émetteur de test. Le laisser passer,
        # tout le reste retombe sur le comportement par défaut (bloqué).
        if r.url.startswith(_mock_google_base_url()):
            return _super_send(s, r, **kw)
        return super()._request_handler(s, r, **kw)

    def _post_auth(self, id_token, role="client"):
        return self.url_open(
            "/api/v1/auth/google",
            data=json.dumps({"idToken": id_token, "role": role}).encode(),
            headers={"Content-Type": "application/json"},
        )

    # --- Critère 1 : crée au premier appel, reprend au second --------------------------------

    def test_valid_token_creates_user_on_first_call(self):
        sub = "sub-first-call-test"
        token = _mint_google_token(sub=sub, email="amina@example.invalid")

        response = self._post_auth(token, role="client")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["accessToken"])
        self.assertTrue(body["refreshToken"])
        self.assertEqual(body["expiresIn"], 3600)
        self.assertEqual(body["user"]["role"], "client")
        self.assertNotIn("driverStatus", body["user"])

        users = self.env["res.users"].sudo().search([("google_sub", "=", sub)])
        self.assertEqual(len(users), 1)

    def test_valid_token_reuses_user_on_second_call(self):
        sub = "sub-second-call-test"
        self._post_auth(_mint_google_token(sub=sub, email="a@example.invalid"), role="client")
        count_after_first = (
            self.env["res.users"].sudo().search_count([("google_sub", "=", sub)])
        )

        self._post_auth(_mint_google_token(sub=sub, email="a@example.invalid"), role="client")
        count_after_second = (
            self.env["res.users"].sudo().search_count([("google_sub", "=", sub)])
        )

        self.assertEqual(count_after_first, 1)
        self.assertEqual(count_after_second, 1)

    # --- Critères 2 à 5 : chaque vérification rejette isolément -------------------------------

    def test_invalid_signature_rejected(self):
        token = _mint_google_token(sub="sub-bad-sig", invalid="signature")
        response = self._post_auth(token)
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "INVALID_GOOGLE_TOKEN")

    def test_invalid_audience_rejected(self):
        # Critère d'acceptation 3 : « la vulnérabilité classique de cette intégration » --
        # test explicite obligatoire, pas seulement souhaitable.
        token = _mint_google_token(sub="sub-bad-aud", invalid="aud")
        response = self._post_auth(token)
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "INVALID_GOOGLE_TOKEN")

    def test_expired_token_rejected(self):
        token = _mint_google_token(sub="sub-expired", invalid="exp")
        response = self._post_auth(token)
        self.assertEqual(response.status_code, 401)

    def test_email_not_verified_rejected(self):
        token = _mint_google_token(sub="sub-unverified", invalid="email_verified")
        response = self._post_auth(token)
        self.assertEqual(response.status_code, 401)

    def test_unexpected_issuer_rejected(self):
        token = _mint_google_token(sub="sub-bad-iss", invalid="iss")
        response = self._post_auth(token)
        self.assertEqual(response.status_code, 401)

    # --- Critère 6 : retrouvé par sub, jamais dupliqué sur changement d'email -----------------

    def test_email_change_does_not_create_duplicate(self):
        sub = "sub-email-change"
        self._post_auth(_mint_google_token(sub=sub, email="old@example.invalid"), role="client")
        self._post_auth(_mint_google_token(sub=sub, email="new@example.invalid"), role="client")

        users = self.env["res.users"].sudo().search([("google_sub", "=", sub)])
        self.assertEqual(len(users), 1)

    # --- Critère 8 : chauffeur non approuvé obtient un jeton et un statut pending -------------

    def test_pending_driver_gets_token_with_pending_status(self):
        sub = "sub-driver-pending"
        token = _mint_google_token(sub=sub, email="driver@example.invalid")

        response = self._post_auth(token, role="driver")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["user"]["role"], "driver")
        self.assertEqual(body["user"]["driverStatus"], "pending")

    # --- Requête malformée : rejetée avant toute vérification de jeton ------------------------

    def test_missing_role_rejected_before_token_verification(self):
        response = self.url_open(
            "/api/v1/auth/google",
            data=json.dumps({"idToken": "irrelevant"}).encode(),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "VALIDATION_ERROR")


@tagged("post_install", "-at_install")
class TestAuthRefreshAndLogout(HttpCase):
    @classmethod
    def _request_handler(cls, s, r, **kw):
        if r.url.startswith(_mock_google_base_url()):
            return _super_send(s, r, **kw)
        return super()._request_handler(s, r, **kw)

    def _login(self, sub):
        token = _mint_google_token(sub=sub, email=f"{sub}@example.invalid")
        response = self.url_open(
            "/api/v1/auth/google",
            data=json.dumps({"idToken": token, "role": "client"}).encode(),
            headers={"Content-Type": "application/json"},
        )
        return response.json()

    def _post(self, path, payload):
        return self.url_open(
            path, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
        )

    def test_refresh_rotates_and_old_refresh_token_becomes_unusable(self):
        session = self._login("sub-refresh-flow")
        first_refresh = session["refreshToken"]

        response = self._post("/api/v1/auth/refresh", {"refreshToken": first_refresh})
        self.assertEqual(response.status_code, 200)
        new_session = response.json()
        self.assertNotEqual(new_session["refreshToken"], first_refresh)
        self.assertTrue(new_session["accessToken"])

        # Critère 3 : réutiliser l'ancien jeton (déjà consommé) révoque toute la famille.
        replay = self._post("/api/v1/auth/refresh", {"refreshToken": first_refresh})
        self.assertEqual(replay.status_code, 401)
        self.assertEqual(replay.json()["error"]["code"], "TOKEN_REVOKED")

        # La famille entière est révoquée : le second jeton, pourtant jamais rejoué, ne
        # fonctionne plus non plus.
        second_attempt = self._post(
            "/api/v1/auth/refresh", {"refreshToken": new_session["refreshToken"]}
        )
        self.assertEqual(second_attempt.status_code, 401)
        self.assertEqual(second_attempt.json()["error"]["code"], "TOKEN_REVOKED")

    def test_refresh_with_unknown_token_is_unauthorized(self):
        response = self._post("/api/v1/auth/refresh", {"refreshToken": "jamais-emis"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "UNAUTHORIZED")

    def test_logout_revokes_the_token(self):
        session = self._login("sub-logout-flow")

        logout_response = self._post(
            "/api/v1/auth/logout", {"refreshToken": session["refreshToken"]}
        )
        self.assertEqual(logout_response.status_code, 200)
        self.assertEqual(logout_response.json(), {"revoked": True})

        replay = self._post("/api/v1/auth/refresh", {"refreshToken": session["refreshToken"]})
        self.assertEqual(replay.status_code, 401)
        self.assertEqual(replay.json()["error"]["code"], "TOKEN_REVOKED")

    def test_refresh_missing_body_field_is_validation_error(self):
        response = self._post("/api/v1/auth/refresh", {})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "VALIDATION_ERROR")
