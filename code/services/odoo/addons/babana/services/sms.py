# Envoi de SMS (L1-09, code OTP de rattachement de numéro).
#
# Une interface, `SmsProvider`, et autant d'implémentations que de passerelles : changer de
# fournisseur, c'est écrire une classe et changer `SMS_PROVIDER` -- rien d'autre dans le module
# n'importe une passerelle précise. Même patron que services/push.py (D19, D43) :
#
#   - `console` (défaut) -- journalise le message et le garde en mémoire pour inspection. Aucun
#     compte requis : le parcours OTP se termine sans passerelle réelle (L1-09, critère 7).
#   - `tidjani_brothers` -- API SMS Tidjani & Brothers. Exige TB_SMS_API_URL et TB_SMS_API_KEY ;
#     **aucun repli** si l'un manque (D43) : on échoue bruyamment plutôt que de retomber sur le
#     simulateur en production.
#
# Règle qui vaut pour toutes les implémentations : le fournisseur ne décide de rien. Il envoie ce
# qu'on lui donne et rapporte, PAR NUMÉRO, ce qui s'est passé. Le code OTP, la limite de demandes
# et l'expiration restent dans babana.phone.verification (invariant 3 : la règle est au serveur,
# pas dans la passerelle).
from __future__ import annotations

import collections
import dataclasses
import logging
import os
import re
import threading
import time

import requests

_logger = logging.getLogger(__name__)

SMS_PROVIDER_ENV = "SMS_PROVIDER"
TB_SMS_API_URL_ENV = "TB_SMS_API_URL"
TB_SMS_API_KEY_ENV = "TB_SMS_API_KEY"
TB_SMS_TIMEOUT_ENV = "TB_SMS_TIMEOUT"

# Valeurs « de contrat » de l'API Tidjani & Brothers (pas des réglages métier) : plafond de
# destinataires par requête, débit maximal par clé, délais de reprise sur 429/503.
TB_MAX_RECIPIENTS_PER_REQUEST = 300
TB_MIN_SECONDS_BETWEEN_REQUESTS = 0.25  # 5 requêtes/seconde par clé
TB_RETRY_DELAYS_SECONDS = (1, 2, 4)
TB_DEFAULT_TIMEOUT_SECONDS = 15

# Raisons d'échec, indépendantes du fournisseur : c'est ce que voit l'appelant.
FAILURE_INSUFFICIENT_CREDIT = "insufficient_credit"
FAILURE_INVALID_RECIPIENT = "invalid_recipient"
FAILURE_PROVIDER_ERROR = "provider_error"
# Timeout ou coupure : le SMS est peut-être parti. Jamais rejoué automatiquement (l'API n'a pas de
# clé d'idempotence) -- un humain vérifie.
FAILURE_UNKNOWN_OUTCOME = "unknown_outcome"


class SmsAccountError(Exception):
    """La clé ou le compte est refusé (401/403) : tout envoi suivant échouera de la même façon.
    L'appelant arrête sa file au lieu d'insister."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(f"{code}: {message}" if message else code)
        self.code = code


@dataclasses.dataclass(frozen=True)
class SmsDelivery:
    """Sort d'UN numéro. `sent` = accepté par l'opérateur -- pas « délivré » : aucun accusé de
    réception n'existe encore."""

    number: str  # chiffres seulement, indicatif compris (237...)
    sent: bool
    failure: str | None = None  # FAILURE_* quand `sent` est faux
    provider_message_id: str | None = None


@dataclasses.dataclass(frozen=True)
class SmsBalance:
    credits: int
    sender: str | None
    usable: bool  # compte actif ET expéditeur approuvé


# --- Interface ----------------------------------------------------------------------------


class SmsProvider:
    name = "abstract"

    def send(self, recipients, message: str) -> list:
        """Envoie `message` à chaque numéro et renvoie un `SmsDelivery` par numéro distinct.
        Lève `SmsAccountError` si le compte est refusé ; toute autre défaillance est rapportée
        par numéro, jamais levée."""
        raise NotImplementedError

    def balance(self) -> SmsBalance | None:
        """Crédits restants, ou None si le fournisseur n'en a pas la notion."""
        return None


def normalize_number(raw: str) -> str:
    """Chiffres seulement. Le contrôle de format (E.164, Cameroun par défaut) appartient à
    l'appelant, qui connaît le pays par défaut ; ici on ne fait que retirer `+`, `00` initial,
    espaces et tirets, comme l'API les accepte."""
    digits = re.sub(r"\D", "", raw or "")
    return digits[2:] if digits.startswith("00") else digits


def _dedupe(recipients) -> list:
    return list(dict.fromkeys(n for n in (normalize_number(r) for r in recipients) if n))


# --- Simulateur -----------------------------------------------------------------------------

_sent_log: "collections.deque" = collections.deque(maxlen=200)
_sent_log_lock = threading.Lock()


def recent_sent(limit: int = 50) -> list:
    """Derniers messages journalisés par `ConsoleSmsProvider`, les plus récents en dernier --
    c'est ainsi qu'un test (ou le scénario de démonstration) lit le code OTP."""
    with _sent_log_lock:
        return list(_sent_log)[-limit:]


def drain_sent() -> list:
    with _sent_log_lock:
        items = list(_sent_log)
        _sent_log.clear()
    return items


class ConsoleSmsProvider(SmsProvider):
    """Simulateur (D19). Écrit le message en clair dans les journaux : acceptable parce que ce
    fournisseur n'est jamais actif en production (`provider_is_simulated`)."""

    name = "console"

    def send(self, recipients, message: str) -> list:
        numbers = _dedupe(recipients)
        for number in numbers:
            _logger.info("[sms:console] -> %s | %s", number, message)
        with _sent_log_lock:
            for number in numbers:
                _sent_log.append({"at": time.time(), "to": number, "message": message})
        return [SmsDelivery(number=n, sent=True) for n in numbers]


# --- Tidjani & Brothers ---------------------------------------------------------------------


class TidjaniAndBrothersSmsProvider(SmsProvider):
    """API SMS Tidjani & Brothers (POST /send, GET /balance), authentifiée par clé Bearer. Chaque
    clé est liée à UN expéditeur approuvé : l'expéditeur n'est donc pas un réglage d'Odoo.

    Règles de l'API qui dictent le code :
      - un numéro invalide fait rejeter toute la requête (INVALID_RECIPIENT,
        UNSUPPORTED_DESTINATION) : on écarte ceux que l'API liste, puis on renvoie le reste ;
      - pas de clé d'idempotence : on ne rejoue JAMAIS après un timeout ou une coupure, seulement
        sur un 429/503 explicite (rien n'est parti dans ce cas) ;
      - 401/403 : inutile d'insister, `SmsAccountError`.
    La clé n'est jamais journalisée, ni le corps du message au-dessus du niveau debug."""

    name = "tidjani_brothers"

    def __init__(
        self,
        api_url: str,
        api_key: str,
        timeout: float = TB_DEFAULT_TIMEOUT_SECONDS,
        *,
        sleep=time.sleep,
        session=None,
    ):
        self._api_url = api_url.rstrip("/")
        self._api_key = api_key
        self._timeout = timeout
        self._sleep = sleep  # injectable : les tests ne dorment pas
        self._session = session or requests
        self._last_request_at = 0.0
        self._lock = threading.Lock()

    @classmethod
    def from_env(cls) -> "TidjaniAndBrothersSmsProvider":
        api_url = os.environ.get(TB_SMS_API_URL_ENV)
        api_key = os.environ.get(TB_SMS_API_KEY_ENV)
        if not api_url or not api_key:
            raise RuntimeError(
                f"{SMS_PROVIDER_ENV}=tidjani_brothers exige {TB_SMS_API_URL_ENV} et "
                f"{TB_SMS_API_KEY_ENV} (D43, aucun repli implicite)."
            )
        raw_timeout = os.environ.get(TB_SMS_TIMEOUT_ENV)
        return cls(api_url, api_key, float(raw_timeout) if raw_timeout else TB_DEFAULT_TIMEOUT_SECONDS)

    # -- HTTP ----------------------------------------------------------------------------

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"}

    def _throttle(self) -> None:
        with self._lock:
            wait = TB_MIN_SECONDS_BETWEEN_REQUESTS - (time.monotonic() - self._last_request_at)
            if wait > 0:
                self._sleep(wait)
            self._last_request_at = time.monotonic()

    def _post_send(self, numbers, message):
        """Un POST /send avec reprises sur 429/503 uniquement. Renvoie la réponse HTTP, ou None si
        la requête a échoué sans réponse (timeout, coupure) -- cas où on ne rejoue pas."""
        attempts = len(TB_RETRY_DELAYS_SECONDS) + 1
        for attempt in range(attempts):
            self._throttle()
            try:
                response = self._session.post(
                    f"{self._api_url}/send",
                    headers=self._headers(),
                    json={"to": numbers, "message": message, "encoding": "auto"},
                    timeout=self._timeout,
                )
            except requests.RequestException as exc:
                _logger.error("[sms:tb] pas de réponse (%s) pour %d numéro(s) : issue inconnue", type(exc).__name__, len(numbers))
                return None
            if response.status_code in (429, 503) and attempt < attempts - 1:
                _logger.warning("[sms:tb] %s, nouvelle tentative dans %ss", response.status_code, TB_RETRY_DELAYS_SECONDS[attempt])
                self._sleep(TB_RETRY_DELAYS_SECONDS[attempt])
                continue
            return response
        return None  # inatteignable : la dernière tentative retourne ci-dessus

    @staticmethod
    def _error_of(response):
        try:
            error = response.json().get("error") or {}
        except ValueError:
            error = {}
        return error.get("code") or f"HTTP_{response.status_code}", error.get("details") or {}

    # -- Envoi ---------------------------------------------------------------------------

    def send(self, recipients, message: str) -> list:
        pending = _dedupe(recipients)
        outcomes = {}
        for start in range(0, len(pending), TB_MAX_RECIPIENTS_PER_REQUEST):
            self._send_batch(pending[start : start + TB_MAX_RECIPIENTS_PER_REQUEST], message, outcomes)
        return [outcomes[n] for n in pending]

    def _send_batch(self, numbers, message, outcomes) -> None:
        while numbers:
            response = self._post_send(numbers, message)
            if response is None:
                self._fail_all(numbers, FAILURE_UNKNOWN_OUTCOME, outcomes)
                return
            status = response.status_code
            if status == 201:
                self._record_success(response, numbers, outcomes)
                return
            code, details = self._error_of(response)
            if status in (401, 403):
                _logger.error("[sms:tb] compte refusé (%s %s) : file arrêtée", status, code)
                raise SmsAccountError(code)
            if code in ("INVALID_RECIPIENT", "UNSUPPORTED_DESTINATION"):
                bad = set(_dedupe(details.get("invalid") or details.get("numbers") or []))
                bad &= set(numbers)
                if not bad:  # l'API ne dit pas lesquels : renvoyer le même lot bouclerait
                    self._fail_all(numbers, FAILURE_INVALID_RECIPIENT, outcomes)
                    return
                self._fail_all(sorted(bad), FAILURE_INVALID_RECIPIENT, outcomes)
                numbers = [n for n in numbers if n not in bad]
                continue
            failure = FAILURE_INSUFFICIENT_CREDIT if code == "INSUFFICIENT_CREDIT" else FAILURE_PROVIDER_ERROR
            _logger.error("[sms:tb] envoi refusé (%s %s) pour %d numéro(s)", status, code, len(numbers))
            self._fail_all(numbers, failure, outcomes)
            return

    @staticmethod
    def _fail_all(numbers, failure, outcomes) -> None:
        for number in numbers:
            outcomes[number] = SmsDelivery(number=number, sent=False, failure=failure)

    @staticmethod
    def _record_success(response, numbers, outcomes) -> None:
        body = response.json()
        message_id = body.get("id")
        failed = set()
        for batch in body.get("batches") or []:
            if batch.get("status") == "failed":
                failed.update(batch.get("recipients") or [])
        for number in numbers:
            if number in failed:
                outcomes[number] = SmsDelivery(number=number, sent=False, failure=FAILURE_PROVIDER_ERROR)
            else:
                outcomes[number] = SmsDelivery(number=number, sent=True, provider_message_id=message_id)
        _logger.info(
            "[sms:tb] %s : %d numéro(s), %s partie(s), %s crédit(s) facturé(s), %d échec(s)",
            body.get("status"), len(numbers), body.get("parts"), body.get("creditsCharged"), len(failed),
        )

    def balance(self) -> SmsBalance | None:
        self._throttle()
        response = self._session.get(f"{self._api_url}/balance", headers=self._headers(), timeout=self._timeout)
        if response.status_code in (401, 403):
            raise SmsAccountError(self._error_of(response)[0])
        response.raise_for_status()
        body = response.json()
        sender = body.get("sender") or {}
        return SmsBalance(
            credits=int(body.get("credits", 0)),
            sender=sender.get("value"),
            usable=body.get("accountStatus") == "active" and sender.get("status") == "approved",
        )


# --- Choix de l'implémentation ----------------------------------------------------------------

_provider_singleton = None
_provider_lock = threading.Lock()


def _provider_name() -> str:
    return os.environ.get(SMS_PROVIDER_ENV, "console")


def get_sms_provider() -> SmsProvider:
    global _provider_singleton
    with _provider_lock:
        name = _provider_name()
        if _provider_singleton is None or _provider_singleton.name != name:
            if name == "console":
                _provider_singleton = ConsoleSmsProvider()
            elif name == "tidjani_brothers":
                _provider_singleton = TidjaniAndBrothersSmsProvider.from_env()
            else:
                raise RuntimeError(
                    f"{SMS_PROVIDER_ENV} inconnu : {name!r} (attendu 'console' ou 'tidjani_brothers')."
                )
        return _provider_singleton


def reset_sms_provider_cache() -> None:
    """Pour les tests qui changent `SMS_PROVIDER` en cours de route."""
    global _provider_singleton
    with _provider_lock:
        _provider_singleton = None


def provider_is_simulated() -> bool:
    return _provider_name() == "console"
