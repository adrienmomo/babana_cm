# Tests du plafond d'encaisse (D8, D28, L5-02). La mécanique d'application (action_settle force
# hors ligne dans la même transaction, une course en cours n'est jamais interrompue) est prouvée
# dans test_settlement.py, aux côtés des autres effets de l'encaissement -- ce fichier couvre ce
# qui reste : la contrainte de reconnexion explicite (désormais réellement déclenchable, le
# solde n'étant plus un champ-pont), et le canal réel vers le service temps réel.
from __future__ import annotations

import os
import socket

from odoo.exceptions import ValidationError
from odoo.tests.common import HttpCase, TransactionCase, tagged

from ..services import realtime_client


@tagged("post_install", "-at_install")
class TestCashLimitOnlineEligibility(TransactionCase):
    def _make_driver(self, name="Chauffeur"):
        employee = self.env["hr.employee"].create({"name": name})
        return self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})

    def _movement(self, driver, movement_type, amount, **vals):
        return self.env["babana.cash.movement"].create(
            {"driver_id": driver.id, "movement_type": movement_type, "amount": amount, **vals}
        )

    def test_a_driver_at_the_limit_cannot_go_online(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.cash_limit", "1000")
        driver = self._make_driver()
        self._movement(driver, "collection", 1000)
        driver.invalidate_recordset()

        with self.assertRaises(ValidationError):
            driver.write({"is_online": True})

    def test_a_driver_under_the_limit_can_go_online(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.cash_limit", "1000")
        driver = self._make_driver()
        self._movement(driver, "collection", 500)
        driver.invalidate_recordset()

        driver.write({"is_online": True})

        self.assertTrue(driver.is_online)


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
class TestCashLimitRealtimeChannel(HttpCase):
    """Le canal réel vers le service temps réel (D32, même patron que
    test_realtime_commit_hook.py) : notify_cash_limit_reached doit réellement poser la clé de
    blocage côté Redis, pas seulement construire une requête qui pourrait échouer silencieusement.
    Le comportement du service temps réel une fois la clé posée (retrait du pool, refus
    d'acceptation) est prouvé côté TypeScript, contre Redis réel (test/cash-guard.test.ts) --
    inutile de le reprouver ici."""

    @classmethod
    def _request_handler(cls, s, r, **kw):
        if r.url.startswith(os.environ.get("REALTIME_INTERNAL_URL", "http://realtime:3000")):
            from odoo.tests.common import _super_send

            return _super_send(s, r, **kw)
        return super()._request_handler(s, r, **kw)

    def test_notify_cash_limit_reached_sets_the_redis_key_once_committed(self):
        employee = self.env["hr.employee"].create({"name": "Chauffeur (test L5-02)"})
        driver = self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})
        key = f"babana:driver:cash-blocked:{driver.public_id}"
        self.addCleanup(_redis_delete, key)

        env = _FakeEnv()
        realtime_client.notify_cash_limit_reached(env, driver_public_id=driver.public_id)
        env.cr.commit()

        import time

        for _ in range(20):
            if _redis_exists(key):
                break
            time.sleep(0.25)
        self.assertTrue(_redis_exists(key), "la clé de blocage doit être posée une fois committé")

    def test_notify_cash_limit_reached_does_nothing_if_the_transaction_rolls_back(self):
        employee = self.env["hr.employee"].create({"name": "Chauffeur (test L5-02 bis)"})
        driver = self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})
        key = f"babana:driver:cash-blocked:{driver.public_id}"
        self.addCleanup(_redis_delete, key)

        env = _FakeEnv()
        realtime_client.notify_cash_limit_reached(env, driver_public_id=driver.public_id)
        env.cr.rollback()

        import time

        time.sleep(1.0)
        self.assertFalse(_redis_exists(key), "aucune clé ne doit être posée si la transaction n'a pas commité")
