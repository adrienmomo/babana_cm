# Tests de POST /api/v1/devices et /api/v1/devices/deactivate (C-01 devices.ts, L7-01). Même
# patron que TestMeController : jeton réel émis directement.
from __future__ import annotations

import json

from odoo.tests.common import HttpCase, tagged


@tagged("post_install", "-at_install")
class TestDevicesController(HttpCase):
    def _token_for(self, sub, role="client"):
        from ..controllers.auth import _issue_access_token

        user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub=sub, email=f"{sub}@example.invalid", name=sub, role=role
        )
        access_token, _ = _issue_access_token(user)
        return access_token, user

    def _post(self, path, body, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return self.url_open(path, data=json.dumps(body), headers=headers)

    def test_register_creates_a_device_token_row(self):
        token, user = self._token_for("devices-register")

        response = self._post("/api/v1/devices", {"token": "fcm-abc", "platform": "android"}, token)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"registered": True})
        rows = self.env["babana.device.token"].sudo().search([("user_id", "=", user.id)])
        self.assertEqual(rows.mapped("token"), ["fcm-abc"])
        self.assertEqual(rows.platform, "android")

    def test_register_is_additive_across_devices(self):
        token, user = self._token_for("devices-additive")

        self._post("/api/v1/devices", {"token": "fcm-phone", "platform": "android"}, token)
        self._post("/api/v1/devices", {"token": "fcm-tablet", "platform": "ios"}, token)

        rows = self.env["babana.device.token"].sudo().search([("user_id", "=", user.id)])
        self.assertEqual(set(rows.mapped("token")), {"fcm-phone", "fcm-tablet"})

    def test_register_rejects_a_bad_platform(self):
        token, _user = self._token_for("devices-bad-platform")

        response = self._post("/api/v1/devices", {"token": "fcm-abc", "platform": "windows"}, token)

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "VALIDATION_ERROR")

    def test_register_rejects_a_missing_token(self):
        token, _user = self._token_for("devices-missing-token")

        response = self._post("/api/v1/devices", {"platform": "android"}, token)

        self.assertEqual(response.status_code, 400)

    def test_register_requires_authentication(self):
        response = self._post("/api/v1/devices", {"token": "fcm-abc", "platform": "android"})

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "UNAUTHORIZED")

    def test_deactivate_is_idempotent(self):
        token, user = self._token_for("devices-deactivate")
        self._post("/api/v1/devices", {"token": "fcm-abc", "platform": "android"}, token)

        first = self._post("/api/v1/devices/deactivate", {"token": "fcm-abc"}, token)
        second = self._post("/api/v1/devices/deactivate", {"token": "fcm-abc"}, token)
        never_seen = self._post("/api/v1/devices/deactivate", {"token": "fcm-unknown"}, token)

        self.assertEqual(first.json(), {"deactivated": True})
        self.assertEqual(second.json(), {"deactivated": True})
        self.assertEqual(never_seen.json(), {"deactivated": True})
        active = self.env["babana.device.token"].sudo().search([("user_id", "=", user.id)])
        self.assertFalse(active, "le jeton désactivé sort des recherches")
