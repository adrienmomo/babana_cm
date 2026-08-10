# Vérification de jetons d'identité Google (L1-01, D4).
#
# Principe directeur de D19 : on simule le fournisseur, jamais notre logique. Ce module vérifie
# une vraie signature RS256 contre un vrai jeu de clés JWKS ; seule l'adresse du jeu de clés
# (GOOGLE_JWKS_URL) change entre développement (mock-google-identity, L0-08) et production
# (Google). Aucune branche `if development` dans ce fichier, jamais.
from __future__ import annotations

import json
import os
import re
import threading
import time

import jwt
import requests
from jwt.algorithms import RSAAlgorithm

GOOGLE_ISSUERS = {"accounts.google.com", "https://accounts.google.com"}
CLOCK_SKEW_LEEWAY_SECONDS = 10
DEFAULT_JWKS_CACHE_SECONDS = 600
JWKS_FETCH_TIMEOUT_SECONDS = 5


class InvalidGoogleToken(Exception):
    """Le jeton est rejeté — signature, iss, aud, exp ou email_verified.

    Une seule exception pour tous les cas : le contrôleur ne renvoie qu'INVALID_GOOGLE_TOKEN au
    client (catalogue C-01), jamais la raison précise — donner cette indication à l'appelant
    faciliterait la construction d'un jeton falsifié par tâtonnement.
    """


class _JwksCache:
    """Jeu de clés JWKS, mis en cache et rafraîchi selon les en-têtes de cache HTTP (L1-01,
    critère d'acceptation 7 : un second appel dans la fenêtre de cache ne déclenche aucune
    requête sortante). Un cache par processus worker Odoo — pas de mutation partagée entre
    processus à protéger au-delà d'un verrou local.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._keys_by_kid: dict[str, dict] = {}
        self._expires_at: float = 0.0
        self._source_url: str | None = None

    def get_key(self, kid: str, jwks_url: str) -> dict | None:
        with self._lock:
            self._refresh_if_needed(jwks_url)
            key = self._keys_by_kid.get(kid)
        if key is not None:
            return key
        # Absente du cache : peut être une rotation légitime des clés côté émetteur. Un seul
        # rafraîchissement forcé avant d'abandonner — pas de boucle, pas de tempête de requêtes
        # sur un jeton simplement invalide.
        with self._lock:
            self._refresh(jwks_url)
            return self._keys_by_kid.get(kid)

    def _refresh_if_needed(self, jwks_url: str) -> None:
        if jwks_url != self._source_url or time.monotonic() >= self._expires_at:
            self._refresh(jwks_url)

    def _refresh(self, jwks_url: str) -> None:
        response = requests.get(jwks_url, timeout=JWKS_FETCH_TIMEOUT_SECONDS)
        response.raise_for_status()
        payload = response.json()
        self._keys_by_kid = {key["kid"]: key for key in payload.get("keys", [])}
        self._source_url = jwks_url
        self._expires_at = time.monotonic() + _cache_seconds_from_headers(response.headers)


def _cache_seconds_from_headers(headers) -> float:
    cache_control = headers.get("Cache-Control", "")
    match = re.search(r"max-age=(\d+)", cache_control)
    if match:
        return max(int(match.group(1)), 1)
    return DEFAULT_JWKS_CACHE_SECONDS


# Instance de module : partagée par tous les appels d'un même worker, réinitialisée si le
# worker redémarre. C'est le cache dont parle le critère d'acceptation 7.
_jwks_cache = _JwksCache()


def verify_google_id_token(id_token: str) -> dict:
    """Vérifie un ID token Google et renvoie ses claims si toutes les vérifications passent.

    Dans l'ordre de la spécification L1-01 : signature, iss, aud, exp, email_verified. Ne
    jamais décoder un jeton sans vérifier sa signature d'abord, même « juste pour lire le sub »
    — c'est le piège documenté de cette tâche, et la cause classique d'usurpation de compte sur
    ce type d'intégration.
    """
    jwks_url = os.environ.get("GOOGLE_JWKS_URL", "https://www.googleapis.com/oauth2/v3/certs")
    allowed_audiences = _allowed_audiences()

    try:
        header = jwt.get_unverified_header(id_token)
    except jwt.InvalidTokenError as exc:
        raise InvalidGoogleToken("en-tête de jeton illisible") from exc

    kid = header.get("kid")
    if not kid:
        raise InvalidGoogleToken("jeton sans kid")

    jwk = _jwks_cache.get_key(kid, jwks_url)
    if jwk is None:
        raise InvalidGoogleToken(f"aucune clé publiée ne correspond à kid={kid!r}")

    try:
        public_key = RSAAlgorithm.from_jwk(json.dumps(jwk))
    except (ValueError, TypeError) as exc:
        raise InvalidGoogleToken("clé publique JWKS illisible") from exc

    try:
        # Signature, aud (liste blanche) et exp (avec une tolérance d'horloge de quelques
        # secondes) sont vérifiés ici, dans le même appel — jamais un décodage préalable non
        # vérifié. algorithms=["RS256"] est fixé explicitement : sans cette liste, un jeton
        # pourrait annoncer un autre algorithme (confusion RS256/HS256) et contourner la
        # vérification de signature.
        claims = jwt.decode(
            id_token,
            key=public_key,
            algorithms=["RS256"],
            audience=allowed_audiences,
            leeway=CLOCK_SKEW_LEEWAY_SECONDS,
        )
    except jwt.InvalidTokenError as exc:
        raise InvalidGoogleToken(str(exc)) from exc

    if claims.get("iss") not in GOOGLE_ISSUERS:
        raise InvalidGoogleToken(f"iss inattendu : {claims.get('iss')!r}")

    if not claims.get("email_verified"):
        raise InvalidGoogleToken("email_verified est faux")

    return claims


def _allowed_audiences() -> list[str]:
    raw = os.environ.get("GOOGLE_OAUTH_CLIENT_IDS", "")
    audiences = [aud.strip() for aud in raw.split(",") if aud.strip()]
    if not audiences:
        # Erreur de configuration serveur, pas un jeton client invalide : le contrôleur la
        # laisse remonter comme une erreur générique (500), pas comme INVALID_GOOGLE_TOKEN.
        raise RuntimeError("GOOGLE_OAUTH_CLIENT_IDS n'est pas configurée")
    return audiences
