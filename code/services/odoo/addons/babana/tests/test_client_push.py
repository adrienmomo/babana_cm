# Notifications push au client (15 novembre, réponse du maître d'ouvrage) : chauffeur affecté,
# chauffeur arrivé, course terminée. Envoyées après le commit (push.notify_users_async), jamais
# dans la transition ; contenu minimal, aucune donnée sensible.
from __future__ import annotations

import uuid
from unittest.mock import patch

from odoo.tests.common import TransactionCase, tagged

from ..services import push


@tagged("post_install", "-at_install")
class TestClientPush(TransactionCase):
    def _actors(self):
        client_user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub=f"sub-push-client-{uuid.uuid4().hex[:6]}", email="c@example.invalid", name="Cliente Push", role="client"
        )
        employee = self.env["hr.employee"].create({"name": "Chauffeur Push"})
        driver = self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})
        return client_user, driver

    def _ride(self, client_user, driver):
        ride = self.env["babana.ride"].sudo().action_request(
            {"client_id": client_user.partner_id.id, "pickup_latitude": 4.05, "pickup_longitude": 9.7, "dropoff_latitude": 4.06, "dropoff_longitude": 9.71, "reference_distance_km": 2}
        )
        ride.action_propose(by_partner=client_user.partner_id, driver=driver)
        return ride

    def test_the_client_is_told_assigned_arrived_then_finished(self):
        client_user, driver = self._actors()
        ride = self._ride(client_user, driver)
        with patch.object(push, "notify_users_async") as notify:
            ride.action_accept(by_driver=driver)
            ride.action_mark_arrived(by_driver=driver)
            ride.action_start(by_driver=driver)
            ride.action_complete(by_driver=driver, final_amount=700)

        events = [call.args[2].data["event"] for call in notify.call_args_list]
        self.assertEqual(events, ["assigned", "arrived", "completed"])
        for call in notify.call_args_list:
            self.assertEqual(call.args[1], client_user)
            message = call.args[2]
            self.assertEqual(message.data["rideId"], ride.public_id)
            # Rien de sensible sur un écran verrouillé : ni montant, ni adresse, ni nom.
            self.assertNotIn("700", message.body)
            self.assertNotIn("Push", message.body)

    def test_starting_the_ride_sends_nothing(self):
        client_user, driver = self._actors()
        ride = self._ride(client_user, driver)
        ride.action_accept(by_driver=driver)
        with patch.object(push, "notify_users_async") as notify:
            ride.action_start(by_driver=driver)
        notify.assert_not_called()
