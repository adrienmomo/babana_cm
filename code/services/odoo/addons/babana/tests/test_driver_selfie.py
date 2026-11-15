# Selfie de contrôle du chauffeur (15 novembre). Réponses du maître d'ouvrage : toutes les 24 h
# (réglage), le chauffeur travaille pendant la revue, un refus met hors ligne -- à la fin de la
# course en cours -- et exige un nouveau selfie ; un selfie dû est demandé au passage en ligne.
from __future__ import annotations

import json
import uuid
from datetime import timedelta
from unittest.mock import patch

from odoo import fields
from odoo.tests.common import HttpCase, tagged

from ..controllers.auth import _issue_access_token
from ..services import realtime_client

_A_JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"\x00" * 32
_A_PDF = b"%PDF-1.4\n" + b"\x00" * 32


@tagged("post_install", "-at_install")
class TestDriverSelfie(HttpCase):
    def setUp(self):
        super().setUp()
        self.Selfie = self.env["babana.driver.selfie"]

    def _approved_driver(self):
        sub = f"sub-selfie-{uuid.uuid4().hex[:8]}"
        user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub=sub, email=f"{sub}@example.invalid", name="Chauffeur Selfie", role="driver"
        )
        driver = user._babana_driver()
        for document_type in ("license", "id_card", "profile_photo"):
            vals = {"driver_id": driver.id, "document_type": document_type, "storage_key": f"test/{document_type}.jpg", "verification_status": "verified"}
            if document_type == "license":
                vals["expires_on"] = "2030-01-01"
            self.env["babana.driver.document"].sudo().create(vals)
        moto = self.env["babana.motorcycle"].sudo().create({"license_plate": f"LT-{uuid.uuid4().hex[:4].upper()}-SF"})
        moto.write({"driver_id": driver.id})
        driver.invalidate_recordset()
        driver.sudo().action_approve(new_employee_name="Chauffeur Selfie")
        token, _ = _issue_access_token(user)
        return driver.sudo(), token

    def _selfie(self, driver, state="pending", hours_ago=0):
        selfie = self.Selfie.sudo().create({"driver_id": driver.id, "storage_key": "test/selfie.jpg", "mime_type": "image/jpeg", "state": state})
        if hours_ago:
            selfie.write({"taken_at": fields.Datetime.now() - timedelta(hours=hours_ago)})
        return selfie

    def _go_online(self, token):
        return self.url_open(
            "/api/v1/drivers/me/availability",
            data=json.dumps({"online": True}).encode(),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )

    def _upload(self, token, data=_A_JPEG, content_type="image/jpeg"):
        return self.url_open(
            "/api/v1/drivers/me/selfie",
            data={"contentType": content_type},
            files={"file": ("selfie.jpg", data, content_type)},
            headers={"Authorization": f"Bearer {token}"},
        )

    # --- Passage en ligne ------------------------------------------------------------------

    def test_going_online_without_a_selfie_is_refused(self):
        _driver, token = self._approved_driver()
        response = self._go_online(token)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "SELFIE_REQUIRED")

    def test_a_selfie_taken_in_the_app_lets_the_driver_go_online_while_it_awaits_review(self):
        driver, token = self._approved_driver()

        uploaded = self._upload(token)

        self.assertEqual(uploaded.status_code, 201)
        body = uploaded.json()
        self.assertEqual((body["due"], body["lastState"], body["intervalHours"]), (False, "pending", 24))
        self.assertEqual(self._go_online(token).json(), {"online": True})
        self.assertTrue(driver.is_online)

    def test_a_pdf_is_not_a_selfie(self):
        _driver, token = self._approved_driver()
        response = self._upload(token, data=_A_PDF, content_type="application/pdf")
        self.assertEqual(response.status_code, 400)

    def test_a_selfie_older_than_the_interval_is_due_and_the_interval_is_a_setting(self):
        driver, _token = self._approved_driver()
        self._selfie(driver, state="approved", hours_ago=25)
        self.assertTrue(self.Selfie._status_for(driver)["due"])
        self.env["ir.config_parameter"].sudo().set_param("babana.selfie_interval_hours", "48")
        self.assertFalse(self.Selfie._status_for(driver)["due"])

    def test_the_status_route_says_what_is_due(self):
        driver, token = self._approved_driver()
        self._selfie(driver, state="rejected")
        driver.env["babana.driver.selfie"].sudo().search([("driver_id", "=", driver.id)]).write({"rejection_reason": "Visage caché"})
        body = self.url_open("/api/v1/drivers/me/selfie", headers={"Authorization": f"Bearer {token}"}).json()
        self.assertEqual((body["due"], body["lastState"], body["rejectionReason"]), (True, "rejected", "Visage caché"))

    # --- Refus : hors ligne, jamais au milieu d'une course ----------------------------------------

    def test_a_rejected_selfie_puts_an_idle_driver_offline_and_asks_for_a_new_one(self):
        driver, _token = self._approved_driver()
        selfie = self._selfie(driver)
        driver.write({"is_online": True})

        with patch.object(realtime_client, "notify_driver_forced_offline") as forced, patch.object(realtime_client, "notify_driver_unavailable") as held:
            selfie.action_reject(reason="Ce n'est pas le chauffeur")

        self.assertFalse(driver.is_online)
        self.assertTrue(driver.compliance_hold)
        held.assert_called_once()
        forced.assert_called_once()
        self.assertEqual(driver._check_online_eligibility()[0], "SELFIE_REQUIRED")

    def test_a_driver_rejected_mid_ride_finishes_it_then_goes_offline(self):
        driver, _token = self._approved_driver()
        selfie = self._selfie(driver)
        driver.write({"is_online": True})
        client = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub=f"sub-selfie-client-{uuid.uuid4().hex[:6]}", email="c@example.invalid", name="Client", role="client"
        ).partner_id
        ride = self.env["babana.ride"].sudo().action_request(
            {"client_id": client.id, "pickup_latitude": 4.05, "pickup_longitude": 9.7, "dropoff_latitude": 4.06, "dropoff_longitude": 9.71, "reference_distance_km": 2}
        )
        ride.action_propose(by_partner=client, driver=driver)
        ride.action_accept(by_driver=driver)
        ride.action_start(by_driver=driver)

        with patch.object(realtime_client, "notify_driver_forced_offline") as forced, patch.object(realtime_client, "notify_driver_unavailable") as held:
            selfie.action_reject(reason="Visage non reconnaissable")
            # Plus aucune proposition dès maintenant, mais la course continue : toujours en ligne.
            held.assert_called_once()
            forced.assert_not_called()
            self.assertTrue(driver.is_online)

            ride.action_complete(by_driver=driver, final_amount=700)

            forced.assert_called_once()
        self.assertFalse(driver.is_online)

    def test_back_online_with_a_new_selfie_releases_the_hold(self):
        driver, token = self._approved_driver()
        driver.write({"compliance_hold": True})
        self._upload(token)
        with patch.object(realtime_client, "notify_driver_available") as released:
            self.assertEqual(self._go_online(token).json(), {"online": True})
        released.assert_called_once()
        self.assertFalse(driver.compliance_hold)

    # --- Tâche planifiée --------------------------------------------------------------------

    def test_the_compliance_cron_takes_offline_a_driver_whose_selfie_fell_due(self):
        driver, _token = self._approved_driver()
        self._selfie(driver, state="approved", hours_ago=30)
        driver.write({"is_online": True})
        with patch.object(realtime_client, "notify_driver_forced_offline"), patch.object(realtime_client, "notify_driver_unavailable"):
            self.env["babana.driver"]._cron_enforce_compliance()
        self.assertFalse(driver.is_online)

    def test_the_cron_leaves_a_compliant_driver_alone(self):
        driver, _token = self._approved_driver()
        self._selfie(driver, state="approved", hours_ago=2)
        driver.write({"is_online": True})
        with patch.object(realtime_client, "notify_driver_forced_offline") as forced:
            self.env["babana.driver"]._cron_enforce_compliance()
        forced.assert_not_called()
        self.assertTrue(driver.is_online)
