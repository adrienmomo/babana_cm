# Test unitaire direct du cache JWKS (L1-01, critère d'acceptation 7) : un second appel dans la
# fenêtre de cache ne déclenche aucune requête sortante. Le test d'intégration de test_auth.py
# ne peut qu'observer indirectement ce comportement ; celui-ci l'isole précisément.
from __future__ import annotations

import os
from unittest.mock import patch

from odoo.tests.common import BaseCase, tagged

from ..services import google_identity


class _FakeJwksResponse:
    def __init__(self, keys, headers):
        self._keys = keys
        self.headers = headers

    def raise_for_status(self):
        return None

    def json(self):
        return {"keys": self._keys}


@tagged("post_install", "-at_install")
class TestJwksCache(BaseCase):
    def setUp(self):
        super().setUp()
        # Le cache est un singleton de module ; le réinitialiser évite toute dépendance à
        # l'ordre d'exécution des autres tests qui l'auront déjà rempli.
        google_identity._jwks_cache = google_identity._JwksCache()

    def test_second_call_within_cache_window_makes_no_outbound_request(self):
        fake_response = _FakeJwksResponse(
            keys=[{"kid": "k1", "kty": "RSA", "n": "x", "e": "AQAB"}],
            headers={"Cache-Control": "max-age=600"},
        )
        with patch.object(google_identity.requests, "get", return_value=fake_response) as mocked:
            first = google_identity._jwks_cache.get_key("k1", "http://example.invalid/jwks.json")
            second = google_identity._jwks_cache.get_key(
                "k1", "http://example.invalid/jwks.json"
            )

        self.assertEqual(mocked.call_count, 1)
        self.assertEqual(first["kid"], "k1")
        self.assertEqual(second["kid"], "k1")

    def test_unknown_kid_forces_a_single_refresh_then_gives_up(self):
        fake_response = _FakeJwksResponse(
            keys=[{"kid": "k1", "kty": "RSA", "n": "x", "e": "AQAB"}],
            headers={"Cache-Control": "max-age=600"},
        )
        with patch.object(google_identity.requests, "get", return_value=fake_response) as mocked:
            key = google_identity._jwks_cache.get_key(
                "unknown-kid", "http://example.invalid/jwks.json"
            )

        self.assertIsNone(key)
        # Un rafraîchissement initial (cache vide) puis un forcé (kid absent) -- jamais une
        # boucle qui martèlerait l'émetteur pour un jeton simplement invalide.
        self.assertEqual(mocked.call_count, 2)

    def test_cache_expires_without_cache_control_header(self):
        fake_response = _FakeJwksResponse(
            keys=[{"kid": "k1", "kty": "RSA", "n": "x", "e": "AQAB"}],
            headers={},
        )
        with patch.object(google_identity.requests, "get", return_value=fake_response):
            google_identity._jwks_cache.get_key("k1", "http://example.invalid/jwks.json")

        self.assertEqual(
            google_identity._jwks_cache._expires_at > 0,
            True,
            "un délai de cache par défaut doit s'appliquer même sans en-tête Cache-Control",
        )


@tagged("post_install", "-at_install")
class TestJwksUrlConfiguration(BaseCase):
    """D43 (amoa/questions/REPONSES-2026-08-28.md §4) : GOOGLE_JWKS_URL non configurée doit
    échouer bruyamment, jamais retomber silencieusement sur la vraie adresse Google -- ce repli
    est exactement ce qui a caché une nuit entière la cause d'un défaut symétrique côté
    recherche de lieu."""

    def test_missing_jwks_url_raises_instead_of_defaulting_to_the_real_google_endpoint(self):
        env_without_jwks_url = {k: v for k, v in os.environ.items() if k != "GOOGLE_JWKS_URL"}
        with patch.dict(os.environ, env_without_jwks_url, clear=True):
            with self.assertRaises(RuntimeError):
                google_identity._jwks_url()

    def test_configured_jwks_url_is_returned_unchanged(self):
        with patch.dict(os.environ, {"GOOGLE_JWKS_URL": "http://mock-google-identity:4000/jwks"}):
            self.assertEqual(
                google_identity._jwks_url(), "http://mock-google-identity:4000/jwks"
            )
