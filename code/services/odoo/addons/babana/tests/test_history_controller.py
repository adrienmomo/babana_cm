# Historique et factures du client (L6-10, version minimale de démonstration, 30 octobre).
from __future__ import annotations

import json
from unittest.mock import patch

from odoo.tests.common import HttpCase, tagged

from ..controllers.auth import _issue_access_token

_BREAKDOWN = {
    "base_fare": 200.0, "approach_fare": 75.0, "distance_fare": 420.0, "surge_amount": 0.0,
    "discount_amount": 0.0, "floor_amount": 0.0, "rounding_amount": 5.0,
    "minimum_fare_applied": False, "total": 700.0,
}


@tagged("post_install", "-at_install")
class TestRideHistoryController(HttpCase):
    def _driver(self):
        # Un chauffeur par course : une course terminée mais pas encore encaissée le retient.
        self._plates = getattr(self, "_plates", 0) + 1
        employee = self.env["hr.employee"].create({"name": "Emmanuel Ndoumbè"})
        driver = self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})
        motorcycle = self.env["babana.motorcycle"].create({"license_plate": f"LT-{4800 + self._plates}-HI"})
        motorcycle.write({"driver_id": driver.id})
        driver.invalidate_recordset()
        return driver

    def _client(self, sub, email="client@example.invalid"):
        user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub=sub, email=email, name=f"Client {sub}", role="client"
        )
        user.partner_id.email = email
        token, _ = _issue_access_token(user)
        return token, user.partner_id

    def _ride(self, client, *, until="settled", dropoff_label="vers Rond-point Deïdo"):
        ride = self.env["babana.ride"].action_request(
            {
                "client_id": client.id,
                "pickup_latitude": 4.0447, "pickup_longitude": 9.6996, "pickup_label": "vers Carrefour Tiff",
                "dropoff_latitude": 4.0622, "dropoff_longitude": 9.7108, "dropoff_label": dropoff_label,
                "reference_distance_km": 4.2,
                "fare_rule_snapshot": json.dumps(_BREAKDOWN),
            }
        )
        if until == "cancelled":
            ride.action_cancel(actor_role="client", actor_record=client)
            return ride
        driver = self._driver()
        ride.action_propose(by_partner=client, driver=driver)
        ride.action_accept(by_driver=driver)
        ride.action_start(by_driver=driver)
        if until == "in_progress":
            return ride
        ride.action_complete(by_driver=driver, final_amount=700)
        if until == "settled":
            ride.action_settle(by_driver=driver, amount_collected=700)
        return ride

    def _get(self, path, token):
        return self.url_open(path, headers={"Authorization": f"Bearer {token}"})

    def _post(self, path, token):
        return self.url_open(path, data=b"{}", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})

    # --- GET /rides -----------------------------------------------------------------------------

    def test_history_lists_the_clients_finished_rides_newest_first(self):
        token, client = self._client("sub-history-1")
        settled = self._ride(client)
        completed = self._ride(client, until="completed", dropoff_label="vers Marché Sandaga")
        in_progress = self._ride(client, until="in_progress")
        _other_token, stranger = self._client("sub-history-1-other")
        self._ride(stranger)

        body = self._get("/api/v1/rides", token).json()

        ids = [entry["id"] for entry in body["rides"]]
        self.assertEqual(ids, [completed.public_id, settled.public_id], "terminées seulement, la plus récente d'abord")
        self.assertNotIn(in_progress.public_id, ids)
        first, second = body["rides"]
        self.assertEqual((first["status"], first["invoiceAvailable"]), ("completed", False))
        self.assertEqual((second["status"], second["invoiceAvailable"]), ("settled", True))
        self.assertEqual(second["pickupLabel"], "vers Carrefour Tiff")
        self.assertEqual(second["dropoff"], {"latitude": 4.0622, "longitude": 9.7108})
        self.assertEqual(second["amount"], 700)
        self.assertIsNone(body["nextCursor"])

    def test_history_is_ordered_by_ride_date_not_by_creation_order(self):
        # Défaut vu le 30 octobre sur les courses semées : antidatées, la dernière créée est la plus
        # ancienne -- un tri sur l'identifiant affichait l'historique à l'envers.
        self.env["ir.config_parameter"].sudo().set_param("babana.ride_history_page_size", "2")
        token, client = self._client("sub-history-order")
        recent = self._ride(client, until="cancelled")
        middle = self._ride(client, until="cancelled")
        old = self._ride(client, until="cancelled")
        for ride, days in ((recent, 1), (middle, 5), (old, 30)):
            self.env.cr.execute(
                "UPDATE babana_ride SET requested_at = now() at time zone 'utc' - %s * interval '1 day' WHERE id = %s",
                (days, ride.id),
            )
        self.env["babana.ride"].invalidate_model()

        first = self._get("/api/v1/rides", token).json()
        second = self._get(f"/api/v1/rides?cursor={first['nextCursor']}", token).json()

        self.assertEqual(
            [r["id"] for r in first["rides"] + second["rides"]],
            [recent.public_id, middle.public_id, old.public_id],
        )

    def test_history_is_paginated_by_the_server_page_size(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.ride_history_page_size", "2")
        token, client = self._client("sub-history-2")
        rides = [self._ride(client, until="cancelled") for _ in range(3)]

        first = self._get("/api/v1/rides", token).json()
        second = self._get(f"/api/v1/rides?cursor={first['nextCursor']}", token).json()

        self.assertEqual([r["id"] for r in first["rides"]], [rides[2].public_id, rides[1].public_id])
        self.assertEqual(first["nextCursor"], rides[1].public_id)
        self.assertEqual([r["id"] for r in second["rides"]], [rides[0].public_id])
        self.assertIsNone(second["nextCursor"])

    # --- GET /rides/{id}/invoice ----------------------------------------------------------------

    def test_invoice_of_a_settled_ride_is_the_frozen_breakdown_paid_in_cash(self):
        token, client = self._client("sub-invoice-1", email="nadege@example.invalid")
        ride = self._ride(client)

        response = self._get(f"/api/v1/rides/{ride.public_id}/invoice", token)

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["invoiceNumber"], ride.invoice_id.name)
        self.assertEqual(body["amount"], 700)
        self.assertEqual(body["paymentMethod"], "cash")
        self.assertEqual(body["driverName"], "Emmanuel", "le prénom seulement")
        self.assertEqual(body["email"], "nadege@example.invalid")
        self.assertEqual(body["distanceMeters"], 4200)
        breakdown = body["breakdown"]
        self.assertEqual(breakdown["approachFare"], 75)
        self.assertEqual(
            breakdown["baseFare"] + breakdown["approachFare"] + breakdown["distanceFare"] + breakdown["surgeAmount"]
            - breakdown["discountAmount"] + breakdown["floorAmount"] + breakdown["roundingAmount"],
            body["amount"],
        )

    def test_a_ride_not_yet_paid_has_no_invoice(self):
        token, client = self._client("sub-invoice-2")
        ride = self._ride(client, until="completed")

        response = self._get(f"/api/v1/rides/{ride.public_id}/invoice", token)

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "INVOICE_NOT_AVAILABLE")

    def test_another_clients_invoice_is_not_found(self):
        _owner_token, owner = self._client("sub-invoice-owner")
        ride = self._ride(owner)
        stranger_token, _ = self._client("sub-invoice-stranger")

        self.assertEqual(self._get(f"/api/v1/rides/{ride.public_id}/invoice", stranger_token).status_code, 404)
        self.assertEqual(self._post(f"/api/v1/rides/{ride.public_id}/invoice/email", stranger_token).status_code, 404)

    # --- POST /rides/{id}/invoice/email ---------------------------------------------------------

    def _patch_send(self, outcome):
        model = type(self.env["babana.ride"])
        patcher = patch.object(model, "_babana_attempt_invoice_email", autospec=True, return_value=outcome)
        mock = patcher.start()
        self.addCleanup(patcher.stop)
        return mock

    def test_the_invoice_is_sent_to_the_clients_email(self):
        token, client = self._client("sub-invoice-mail", email="nadege@example.invalid")
        ride = self._ride(client)
        send = self._patch_send((object(), None))

        response = self._post(f"/api/v1/rides/{ride.public_id}/invoice/email", token)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"sent": True, "email": "nadege@example.invalid"})
        send.assert_called_once()

    def test_a_failed_send_is_reported_not_hidden(self):
        token, client = self._client("sub-invoice-mail-ko")
        ride = self._ride(client)
        self._patch_send((None, "SMTP refusé"))

        response = self._post(f"/api/v1/rides/{ride.public_id}/invoice/email", token)

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["error"]["code"], "INVOICE_EMAIL_FAILED")

    def test_a_client_without_email_is_told_so(self):
        token, client = self._client("sub-invoice-noemail")
        ride = self._ride(client)
        client.sudo().email = False
        send = self._patch_send((object(), None))

        response = self._post(f"/api/v1/rides/{ride.public_id}/invoice/email", token)

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "CLIENT_EMAIL_MISSING")
        send.assert_not_called()
