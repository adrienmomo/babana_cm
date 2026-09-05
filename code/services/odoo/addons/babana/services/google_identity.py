# Vérification de jetons d'identité Google (L1-01, D4).
#
# Principe directeur de D19 : on simule le fournisseur, jamais notre logique. Ce module vérifie
# une vraie signature RS256 contre un vrai jeu de clés JWKS.
#
# D75 (amoa/01-architecture.md §9 septdecies) : le jeton déclare son émetteur (`iss`), et c'est
# lui qui choisit le jeu de clés à vérifier -- jamais une adresse unique de configuration. Une
# seule `GOOGLE_JWKS_URL` empêchait un vrai jeton Google et un jeton du simulateur de coexister
# dans le même environnement, alors que c'est exactement ce qu'une démonstration doit montrer :
# une vraie connexion à l'écran ET des chauffeurs simulés qui bougent. GOOGLE_JWKS_URL reste
# l'adresse du vrai Google ; GOOGLE_JWKS_URL_MOCK, absente par défaut, est celle du simulateur
# (L0-08) -- son absence retire la possibilité d'accepter l'émetteur simulé, elle n'est pas un
# drapeau qu'on pourrait oublier de baisser (même forme que D43). Aucune branche `if
# development` dans ce fichier, jamais : les deux routes sont vérifiées de façon identique,
# seul l'ensemble des émetteurs acceptés dépend de la configuration.
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
# Émetteur déclaré par mock-google-identity (L0-08, services/mocks/google-identity/src/index.js)
# -- constante fixe, comme GOOGLE_ISSUERS ci-dessus : ce n'est pas une adresse ni un secret
# (invariant 5), c'est l'identité protocolaire du simulateur, indépendante de l'hôte ou du port
# auxquels il écoute dans tel ou tel environnement.
MOCK_GOOGLE_ISSUER = "https://mock-google-identity.invalid"
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


# Un cache par adresse de jeu de clés, pas un singleton unique (D75) : deux émetteurs
# coexistent désormais dans le même worker, et chacun garde son propre cache, sinon router vers
# l'un puis l'autre à chaque appel invaliderait le cache de l'autre à chaque bascule --
# exactement ce que le critère d'acceptation 7 de L1-01 interdit (aucune requête sortante dans
# la fenêtre de cache).
_jwks_caches: dict[str, _JwksCache] = {}
_jwks_caches_lock = threading.Lock()


def _cache_for_url(jwks_url: str) -> _JwksCache:
    with _jwks_caches_lock:
        cache = _jwks_caches.get(jwks_url)
        if cache is None:
            cache = _JwksCache()
            _jwks_caches[jwks_url] = cache
        return cache


def verify_google_id_token(id_token: str) -> dict:
    """Vérifie un ID token Google et renvoie ses claims si toutes les vérifications passent.

    Dans l'ordre de la spécification L1-01 : signature, iss, aud, exp, email_verified. Ne
    jamais décoder un jeton sans vérifier sa signature d'abord, même « juste pour lire le sub »
    — c'est le piège documenté de cette tâche, et la cause classique d'usurpation de compte sur
    ce type d'intégration.

    D75 : l'émetteur (`iss`) choisit le jeu de clés, donc il faut le lire avant de pouvoir
    vérifier quoi que ce soit -- un décodage sans vérification de signature, au même titre que
    la lecture du `kid` dans l'en-tête juste en dessous. Cette lecture ne sert qu'à choisir
    *quelle* clé publique vérifier la signature contre ; elle ne fait jamais confiance au
    contenu tant que la signature n'a pas été vérifiée avec cette clé, et `claims["iss"]` est
    revérifié après coup, sur le résultat vérifié.
    """
    allowed_audiences = _allowed_audiences()

    try:
        header = jwt.get_unverified_header(id_token)
    except jwt.InvalidTokenError as exc:
        raise InvalidGoogleToken("en-tête de jeton illisible") from exc

    kid = header.get("kid")
    if not kid:
        raise InvalidGoogleToken("jeton sans kid")

    try:
        unverified_claims = jwt.decode(id_token, options={"verify_signature": False})
    except jwt.InvalidTokenError as exc:
        raise InvalidGoogleToken("charge utile du jeton illisible") from exc

    claimed_issuer = unverified_claims.get("iss")
    jwks_url = _jwks_url_for_issuer(claimed_issuer)

    jwk = _cache_for_url(jwks_url).get_key(kid, jwks_url)
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

    if claims.get("iss") != claimed_issuer:
        # Signature vérifiée sur la même charge utile que celle lue plus haut : cet écart ne
        # devrait jamais se produire. Gardé comme filet, pas comme mécanisme de routage.
        raise InvalidGoogleToken(f"iss inattendu après vérification : {claims.get('iss')!r}")

    if not claims.get("email_verified"):
        raise InvalidGoogleToken("email_verified est faux")

    return claims


def _jwks_url_for_issuer(issuer: str | None) -> str:
    """Jeu de clés JWKS correspondant à l'émetteur déclaré par le jeton (D75).

    Le vrai Google n'a pas de repli implicite (D43, amoa/questions/REPONSES-2026-08-28.md §4) :
    une adresse de fournisseur externe non configurée doit échouer bruyamment, jamais retomber
    silencieusement sur la vraie API avec un destinataire différent de celui attendu -- c'est ce
    repli qui avait caché une nuit entière la cause d'un défaut symétrique côté recherche de
    lieu (@babana/maps, providers/google/config.ts).

    L'émetteur simulé n'est accepté que là où GOOGLE_JWKS_URL_MOCK est configurée -- son absence
    retire la possibilité plutôt que de laisser un drapeau qu'on pourrait oublier de baisser
    (même forme que D43). Sans cette clause, accepter plusieurs émetteurs voudrait dire accepter
    un émetteur qui délivre un jeton valide à qui le demande -- exactement la porte que D19 a
    toujours gardée à l'intérieur du développement. `deploy.sh` refuse un déploiement de
    production qui listerait GOOGLE_JWKS_URL_MOCK.
    """
    if issuer in GOOGLE_ISSUERS:
        url = os.environ.get("GOOGLE_JWKS_URL")
        if not url:
            raise RuntimeError("GOOGLE_JWKS_URL n'est pas configurée")
        return url

    if issuer == MOCK_GOOGLE_ISSUER:
        mock_url = os.environ.get("GOOGLE_JWKS_URL_MOCK")
        if mock_url:
            return mock_url

    raise InvalidGoogleToken(f"émetteur non reconnu ou non autorisé dans cet environnement : {issuer!r}")


def _allowed_audiences() -> list[str]:
    raw = os.environ.get("GOOGLE_OAUTH_CLIENT_IDS", "")
    audiences = [aud.strip() for aud in raw.split(",") if aud.strip()]
    if not audiences:
        # Erreur de configuration serveur, pas un jeton client invalide : le contrôleur la
        # laisse remonter comme une erreur générique (500), pas comme INVALID_GOOGLE_TOKEN.
        raise RuntimeError("GOOGLE_OAUTH_CLIENT_IDS n'est pas configurée")
    return audiences
