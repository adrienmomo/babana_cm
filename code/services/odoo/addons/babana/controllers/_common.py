# Utilitaires partagés entre les contrôleurs authentifiés (L1-05, L4-03) -- tout endpoint du
# catalogue C-01 hors /auth/*, qui s'authentifient par le corps de la requête (voir auth.py),
# porte l'en-tête Authorization: Bearer <accessToken> (docs/contracts/http-api.md).
from __future__ import annotations

import hmac
import json
import os

import psycopg2
from odoo import SUPERUSER_ID
from odoo.http import request
from odoo.service.model import PG_CONCURRENCY_EXCEPTIONS_TO_RETRY

from ..services.access_token import ExpiredAccessToken, InvalidAccessToken, verify_access_token


class AuthenticationFailed(Exception):
    """Levée par authenticated_user() -- code du catalogue C-01 (UNAUTHORIZED ou TOKEN_EXPIRED)
    et statut HTTP déjà résolus, prêts pour _error_response()."""

    def __init__(self, code: str, status: int = 401):
        super().__init__(code)
        self.code = code
        self.status = status


def authenticated_user():
    """Vérifie l'en-tête Authorization: Bearer <accessToken> et retrouve le res.users
    correspondant, élevé sur SUPERUSER_ID comme les routes /auth/* (env.user vide sous
    uid=None casse des hooks internes -- code/docs/odoo-pitfalls.md). Lève
    AuthenticationFailed sinon ; ne renvoie jamais (env, user) partiellement valide."""
    header = request.httprequest.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise AuthenticationFailed("UNAUTHORIZED")
    token = header[len("Bearer "):].strip()
    if not token:
        raise AuthenticationFailed("UNAUTHORIZED")

    try:
        claims = verify_access_token(token)
    except ExpiredAccessToken as exc:
        raise AuthenticationFailed("TOKEN_EXPIRED") from exc
    except InvalidAccessToken as exc:
        raise AuthenticationFailed("UNAUTHORIZED") from exc

    env = request.env(user=SUPERUSER_ID)
    # "sub", pas "uid" (D23, AccessTokenClaimsSchema) -- claims.get("uid") a longtemps subsisté
    # ici alors que controllers/auth.py émettait déjà "sub" : c'est exactement le lecteur oublié
    # qui aurait reproduit le défaut réparé cette nuit (amoa/questions/REPONSES-2026-08-15.md
    # §1), avant même que le jeton n'atteigne le service temps réel.
    user = env["res.users"].sudo().search(
        [("babana_public_id", "=", claims.get("sub"))], limit=1
    )
    if not user:
        # Signature valide mais sub inconnu : compte supprimé après émission du jeton. Même
        # code que tout autre défaut d'authentification -- ne pas distinguer, même raison
        # qu'InvalidAccessToken (services/access_token.py).
        raise AuthenticationFailed("UNAUTHORIZED")
    return env, user


def authenticated_internal_call() -> None:
    """Vérifie l'en-tête X-Realtime-Secret contre REALTIME_SHARED_SECRET (L3-17) -- même secret,
    même mécanisme que le sens sortant (services/realtime_client.py, L3-15) : pas un second à
    inventer. Réservé aux appels du service temps réel vers Odoo (controllers/internal.py),
    jamais atteignable depuis l'extérieur : ni le domaine mobile, ni Caddy ne routent vers ce
    contrôleur (vérifié dans infra/caddy/Caddyfile avant d'écrire cette fonction) -- ce secret est
    une seconde barrière, indépendante du routage, pas la seule.

    Lève AuthenticationFailed sinon, comme authenticated_user() -- même traitement d'erreur par
    l'appelant, un seul type d'exception à traduire en réponse HTTP.

    `hmac.compare_digest` plutôt que `==` : une comparaison à temps variable sur un secret de
    haute entropie (infra/env/README.md) fuiterait sa valeur octet par octet à un attaquant
    mesurant les temps de réponse -- même réflexe que la vérification de signature d'un jeton
    (jwt.decode le fait déjà pour nous côté access_token.py ; ici, rien ne le fait à notre place).
    """
    provided = request.httprequest.headers.get("X-Realtime-Secret", "")
    expected = os.environ["REALTIME_SHARED_SECRET"]
    if not provided or not hmac.compare_digest(provided, expected):
        raise AuthenticationFailed("UNAUTHORIZED")


def json_response(payload, status=200):
    return request.make_response(
        json.dumps(payload),
        status=status,
        headers=[("Content-Type", "application/json")],
    )


def error_response(code, message, status):
    return json_response({"error": {"code": code, "message": message, "details": None}}, status)


def error_payload(code, message):
    return {"error": {"code": code, "message": message, "details": None}}


def iso_datetime(value):
    """Sérialise un `datetime` Odoo (naïf, déjà en UTC -- convention interne d'Odoo pour tout
    champ `fields.Datetime`) vers le format que le contrat mobile exige : UTC suffixé (D40,
    C-01R, amoa/questions/C-01.md). Point unique de conversion pour tout contrôleur -- jamais
    une conversion recopiée par endpoint : c'est exactement la divergence qui est passée
    inaperçue jusqu'à ce que `POST /rides` s'en trouve rejeté côté client alors qu'il avait
    réussi côté serveur (`createdAt` portait un datetime nu, `expiresAt` de `/quote` avait par
    chance déjà son propre `+ "Z"` local -- deux endpoints, deux vérités).

    `None` passe au travers : un champ de date optionnel absent (ride pas encore proposée, par
    exemple) doit rester `null` dans la réponse, pas une chaîne."""
    if value is None:
        return None
    return value.isoformat() + "Z"


def parse_json_body():
    try:
        body = json.loads(request.httprequest.get_data(as_text=True) or "{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return body if isinstance(body, dict) else None


def idempotency_key():
    return request.httprequest.headers.get("Idempotency-Key") or None


def _lookup_idempotent_response(key: str, endpoint: str):
    """(payload, status) déjà résolus pour cette clé sur cet endpoint, ou None."""
    record = request.env["babana.idempotency.record"].sudo().search(
        [("idempotency_key", "=", key), ("endpoint", "=", endpoint)], limit=1
    )
    if not record or not record.response_body:
        return None
    return json.loads(record.response_body), record.response_status


def claim_idempotency_slot(key: str, endpoint: str):
    """Réserve atomiquement (idempotency_key, endpoint) AVANT tout appel à `handler` (C-01R,
    amoa/questions/C-01.md). Renvoie None si cette requête a gagné la réservation -- au
    contrôleur d'appeler `handler`, puis resolve_idempotency_slot ou release_idempotency_slot.
    Renvoie (payload, status) si une autre requête (concurrente, ou passée) l'a déjà obtenue.

    L'ancienne version de ce mécanisme cherchait le cache, puis -- si absent -- exécutait
    `handler` et écrivait le résultat. Sous deux requêtes réellement concurrentes portant la
    même Idempotency-Key (réseau intermittent oblige, CLAUDE.md : un client qui rejoue avant
    d'avoir vu la première réponse), les deux manquaient le cache, les deux exécutaient la
    transition, et la seconde à écrire heurtait la contrainte unique en 500 -- alors que la
    transition, elle, avait déjà été appliquée deux fois. Une lecture suivie d'une décision
    n'est jamais atomique (même défaut que celui que D26 a nommé pour le pool de chauffeurs,
    ici appliqué au cache d'idempotence Odoo plutôt qu'au pool Redis) : ce n'est pas l'écriture
    du cache qu'il faut protéger, c'est la réservation de la clé elle-même.

    La contrainte unique `babana_idempotency_key_endpoint_unique` sert de verrou. Un INSERT
    concurrent sur la même clé ne peut pas voir un échec immédiat pendant que l'autre ligne est
    encore en vol -- PostgreSQL le fait attendre le COMMIT ou le ROLLBACK de l'autre transaction
    avant de trancher. Le rattraper ici avec une IntegrityError signifie donc forcément que
    l'autre requête a déjà COMMIT (sinon notre INSERT aurait bloqué, pas échoué) : sa réponse
    est donc déjà en base, jamais à moitié écrite.

    Pas de vérification du nom de contrainte dans le message, contrairement au patron suivi par
    babana_ride_state.py::action_propose : cet INSERT n'écrit que dans
    babana.idempotency.record, qui ne porte qu'une seule contrainte unique -- toute
    UniqueViolation levée ici ne peut être que celle-là. (Le nom réellement porté par l'erreur
    Postgres n'est de toute façon pas `babana_idempotency_key_endpoint_unique` tel quel : Odoo
    le tronque et lui ajoute un hachage au-delà de 63 caractères -- vérifié en reproduisant la
    course réelle, pas supposé.)"""
    try:
        with request.env.cr.savepoint():
            request.env["babana.idempotency.record"].sudo().create(
                {
                    "idempotency_key": key,
                    "endpoint": endpoint,
                    "response_status": 0,
                    "response_body": "",
                }
            )
        return None
    except psycopg2.errors.UniqueViolation:
        cached = _lookup_idempotent_response(key, endpoint)
        if cached is None:
            # Ne devrait jamais arriver (voir docstring ci-dessus) -- un 500 explicite plutôt
            # qu'une réponse vide renvoyée en silence à un rejeu.
            raise
        return cached


def resolve_idempotency_slot(key: str, endpoint: str, payload, status: int) -> None:
    """Complète la réservation posée par claim_idempotency_slot avec la réponse réellement
    produite -- seulement pour une transition réellement appliquée (200 <= status < 300, voir
    le contrôleur appelant)."""
    request.env["babana.idempotency.record"].sudo().search(
        [("idempotency_key", "=", key), ("endpoint", "=", endpoint)], limit=1
    ).write({"response_status": status, "response_body": json.dumps(payload)})


def release_idempotency_slot(key: str, endpoint: str) -> None:
    """Efface la réservation quand la transition n'a pas été appliquée -- échec métier ou
    exception. La clé doit rester rejouable (C-01, critère 6 : « seules les transitions
    réellement appliquées sont mises en cache »)."""
    request.env["babana.idempotency.record"].sudo().search(
        [("idempotency_key", "=", key), ("endpoint", "=", endpoint)], limit=1
    ).unlink()


def run_idempotent(endpoint: str, handler):
    """Exécute `handler` au plus une fois par identifiant d'idempotence (en-tête
    Idempotency-Key), même sous requêtes concurrentes -- voir claim_idempotency_slot. Renvoie
    (payload, status) dans tous les cas ; ne traduit aucune exception, laissée à l'appelant
    (chaque contrôleur a son propre catalogue d'exceptions métier à traduire)."""
    key = idempotency_key()
    if not key:
        return handler()

    claimed = claim_idempotency_slot(key, endpoint)
    if claimed is not None:
        return claimed

    try:
        payload, status = handler()
    except PG_CONCURRENCY_EXCEPTIONS_TO_RETRY:
        # D25 : laisser remonter tel quel, sans toucher au curseur -- une SerializationFailure
        # (et ses cousines) le laisse invalide côté PostgreSQL tant qu'aucun ROLLBACK n'a eu
        # lieu, et y toucher ici lèverait InFailedSqlTransaction. Inutile de toute façon : Odoo
        # va annuler TOUTE la transaction et rejouer la requête entière avec un curseur neuf
        # (odoo.service.model.retrying), réservation d'idempotence comprise -- elle disparaît
        # avec le reste, pas besoin de la relâcher nous-mêmes.
        raise
    except Exception:
        release_idempotency_slot(key, endpoint)
        raise

    if 200 <= status < 300:
        resolve_idempotency_slot(key, endpoint, payload, status)
    else:
        release_idempotency_slot(key, endpoint)
    return payload, status
