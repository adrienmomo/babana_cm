# Solde prépayé du chauffeur (15 novembre, réponses du maître d'ouvrage) : rechargé en espèces à
# l'agence, commission en pourcentage de chaque course terminée, hors ligne à 0 FCFA ou moins, le
# plafond d'encaisse reste. Logique financière : couverture de tous les chemins (CLAUDE.md).
from __future__ import annotations

import json
import uuid
from unittest.mock import patch

from odoo.exceptions import UserError, ValidationError
from odoo.tests.common import HttpCase, tagged

from ..controllers.auth import _issue_access_token
from ..services import realtime_client


@tagged("post_install", "-at_install")
class TestDriverWallet(HttpCase):
    def setUp(self):
        super().setUp()
        self.Movement = self.env["babana.driver.wallet.movement"].sudo()

    def _approved_driver(self):
        sub = f"sub-wallet-{uuid.uuid4().hex[:8]}"
        user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub=sub, email=f"{sub}@example.invalid", name="Chauffeur Solde", role="driver"
        )
        driver = user._babana_driver()
        for document_type in ("license", "id_card", "profile_photo"):
            vals = {"driver_id": driver.id, "document_type": document_type, "storage_key": f"test/{document_type}.jpg", "verification_status": "verified"}
            if document_type == "license":
                vals["expires_on"] = "2030-01-01"
            self.env["babana.driver.document"].sudo().create(vals)
        moto = self.env["babana.motorcycle"].sudo().create({"license_plate": f"LT-{uuid.uuid4().hex[:4].upper()}-WL"})
        moto.write({"driver_id": driver.id})
        driver.invalidate_recordset()
        driver.sudo().action_approve(new_employee_name="Chauffeur Solde")
        self.env["babana.driver.selfie"].sudo().create({"driver_id": driver.id, "storage_key": "test/selfie.jpg", "state": "approved"})
        token, _ = _issue_access_token(user)
        return driver.sudo(), token

    def _topup(self, driver, amount):
        wizard = self.env["babana.driver.wallet.topup.wizard"].create({"driver_id": driver.id, "amount": amount, "reference": "R-1"})
        wizard.action_confirm()

    def _ride_until_started(self, driver):
        client = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub=f"sub-wallet-client-{uuid.uuid4().hex[:6]}", email="c@example.invalid", name="Client", role="client"
        ).partner_id
        ride = self.env["babana.ride"].sudo().action_request(
            {"client_id": client.id, "pickup_latitude": 4.05, "pickup_longitude": 9.7, "dropoff_latitude": 4.06, "dropoff_longitude": 9.71, "reference_distance_km": 2}
        )
        ride.action_propose(by_partner=client, driver=driver)
        ride.action_accept(by_driver=driver)
        ride.action_start(by_driver=driver)
        return ride

    def _go_online(self, token):
        return self.url_open(
            "/api/v1/drivers/me/availability",
            data=json.dumps({"online": True}).encode(),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )

    # --- Passage en ligne ------------------------------------------------------------------------

    def test_an_empty_balance_refuses_going_online(self):
        _driver, token = self._approved_driver()
        response = self._go_online(token)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "INSUFFICIENT_BALANCE")

    def test_a_cash_top_up_at_the_agency_lets_the_driver_go_online(self):
        driver, token = self._approved_driver()
        self._topup(driver, 5000)
        self.assertEqual(driver.wallet_balance, 5000)
        self.assertEqual(self._go_online(token).json(), {"online": True})

    def test_the_minimum_balance_is_a_setting(self):
        driver, _token = self._approved_driver()
        self._topup(driver, 500)
        self.assertIsNone(driver._check_online_eligibility())
        self.env["ir.config_parameter"].sudo().set_param("babana.wallet_min_balance", "1000")
        self.assertEqual(driver._check_online_eligibility()[0], "INSUFFICIENT_BALANCE")

    # --- Commission --------------------------------------------------------------------------------

    def test_a_finished_ride_debits_the_commission_rate_of_its_price(self):
        driver, _token = self._approved_driver()
        self._topup(driver, 5000)
        ride = self._ride_until_started(driver)

        ride.action_complete(by_driver=driver, final_amount=1250)

        commission = self.Movement.search([("ride_id", "=", ride.id)])
        self.assertEqual((commission.movement_type, commission.amount), ("commission", -125))
        self.assertEqual(driver.wallet_balance, 4875)

    def test_the_commission_rate_is_a_setting(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.commission_rate_percent", "15")
        driver, _token = self._approved_driver()
        self._topup(driver, 5000)
        ride = self._ride_until_started(driver)
        ride.action_complete(by_driver=driver, final_amount=1000)
        self.assertEqual(driver.wallet_balance, 4850)

    def test_a_commission_that_empties_the_balance_puts_the_driver_offline_after_the_ride(self):
        driver, _token = self._approved_driver()
        self._topup(driver, 50)
        driver.write({"is_online": True})
        ride = self._ride_until_started(driver)

        with patch.object(realtime_client, "notify_driver_forced_offline") as forced, patch.object(realtime_client, "notify_driver_unavailable"):
            ride.action_complete(by_driver=driver, final_amount=700)

        self.assertEqual(driver.wallet_balance, -20)
        self.assertFalse(driver.is_online)
        forced.assert_called_once()

    def test_a_ride_is_commissioned_once(self):
        driver, _token = self._approved_driver()
        self._topup(driver, 5000)
        ride = self._ride_until_started(driver)
        ride.action_complete(by_driver=driver, final_amount=1000)
        with self.assertRaises(ValidationError):
            self.Movement._babana_charge_commission(ride, 1000)

    # --- Journal immuable ----------------------------------------------------------------------------

    def test_the_journal_is_never_rewritten_nor_deleted(self):
        driver, _token = self._approved_driver()
        self._topup(driver, 5000)
        movement = self.Movement.search([("driver_id", "=", driver.id)])
        with self.assertRaises(UserError):
            movement.write({"amount": 9999})
        with self.assertRaises(UserError):
            movement.unlink()
        with self.assertRaises(UserError):
            driver.write({"wallet_balance": 1})

    def test_a_top_up_is_positive_and_an_adjustment_says_why(self):
        driver, _token = self._approved_driver()
        with self.assertRaises(ValidationError):
            self._topup(driver, 0)
        with self.assertRaises(ValidationError):
            self.Movement.create({"driver_id": driver.id, "movement_type": "adjustment", "amount": -100})

    # --- Lecture par l'app -----------------------------------------------------------------------------

    def test_the_app_reads_its_balance_and_recent_movements(self):
        driver, token = self._approved_driver()
        self._topup(driver, 5000)
        body = self.url_open("/api/v1/drivers/me/wallet", headers={"Authorization": f"Bearer {token}"}).json()
        self.assertEqual((body["balance"], body["minimumBalance"], body["commissionRatePercent"]), (5000, 0, 10.0))
        self.assertEqual(body["movements"][0]["type"], "topup")
        self.assertEqual(body["movements"][0]["reference"], "R-1")
