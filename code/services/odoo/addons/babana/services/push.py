# Envoi de notifications push (L7-01), Firebase Cloud Messaging.
#
# D19 -- on simule le FOURNISSEUR, jamais notre logique. Contrairement à google_identity.py et
# routing.py (« même code, seule l'URL change »), FCM est l'exception que la stratégie de
# simulation nomme explicitement (amoa/05-prerequis-et-simulation.md §2) : le simulateur
# JOURNALISE la notification et l'expose pour inspection, il ne parle pas le protocole FCM. Il y
# a donc bien deux implémentations, choisies par `PUSH_PROVIDER` :
#
#   - `console` (défaut) -- écrit la notification dans les journaux, la garde en mémoire pour
#     l'endpoint d'inspection (controllers/internal.py). Aucun compte Firebase requis pour
#     parcourir un scénario complet (critère 4).
#   - `fcm` -- Firebase Cloud Messaging HTTP v1. Exige `FCM_PROJECT_ID` et
#     `FCM_CREDENTIALS_JSON` ; **aucun repli** si l'un manque (D43) -- non configuré, on échoue
#     bruyamment plutôt que de retomber en silence sur le simulateur ou sur un vrai envoi
#     inattendu.
#
# Ce qui reste RÉEL dans les deux cas (05 §2, colonne « ce qui reste réel ») : le déclenchement,
# le routage (données qui ouvrent le bon écran), la déduplication (portée côté app), et le
# NETTOYAGE des jetons invalides -- ce dernier piloté par le retour d'envoi, jamais par un
# balayage.
from __future__ import annotations

import collections
import dataclasses
import json
import logging
import os
import threading
import time

import jwt
import requests

import odoo
from odoo import SUPERUSER_ID, api

_logger = logging.getLogger(__name__)

PUSH_PROVIDER_ENV = "PUSH_PROVIDER"
FCM_PROJECT_ID_ENV = "FCM_PROJECT_ID"
FCM_CLIENT_EMAIL_ENV = "FCM_CLIENT_EMAIL"
FCM_PRIVATE_KEY_ENV = "FCM_PRIVATE_KEY"
FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
FCM_TOKEN_URL = "https://oauth2.googleapis.com/token"
FCM_SEND_TIMEOUT_SECONDS = 10
_OAUTH_TOKEN_TTL_MARGIN_SECONDS = 60


@dataclasses.dataclass(frozen=True)
class PushMessage:
    """Contenu MINIMAL et données de routage. Le texte visible ne porte jamais de donnée
    sensible (nom complet, adresse précise, montant) -- l'écran verrouillé est lisible par un
    tiers (L7-02). `data` ouvre l'app sur le bon écran ; ses valeurs sont des chaînes (contrainte
    FCM)."""

    title: str
    body: str
    data: dict
    # FCM `android.priority` / `apns-priority` : une proposition de course doit réveiller
    # l'appareil (L7-04), une notification d'information non.
    high_priority: bool = False
    # `android.collapse_key` / `apns-collapse-id` : plusieurs envois pour le même événement se
    # remplacent au lieu de s'empiler (ex. une seule proposition à la fois).
    collapse_key: str | None = None


@dataclasses.dataclass(frozen=True)
class PushResult:
    sent: int
    invalid_tokens: tuple  # jetons que le fournisseur a signalés invalides -- à désactiver


# --- Fournisseurs -------------------------------------------------------------------------


class PushProvider:
    name = "abstract"

    def send(self, tokens, message: PushMessage) -> PushResult:
        raise NotImplementedError


_SENT_LOG_MAX = 200
_sent_log: "collections.deque" = collections.deque(maxlen=_SENT_LOG_MAX)
_sent_log_lock = threading.Lock()


def _record_sent(tokens, message: PushMessage) -> None:
    with _sent_log_lock:
        _sent_log.append(
            {
                "at": time.time(),
                "tokens": [_redact(t) for t in tokens],
                "title": message.title,
                "body": message.body,
                "data": dict(message.data),
                "highPriority": message.high_priority,
                "collapseKey": message.collapse_key,
            }
        )


def recent_sent(limit: int = 50) -> list:
    """Lecture de l'endpoint d'inspection du simulateur (05 §2). Renvoie les dernières
    notifications journalisées par `ConsolePushProvider`, les plus récentes en dernier."""
    with _sent_log_lock:
        items = list(_sent_log)
    return items[-limit:]


def drain_sent() -> list:
    """Vide le journal d'inspection -- pour les tests, qui veulent partir d'un état connu."""
    with _sent_log_lock:
        items = list(_sent_log)
        _sent_log.clear()
    return items


def _redact(token: str) -> str:
    if not token or len(token) <= 12:
        return "***"
    return f"{token[:6]}...{token[-4:]}"


class ConsolePushProvider(PushProvider):
    """Simulateur (D19) : journalise, et garde en mémoire pour inspection. Ne signale jamais un
    jeton invalide -- un journal ne révoque rien."""

    name = "console"

    def send(self, tokens, message: PushMessage) -> PushResult:
        for token in tokens:
            _logger.info(
                "[push:console] -> %s | %s / %s | prio=%s | data=%s",
                _redact(token),
                message.title,
                message.body,
                "high" if message.high_priority else "normal",
                json.dumps(message.data, ensure_ascii=False),
            )
        _record_sent(tokens, message)
        return PushResult(sent=len(tokens), invalid_tokens=())


class FcmPushProvider(PushProvider):
    """Firebase Cloud Messaging HTTP v1. Jamais exercé dans cet environnement (aucun compte
    Firebase) -- même statut que le chemin réel de google_identity.py / routing.py : la logique
    est là, la vérification viendra du pilote."""

    name = "fcm"

    def __init__(self, project_id: str, client_email: str, private_key: str):
        self._project_id = project_id
        self._client_email = client_email
        # Une clé privée injectée par variable d'environnement porte souvent des "\n" littéraux.
        self._private_key = private_key.replace("\\n", "\n")
        self._send_url = (
            f"https://fcm.googleapis.com/v1/projects/{project_id}/messages:send"
        )
        self._access_token = None
        self._access_token_expiry = 0.0
        self._lock = threading.Lock()

    @classmethod
    def from_env(cls) -> "FcmPushProvider":
        project_id = os.environ.get(FCM_PROJECT_ID_ENV)
        client_email = os.environ.get(FCM_CLIENT_EMAIL_ENV)
        private_key = os.environ.get(FCM_PRIVATE_KEY_ENV)
        # D43 : non configuré, on échoue bruyamment -- jamais de repli implicite.
        if not project_id or not client_email or not private_key:
            raise RuntimeError(
                f"PUSH_PROVIDER=fcm exige {FCM_PROJECT_ID_ENV}, {FCM_CLIENT_EMAIL_ENV} et "
                f"{FCM_PRIVATE_KEY_ENV} (D43, aucun repli implicite)."
            )
        return cls(project_id, client_email, private_key)

    def _bearer(self) -> str:
        with self._lock:
            now = time.time()
            if self._access_token and now < self._access_token_expiry - _OAUTH_TOKEN_TTL_MARGIN_SECONDS:
                return self._access_token
            now_int = int(now)
            assertion = jwt.encode(
                {
                    "iss": self._client_email,
                    "scope": FCM_SCOPE,
                    "aud": FCM_TOKEN_URL,
                    "iat": now_int,
                    "exp": now_int + 3600,
                },
                self._private_key,
                algorithm="RS256",
            )
            response = requests.post(
                FCM_TOKEN_URL,
                data={
                    "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                    "assertion": assertion,
                },
                timeout=FCM_SEND_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            payload = response.json()
            self._access_token = payload["access_token"]
            self._access_token_expiry = now + int(payload.get("expires_in", 3600))
            return self._access_token

    def _build_body(self, token: str, message: PushMessage) -> dict:
        # data : uniquement des chaînes (contrainte FCM).
        data = {key: str(value) for key, value in message.data.items()}
        body = {
            "message": {
                "token": token,
                "notification": {"title": message.title, "body": message.body},
                "data": data,
            }
        }
        if message.high_priority:
            body["message"]["android"] = {"priority": "high"}
            body["message"]["apns"] = {"headers": {"apns-priority": "10"}}
        if message.collapse_key:
            body["message"].setdefault("android", {})["collapse_key"] = message.collapse_key
            body["message"].setdefault("apns", {}).setdefault("headers", {})[
                "apns-collapse-id"
            ] = message.collapse_key
        return body

    def send(self, tokens, message: PushMessage) -> PushResult:
        bearer = self._bearer()
        headers = {"Authorization": f"Bearer {bearer}", "Content-Type": "application/json"}
        sent = 0
        invalid = []
        for token in tokens:
            try:
                response = requests.post(
                    self._send_url,
                    headers=headers,
                    json=self._build_body(token, message),
                    timeout=FCM_SEND_TIMEOUT_SECONDS,
                )
            except requests.RequestException as exc:
                _logger.warning("[push:fcm] envoi en échec réseau pour %s : %s", _redact(token), exc)
                continue
            if response.status_code == 200:
                sent += 1
                continue
            # FCM signale un jeton révoqué/inexistant par 404 (UNREGISTERED) ou 400
            # (INVALID_ARGUMENT sur le champ `token`) -- ceux-là, et seulement ceux-là, sont
            # désactivés (critère 2). Un 401/403/5xx est un problème d'envoi, pas de jeton.
            if response.status_code in (400, 404) and _is_token_invalid(response):
                invalid.append(token)
                _logger.info("[push:fcm] jeton invalide signalé, désactivation : %s", _redact(token))
            else:
                _logger.warning(
                    "[push:fcm] envoi refusé (%s) pour %s : %s",
                    response.status_code,
                    _redact(token),
                    response.text[:300],
                )
        return PushResult(sent=sent, invalid_tokens=tuple(invalid))


def _is_token_invalid(response) -> bool:
    try:
        error = response.json().get("error", {})
    except ValueError:
        return response.status_code == 404
    status = error.get("status")
    if status in ("NOT_FOUND", "UNREGISTERED"):
        return True
    for detail in error.get("details", []):
        if detail.get("errorCode") in ("UNREGISTERED", "INVALID_ARGUMENT"):
            return True
    return False


# --- Sélection du fournisseur (D19 + D43) ------------------------------------------------

_provider_singleton = None
_provider_lock = threading.Lock()


def _provider_name() -> str:
    return (os.environ.get(PUSH_PROVIDER_ENV) or "console").strip().lower()


def get_provider() -> PushProvider:
    global _provider_singleton
    with _provider_lock:
        if _provider_singleton is None or _provider_singleton.name != _provider_name():
            name = _provider_name()
            if name == "console":
                _provider_singleton = ConsolePushProvider()
            elif name == "fcm":
                _provider_singleton = FcmPushProvider.from_env()
            else:
                raise RuntimeError(
                    f"{PUSH_PROVIDER_ENV} inconnu : {name!r} (attendu 'console' ou 'fcm')."
                )
        return _provider_singleton


def reset_provider_cache() -> None:
    """Pour les tests qui changent `PUSH_PROVIDER` en cours de route."""
    global _provider_singleton
    with _provider_lock:
        _provider_singleton = None


def provider_is_simulated() -> bool:
    return _provider_name() == "console"


# --- Dispatch -------------------------------------------------------------------------------


def notify_users_async(env, users, message: PushMessage) -> None:
    """Point d'entrée métier. Un envoi lent ne doit jamais ralentir une transition (critère 3) :
    la notification est déclenchée APRÈS le commit de la transaction (`cr.postcommit`), jamais
    à l'intérieur, et l'envoi lui-même part sur un fil de fond. Un échec d'envoi ne fait échouer
    aucune transaction (critère 5) -- `cr.postcommit` n'exécute son callback qu'après un COMMIT
    réussi, et le fil de fond avale toute exception.

    Même discipline D32/D33 que services/realtime_client.py : enregistré directement après
    l'écriture, jamais depuis l'intérieur d'un savepoint."""
    user_ids = tuple(users.ids)
    if not user_ids:
        return
    dbname = env.cr.dbname
    env.cr.postcommit.add(lambda: _spawn(dbname, user_ids, message))


def _spawn(dbname: str, user_ids: tuple, message: PushMessage) -> None:
    threading.Thread(
        target=lambda: _run_in_new_cursor(dbname, user_ids, message), daemon=True
    ).start()


def _run_in_new_cursor(dbname: str, user_ids: tuple, message: PushMessage) -> None:
    try:
        registry = odoo.registry(dbname)
        with registry.cursor() as cr:
            env = api.Environment(cr, SUPERUSER_ID, {})
            dispatch(env, user_ids, message)
            cr.commit()
    except Exception:
        _logger.exception(
            "[push] envoi asynchrone en échec -- aucune transaction métier affectée (L7-01, critère 5)."
        )


def dispatch(env, user_ids, message: PushMessage) -> PushResult:
    """Résout les jetons ACTIFS des comptes visés, envoie, puis désactive ceux que le fournisseur
    signale invalides (critère 2) -- c'est le seul moment où un jeton se nettoie. Isolé de tout
    fil/curseur pour être testable directement."""
    Token = env["babana.device.token"].sudo()
    users = env["res.users"].sudo().browse(list(user_ids))
    rows = Token._active_tokens_for_users(users)
    if not rows:
        return PushResult(sent=0, invalid_tokens=())
    tokens = list(rows.mapped("token"))
    result = get_provider().send(tokens, message)
    rows._mark_sent()
    if result.invalid_tokens:
        Token._deactivate_tokens(result.invalid_tokens)
    return result
