from unittest.mock import patch

from odoo.tests.common import TransactionCase, tagged

from ..services import realtime_client


@tagged("post_install", "-at_install")
class TestPickupNoteReachesTheDriver(TransactionCase):
    """L'indication du client voyage avec la réservation (`reserve_nearest_and_propose`), au même titre que
    l'origine ou le numéro du client : le service temps réel la rend au chauffeur dans
    `proposal.new` sans rappeler Odoo."""

    def _ride(self, note):
        client = self.env["res.partner"].create({"name": "Client indication"})
        return self.env["babana.ride"].action_request(
            {
                "client_id": client.id,
                "pickup_latitude": 4.05,
                "pickup_longitude": 9.70,
                "dropoff_latitude": 4.06,
                "dropoff_longitude": 9.77,
                "pickup_note": note,
            }
        )

    def _sent_payload(self, ride):
        client_user = self.env.user
        with patch.object(realtime_client, "_post", return_value={"outcome": "NO_DRIVER_AVAILABLE"}) as post:
            realtime_client.reserve_nearest_and_propose(
                ride=ride, client_user=client_user, radius_meters=500, exclude_driver_public_ids=[], idempotency_key="k"
            )
        return post.call_args.args[1]

    def test_the_note_is_sent_with_the_reservation(self):
        payload = self._sent_payload(self._ride("Devant la pharmacie"))
        self.assertEqual(payload["pickupNote"], "Devant la pharmacie")

    def test_no_note_is_sent_as_null(self):
        payload = self._sent_payload(self._ride(False))
        self.assertIsNone(payload["pickupNote"])
