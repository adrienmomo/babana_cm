# Test unitaire direct du cache JWKS (L1-01, critère d'acceptation 7) : un second appel dans la
# fenêtre de cache ne déclenche aucune requête sortante. Le test d'intégration de test_auth.py
# ne peut qu'observer indirectement ce comportement ; celui-ci l'isole précisément.
#
# D75 (amoa/01-architecture.md §9 septdecies) ajoute le routage par émetteur : TestJwksRouting
# ci-dessous, et le test qui compte le plus dans ce fichier --
# test_mock_issuer_rejected_when_mock_jwks_url_is_not_configured -- qui prouve qu'un jeton du
# simulateur présenté à une configuration de production est rejeté, pas seulement qu'un jeton
# valide passe.
from __future__ import annotations

import os
from unittest.mock import patch

from odoo.tests.common import BaseCase, tagged

from ..services import google_identity
from ..services.google_identity import InvalidGoogleToken


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
        # Un cache par adresse (D75) ; le vider évite toute dépendance à l'ordre d'exécution des
        # autres tests qui l'auront déjà rempli.
        google_identity._jwks_caches.clear()

    def test_second_call_within_cache_window_makes_no_outbound_request(self):
        fake_response = _FakeJwksResponse(
            keys=[{"kid": "k1", "kty": "RSA", "n": "x", "e": "AQAB"}],
            headers={"Cache-Control": "max-age=600"},
        )
        url = "http://example.invalid/jwks.json"
        with patch.object(google_identity.requests, "get", return_value=fake_response) as mocked:
            first = google_identity._cache_for_url(url).get_key("k1", url)
            second = google_identity._cache_for_url(url).get_key("k1", url)

        self.assertEqual(mocked.call_count, 1)
        self.assertEqual(first["kid"], "k1")
        self.assertEqual(second["kid"], "k1")

    def test_unknown_kid_forces_a_single_refresh_then_gives_up(self):
        fake_response = _FakeJwksResponse(
            keys=[{"kid": "k1", "kty": "RSA", "n": "x", "e": "AQAB"}],
            headers={"Cache-Control": "max-age=600"},
        )
        url = "http://example.invalid/jwks.json"
        with patch.object(google_identity.requests, "get", return_value=fake_response) as mocked:
            key = google_identity._cache_for_url(url).get_key("unknown-kid", url)

        self.assertIsNone(key)
        # Un rafraîchissement initial (cache vide) puis un forcé (kid absent) -- jamais une
        # boucle qui martèlerait l'émetteur pour un jeton simplement invalide.
        self.assertEqual(mocked.call_count, 2)

    def test_cache_expires_without_cache_control_header(self):
        fake_response = _FakeJwksResponse(
            keys=[{"kid": "k1", "kty": "RSA", "n": "x", "e": "AQAB"}],
            headers={},
        )
        url = "http://example.invalid/jwks.json"
        with patch.object(google_identity.requests, "get", return_value=fake_response):
            google_identity._cache_for_url(url).get_key("k1", url)

        self.assertEqual(
            google_identity._cache_for_url(url)._expires_at > 0,
            True,
            "un délai de cache par défaut doit s'appliquer même sans en-tête Cache-Control",
        )

    def test_two_urls_get_independent_caches_neither_refetches_the_other(self):
        # D75 : deux émetteurs actifs dans le même worker ne doivent jamais se faire expirer
        # mutuellement leur cache -- sinon router vers l'un puis l'autre à chaque appel
        # redéclenche une requête sortante à chaque fois, ce que le critère d'acceptation 7
        # interdit précisément.
        response_a = _FakeJwksResponse(
            keys=[{"kid": "ka", "kty": "RSA", "n": "x", "e": "AQAB"}],
            headers={"Cache-Control": "max-age=600"},
        )
        response_b = _FakeJwksResponse(
            keys=[{"kid": "kb", "kty": "RSA", "n": "y", "e": "AQAB"}],
            headers={"Cache-Control": "max-age=600"},
        )
        url_a = "http://a.example.invalid/jwks.json"
        url_b = "http://b.example.invalid/jwks.json"

        with patch.object(
            google_identity.requests, "get", side_effect=[response_a, response_b]
        ) as mocked:
            google_identity._cache_for_url(url_a).get_key("ka", url_a)
            google_identity._cache_for_url(url_b).get_key("kb", url_b)
            # Ré-alterner : ni l'un ni l'autre ne doit redéclencher une requête sortante.
            key_a = google_identity._cache_for_url(url_a).get_key("ka", url_a)
            key_b = google_identity._cache_for_url(url_b).get_key("kb", url_b)

        self.assertEqual(mocked.call_count, 2)
        self.assertEqual(key_a["kid"], "ka")
        self.assertEqual(key_b["kid"], "kb")


@tagged("post_install", "-at_install")
class TestJwksRouting(BaseCase):
    """D75 (amoa/01-architecture.md §9 septdecies) : l'émetteur déclaré par le jeton choisit le
    jeu de clés, jamais une adresse unique de configuration -- et l'émetteur simulé n'est
    accepté que là où GOOGLE_JWKS_URL_MOCK est configurée."""

    def test_missing_jwks_url_raises_instead_of_defaulting_to_the_real_google_endpoint(self):
        # D43 (amoa/questions/REPONSES-2026-08-28.md §4), inchangé par D75 : une adresse de
        # fournisseur externe non configurée doit échouer bruyamment, jamais retomber
        # silencieusement sur la vraie API.
        env_without_jwks_url = {
            k: v for k, v in os.environ.items() if k not in ("GOOGLE_JWKS_URL", "GOOGLE_JWKS_URL_MOCK")
        }
        with patch.dict(os.environ, env_without_jwks_url, clear=True):
            with self.assertRaises(RuntimeError):
                google_identity._jwks_url_for_issuer("accounts.google.com")
            with self.assertRaises(RuntimeError):
                google_identity._jwks_url_for_issuer("https://accounts.google.com")

    def test_configured_jwks_url_is_returned_unchanged_for_the_google_issuer(self):
        with patch.dict(os.environ, {"GOOGLE_JWKS_URL": "http://mock-google-identity:4000/jwks"}):
            self.assertEqual(
                google_identity._jwks_url_for_issuer("https://accounts.google.com"),
                "http://mock-google-identity:4000/jwks",
            )

    def test_mock_issuer_routes_to_mock_jwks_url_when_configured(self):
        # C'est le scénario que D75 existe pour rendre possible : GOOGLE_JWKS_URL (le vrai
        # Google) et GOOGLE_JWKS_URL_MOCK (le simulateur) configurées en même temps.
        with patch.dict(
            os.environ,
            {
                "GOOGLE_JWKS_URL": "https://www.googleapis.com/oauth2/v3/certs",
                "GOOGLE_JWKS_URL_MOCK": "http://mock-google-identity:4000/.well-known/jwks.json",
            },
        ):
            self.assertEqual(
                google_identity._jwks_url_for_issuer(google_identity.MOCK_GOOGLE_ISSUER),
                "http://mock-google-identity:4000/.well-known/jwks.json",
            )
            self.assertEqual(
                google_identity._jwks_url_for_issuer("https://accounts.google.com"),
                "https://www.googleapis.com/oauth2/v3/certs",
            )

    def test_mock_issuer_rejected_when_mock_jwks_url_is_not_configured(self):
        # Le test qui compte : une configuration de production (GOOGLE_JWKS_URL_MOCK absente,
        # comme deploy.sh l'exige) doit rejeter un jeton du simulateur -- prouvé en le tentant,
        # pas seulement en vérifiant qu'un jeton valide passe. Sans cette clause, « accepter
        # plusieurs émetteurs » voudrait dire accepter un émetteur qui délivre un jeton valide à
        # qui le demande.
        env_without_mock_url = {
            k: v for k, v in os.environ.items() if k != "GOOGLE_JWKS_URL_MOCK"
        }
        env_without_mock_url["GOOGLE_JWKS_URL"] = "https://www.googleapis.com/oauth2/v3/certs"
        with patch.dict(os.environ, env_without_mock_url, clear=True):
            with self.assertRaises(InvalidGoogleToken):
                google_identity._jwks_url_for_issuer(google_identity.MOCK_GOOGLE_ISSUER)

    def test_unrecognized_issuer_is_always_rejected(self):
        with patch.dict(
            os.environ,
            {
                "GOOGLE_JWKS_URL": "https://www.googleapis.com/oauth2/v3/certs",
                "GOOGLE_JWKS_URL_MOCK": "http://mock-google-identity:4000/.well-known/jwks.json",
            },
        ):
            with self.assertRaises(InvalidGoogleToken):
                google_identity._jwks_url_for_issuer("https://evil.example.invalid")
            with self.assertRaises(InvalidGoogleToken):
                google_identity._jwks_url_for_issuer(None)
