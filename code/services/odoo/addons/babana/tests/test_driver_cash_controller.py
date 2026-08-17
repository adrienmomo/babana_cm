# Tests de GET /drivers/me/cash (C-01 settlement.ts) -- endpoint absent du découpage initial de
# L5, signalé par le rapport de la nuit du 19 août et comblé le 20 (amoa/questions/
# REPONSES-2026-08-20.md §4). Même patron que TestRemittanceController
# (test_remittance_validation.py) : jeton réel émis directement, pas le parcours Google mock
# complet, puisqu'aucune interaction chauffeur-temps-réel n'est en jeu ici.
from __future__ import annotations

import json
import uuid

from odoo.tests.common import HttpCase, tagged


@tagged("post_install", "-at_install")
class TestDriverCashController(HttpCase):
    def _make_driver_user(self, sub):
        from ..controllers.auth import _issue_access_token

        user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub=sub, email=f"{sub}@example.invalid", name=f"Chauffeur {sub}", role="driver"
        )
        driver = user._babana_driver()
        for document_type in ("license", "id_card"):
            vals = {
                "driver_id": driver.id,
                "document_type": document_type,
                "storage_key": f"test/{document_type}.jpg",
                "verification_status": "verified",
            }
            if document_type == "license":
                vals["expires_on"] = "2030-01-01"
            self.env["babana.driver.document"].sudo().create(vals)
        moto = self.env["babana.motorcycle"].sudo().create(
            {"license_plate": f"LT-{uuid.uuid4().hex[:4].upper()}-CA"}
        )
        moto.write({"driver_id": driver.id})
        driver.invalidate_recordset()
        driver.sudo().action_approve(new_employee_name=f"Chauffeur {sub}")
        access_token, _ = _issue_access_token(user)
        return access_token, driver

    def _get(self, path, token):
        return self.url_open(path, headers={"Authorization": f"Bearer {token}"})

    def test_returns_balance_limit_and_collected_today(self):
        token, driver = self._make_driver_user("sub-cash-controller-1")
        self.env["ir.config_parameter"].sudo().set_param("babana.cash_limit", "15000")
        self.env["babana.cash.movement"].sudo().create(
            {"driver_id": driver.id, "movement_type": "collection", "amount": 1200}
        )
        self.env["babana.cash.movement"].sudo().create(
            {"driver_id": driver.id, "movement_type": "collection", "amount": 800}
        )

        response = self._get("/api/v1/drivers/me/cash", token)

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["balance"], 2000)
        self.assertEqual(body["limit"], 15000)
        self.assertEqual(body["collectedToday"], 2000)

    def test_a_remittance_does_not_count_as_collected_today(self):
        token, driver = self._make_driver_user("sub-cash-controller-2")
        self.env["babana.cash.movement"].sudo().create(
            {"driver_id": driver.id, "movement_type": "collection", "amount": 1200}
        )
        self.env["babana.cash.remittance"].sudo().action_declare(
            driver=driver, declared_amount=1200
        )

        response = self._get("/api/v1/drivers/me/cash", token)

        self.assertEqual(response.json()["collectedToday"], 1200, "une déclaration seule ne change rien à l'encaissé")

    def test_an_unapproved_driver_is_rejected(self):
        from ..controllers.auth import _issue_access_token

        user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub="sub-cash-controller-3",
            email="sub-cash-controller-3@example.invalid",
            name="Chauffeur non approuvé",
            role="driver",
        )
        access_token, _ = _issue_access_token(user)

        response = self._get("/api/v1/drivers/me/cash", access_token)

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "DRIVER_NOT_APPROVED")

    def test_a_missing_token_is_rejected(self):
        response = self.url_open("/api/v1/drivers/me/cash")

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "UNAUTHORIZED")

    def test_response_matches_the_contract_example_shape(self):
        # DriverCashResponseSchema (C-01, settlement.ts) : trois champs, tous requis --
        # un contrôle négatif léger contre une régression de forme plutôt qu'une revalidation du
        # schéma Zod lui-même (hors de portée d'un test Python).
        token, driver = self._make_driver_user("sub-cash-controller-4")
        self.env["babana.cash.movement"].sudo().create(
            {"driver_id": driver.id, "movement_type": "collection", "amount": 500}
        )

        body = self._get("/api/v1/drivers/me/cash", token).json()

        self.assertEqual(set(body.keys()), {"balance", "limit", "collectedToday"})
