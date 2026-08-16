# D32 (amoa/questions/REPONSES-2026-08-18.md §4) : un appel sortant vers le service temps réel
# (`services/realtime_client.py`) ne doit jamais modifier Redis avant que la transaction Odoo
# appelante n'ait réellement COMMIT -- jamais pendant. Avant ce correctif, `clear_engagement` et
# `notify_cancellation_async` déclenchaient leur appel HTTP immédiatement ; une transaction
# annulée (rejouée par D25, ou finalement échouée) laissait alors Redis modifié pour une décision
# qui n'a jamais eu lieu côté Odoo.
#
# Le test qui doit échouer d'abord (et échouait, avant le correctif de ce soir) : programmer
# l'appel puis ANNULER la transaction ne doit laisser aucune trace côté Redis. Contre le VRAI
# service temps réel et le VRAI Redis (`make up`), pas des doubles -- la preuve porte sur l'état
# Redis réellement observable, lu directement en RESP minimal (même technique que l'ancien
# `_redis_fixture.py`, retiré par L3-16 : aucune dépendance Redis dans l'image Odoo, invariant 1,
# ce module ne sert qu'aux tests).
from __future__ import annotations

import os
import re
import socket
import uuid
from pathlib import Path

from odoo.tests.common import HttpCase, tagged

from ..services import realtime_client


def _redis_host_port() -> tuple[str, int]:
    url = os.environ.get("REDIS_URL", "redis://redis:6379")
    without_scheme = url.split("://", 1)[-1]
    host, _, port = without_scheme.partition(":")
    return host, int(port or 6379)


def _redis_command(*parts: str) -> bytes:
    encoded = [p.encode() for p in parts]
    out = f"*{len(encoded)}\r\n".encode()
    for part in encoded:
        out += f"${len(part)}\r\n".encode() + part + b"\r\n"
    return out


def _redis_set(key: str, value: str, timeout: float = 5.0) -> None:
    host, port = _redis_host_port()
    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.sendall(_redis_command("SET", key, value))
        reply = sock.recv(4096)
        if not reply.startswith(b"+OK"):
            raise RuntimeError(f"SET a échoué : {reply!r}")


def _redis_exists(key: str, timeout: float = 5.0) -> bool:
    host, port = _redis_host_port()
    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.sendall(_redis_command("EXISTS", key))
        reply = sock.recv(4096)
    return reply.strip() == b":1"


def _redis_delete(key: str, timeout: float = 5.0) -> None:
    host, port = _redis_host_port()
    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.sendall(_redis_command("DEL", key))
        sock.recv(4096)


class _FakeCallbacks:
    """Reproduit `odoo.sql_db.Callbacks` (lu avant d'écrire ce test, pas supposé) : `add` empile,
    `run` exécute et vide, `clear` vide SANS exécuter."""

    def __init__(self):
        self._callbacks: list = []

    def add(self, func) -> None:
        self._callbacks.append(func)

    def run(self) -> None:
        callbacks, self._callbacks = self._callbacks, []
        for func in callbacks:
            func()

    def clear(self) -> None:
        self._callbacks = []


class _FakeCursor:
    """Reproduit `odoo.sql_db.Cursor` au seul niveau qui compte ici : `commit()` exécute les
    callbacks `postcommit` programmés ; `rollback()` les efface SANS les exécuter -- exactement
    le contrat que `sql_db.py` documente (`Cursor.commit`/`Cursor.rollback`,
    `TestCursor.commit` : "TestCursor ignores post-commit hooks by default", ce que ce faux
    contourne délibérément pour pouvoir tester le VRAI comportement de commit ici)."""

    def __init__(self):
        self.postcommit = _FakeCallbacks()

    def commit(self) -> None:
        self.postcommit.run()

    def rollback(self) -> None:
        self.postcommit.clear()


class _FakeEnv:
    def __init__(self):
        self.cr = _FakeCursor()


@tagged("post_install", "-at_install")
class TestRealtimeCommitHook(HttpCase):
    @classmethod
    def _request_handler(cls, s, r, **kw):
        # Odoo bloque tout appel HTTP sortant non explicitement autorisé en mode test -- même
        # garde-fou que test_ride_controller.py::TestRideController._request_handler. Sans cette
        # ouverture, realtime_client._post échouerait TOUJOURS (RealtimeUnavailable), et les deux
        # tests "un vrai commit déclenche l'appel" ci-dessous échoueraient pour la mauvaise
        # raison -- pas parce que le point d'accroche au commit est cassé, mais parce qu'aucun
        # appel sortant n'atteint jamais le service temps réel dans ce processus de test.
        if r.url.startswith(os.environ.get("REALTIME_INTERNAL_URL", "http://realtime:3000")):
            from odoo.tests.common import _super_send

            return _super_send(s, r, **kw)
        return super()._request_handler(s, r, **kw)

    def _engagement_key(self, driver_public_id: str) -> str:
        return f"babana:driver:engaged:{driver_public_id}"

    def _reservation_key(self, driver_public_id: str) -> str:
        return f"babana:driver:reservation:{driver_public_id}"

    # --- clear_engagement -----------------------------------------------------------------

    def test_clear_engagement_does_nothing_if_the_transaction_rolls_back(self):
        driver_public_id = f"test-driver-{uuid.uuid4()}"
        key = self._engagement_key(driver_public_id)
        self.addCleanup(_redis_delete, key)
        _redis_set(key, "1")

        env = _FakeEnv()
        realtime_client.clear_engagement(env, driver_public_id=driver_public_id)
        env.cr.rollback()

        # Laisse le temps à un éventuel appel HTTP mal programmé de partir et d'être traité --
        # généreux plutôt que fragile, même raisonnement que _realtime_ws.py.
        import time

        time.sleep(1.0)
        self.assertTrue(
            _redis_exists(key),
            "le marqueur d'engagement ne doit pas disparaître : la transaction n'a jamais commité",
        )

    def test_clear_engagement_fires_once_the_transaction_actually_commits(self):
        driver_public_id = f"test-driver-{uuid.uuid4()}"
        key = self._engagement_key(driver_public_id)
        self.addCleanup(_redis_delete, key)
        _redis_set(key, "1")

        env = _FakeEnv()
        realtime_client.clear_engagement(env, driver_public_id=driver_public_id)
        env.cr.commit()

        import time

        for _ in range(20):
            if not _redis_exists(key):
                break
            time.sleep(0.25)
        self.assertFalse(
            _redis_exists(key),
            "un vrai commit doit déclencher l'appel -- sinon ce test ne prouve rien (même piège "
            "que L3-13/L4-11 : une implémentation qui ne ferait jamais rien passerait le test "
            "précédent par accident)",
        )

    # --- notify_cancellation_async (relâche réservation ET engagement) ---------------------

    def test_notify_cancellation_async_touches_no_redis_key_if_the_transaction_rolls_back(self):
        driver_public_id = f"test-driver-{uuid.uuid4()}"
        engagement_key = self._engagement_key(driver_public_id)
        reservation_key = self._reservation_key(driver_public_id)
        self.addCleanup(_redis_delete, engagement_key)
        self.addCleanup(_redis_delete, reservation_key)
        _redis_set(engagement_key, "1")
        _redis_set(reservation_key, "some-ride-id")

        env = _FakeEnv()
        realtime_client.notify_cancellation_async(env, driver_public_id)
        env.cr.rollback()

        import time

        time.sleep(1.0)
        self.assertTrue(_redis_exists(engagement_key), "aucune clé Redis ne doit être touchée")
        self.assertTrue(_redis_exists(reservation_key), "aucune clé Redis ne doit être touchée")

    def test_notify_cancellation_async_clears_both_keys_once_committed(self):
        driver_public_id = f"test-driver-{uuid.uuid4()}"
        engagement_key = self._engagement_key(driver_public_id)
        reservation_key = self._reservation_key(driver_public_id)
        self.addCleanup(_redis_delete, engagement_key)
        self.addCleanup(_redis_delete, reservation_key)
        _redis_set(engagement_key, "1")
        _redis_set(reservation_key, "some-ride-id")

        env = _FakeEnv()
        realtime_client.notify_cancellation_async(env, driver_public_id)
        env.cr.commit()

        import time

        for _ in range(20):
            if not _redis_exists(engagement_key) and not _redis_exists(reservation_key):
                break
            time.sleep(0.25)
        self.assertFalse(_redis_exists(engagement_key))
        self.assertFalse(_redis_exists(reservation_key))


class TestRealtimeCommitHookLint(HttpCase):
    """Vérifié par le lint (CLAUDE.md, frontière D32) : « Aucun appel sortant vers le service
    temps réel hors d'un point d'accroche au commit ». La protection réelle est déjà structurelle
    -- `clear_engagement`/`notify_cancellation_async` exigent `env` en premier argument, un appel
    sans lui échoue à l'exécution (TypeError) -- mais une règle de lint qui échoue vaut mieux
    qu'une revue qui oublie (CLAUDE.md) : ce test balaie les contrôleurs par recherche plutôt que
    de faire confiance à la revue, même principe que
    services/realtime/test/pool-single-writer.test.ts (D26)."""

    CONTROLLERS_DIR = Path(__file__).resolve().parent.parent / "controllers"

    # Fonctions dont l'appel DOIT porter `env` en premier argument -- elles écrivent Redis APRÈS
    # une transition déjà appliquée, et n'ont donc de sens qu'au commit (D32). `reserve_and_propose`
    # et `release_reservation` (dans son unique appelant, l'except de _select_driver) en sont
    # délibérément absents : le premier PRÉCÈDE la transition (son résultat l'autorise), le second
    # compense une transaction qui va de toute façon être annulée -- ni l'un ni l'autre n'a de
    # commit à attendre (voir realtime_client.py, en-tête du module, et les docstrings des deux
    # fonctions ci-dessous pour le raisonnement complet).
    GATED_CALLS = ("clear_engagement", "notify_cancellation_async")

    def test_every_gated_call_passes_env_as_its_first_argument(self):
        offenders = []
        for path in sorted(self.CONTROLLERS_DIR.glob("*.py")):
            text = path.read_text()
            for name in self.GATED_CALLS:
                for match in re.finditer(rf"realtime_client\.{name}\(([^)]*)", text):
                    first_arg = match.group(1).strip()
                    if not (first_arg == "env" or first_arg.startswith("env,")):
                        offenders.append(f"{path.name}: realtime_client.{name}({first_arg}")
        self.assertEqual(
            offenders,
            [],
            "un appel sortant post-transition doit toujours passer env en premier argument "
            "(point d'accroche au commit, D32) : " + "; ".join(offenders),
        )
