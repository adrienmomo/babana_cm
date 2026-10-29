# La course part au chauffeur disponible le plus proche -- le client ne choisit plus (D10 retiré).
#
# Le choix lui-même (le plus proche, à vol d'oiseau, réservé atomiquement) est fait par le service
# temps réel et prouvé là-bas (services/realtime/test/reservation-nearest.test.ts). Ici : ce
# qu'Odoo décide -- qui écarter (les chauffeurs déjà sollicités dans le tour en cours), quand
# s'arrêter (babana.dispatch_max_attempts), quand prévenir le client (`ride.unmatched`), et que
# « Réessayer » ouvre un nouveau tour. Appels au service temps réel remplacés par des doubles :
# l'enchaînement réel contre la pile est couvert par test_ride_controller.py.
from __future__ import annotations

from unittest.mock import patch

from odoo.exceptions import ValidationError
from odoo.tests.common import TransactionCase, tagged

from ..models.babana_ride_state import RideInvalidTransition
from ..services import dispatch, realtime_client, routing


@tagged("post_install", "-at_install")
class TestDispatch(TransactionCase):
    def setUp(self):
        super().setUp()
        params = self.env["ir.config_parameter"].sudo()
        params.set_param("babana.dispatch_radius_meters", "4000")
        params.set_param("babana.dispatch_max_attempts", "3")

        self.reserve = self._patch("reserve_nearest_and_propose")
        self.release = self._patch("release_reservation")
        self.unmatched = self._patch("notify_ride_unmatched")
        # Classement routier (services/approach.py) : personne à mesurer par défaut -- le service
        # temps réel choisit alors seul, à vol d'oiseau. Les tests du classement le remplacent.
        self.nearby = self._patch("fetch_nearby_drivers")
        self.nearby.return_value = []
        self.drivers = [self._make_driver(f"Chauffeur {index}") for index in range(4)]
        # Par défaut, le service temps réel choisit les chauffeurs dans l'ordre de la liste.
        self._service_offers(*self.drivers)

    def _patch(self, name):
        patcher = patch.object(realtime_client, name)
        mock = patcher.start()
        self.addCleanup(patcher.stop)
        return mock

    def _make_driver(self, name):
        employee = self.env["hr.employee"].create({"name": name})
        return self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})

    def _service_offers(self, *drivers):
        """Le service temps réel propose ces chauffeurs, dans cet ordre, puis plus personne."""
        outcomes = [{"outcome": "PROPOSED", "driverId": d.public_id, "expiresAt": "2026-10-22T10:00:30Z"} for d in drivers]
        outcomes.append({"outcome": "NO_DRIVER_AVAILABLE"})
        self.reserve.side_effect = outcomes

    def _ride(self):
        client = self.env["res.partner"].create({"name": "Client"})
        self.env["res.users"].sudo().create(
            {"name": "Client", "login": f"dispatch-{client.id}@example.invalid", "partner_id": client.id}
        )
        return self.env["babana.ride"].action_request(
            {
                "client_id": client.id,
                "pickup_latitude": 4.05,
                "pickup_longitude": 9.70,
                "dropoff_latitude": 4.06,
                "dropoff_longitude": 9.77,
            }
        )

    def _excluded_in_call(self, index):
        return self.reserve.call_args_list[index].kwargs["exclude_driver_public_ids"]

    # --- Commande du client ------------------------------------------------------------------

    def test_the_ride_is_proposed_to_the_driver_the_service_chose(self):
        ride = self._ride()
        driver = dispatch.propose_to_closest_driver(self.env, ride, by_partner=ride.client_id)

        self.assertEqual(driver, self.drivers[0])
        self.assertEqual(ride.state, "proposed")
        self.assertEqual(ride.driver_id, self.drivers[0])
        kwargs = self.reserve.call_args.kwargs
        self.assertEqual(kwargs["radius_meters"], 4000, "le rayon est le réglage d'Odoo")
        self.assertEqual(kwargs["exclude_driver_public_ids"], [], "une commande n'écarte personne")

    # --- Le plus proche PAR LA ROUTE (demande produit du 26 octobre) -------------------------

    def _nearby(self, *drivers):
        """Le service temps réel renvoie ces chauffeurs, dans l'ordre à vol d'oiseau."""
        self.nearby.return_value = [
            {"driverId": d.public_id, "latitude": 4.05 + index * 0.001, "longitude": 9.70, "distanceMeters": 100 * (index + 1)}
            for index, d in enumerate(drivers)
        ]

    def _road(self, distances_by_latitude):
        def fake_route(env, *, origin, destination):
            distance = distances_by_latitude[round(origin[0], 3)]
            if distance is None:
                raise routing.RouteUnavailable("panne simulée")
            return routing.RouteResult(distance, distance // 5, "")

        patcher = patch.object(routing, "measure_route", side_effect=fake_route)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_the_road_ranking_is_handed_to_the_reservation_closest_by_road_first(self):
        first_by_beeline, second_by_beeline = self.drivers[0], self.drivers[1]
        self._nearby(first_by_beeline, second_by_beeline)
        self._road({4.05: 3000, 4.051: 800})
        ride = self._ride()

        dispatch.propose_to_closest_driver(self.env, ride, by_partner=ride.client_id)

        self.assertEqual(
            self.reserve.call_args.kwargs["preferred_driver_public_ids"],
            [second_by_beeline.public_id, first_by_beeline.public_id],
        )
        nearby_kwargs = self.nearby.call_args.kwargs
        self.assertEqual(nearby_kwargs["origin"], (4.05, 9.70))
        self.assertEqual(nearby_kwargs["radius_meters"], 4000)

    def test_a_driver_whose_road_distance_cannot_be_measured_is_left_to_the_beeline_fallback(self):
        self._nearby(self.drivers[0], self.drivers[1])
        self._road({4.05: None, 4.051: 800})
        ride = self._ride()

        dispatch.propose_to_closest_driver(self.env, ride, by_partner=ride.client_id)

        self.assertEqual(self.reserve.call_args.kwargs["preferred_driver_public_ids"], [self.drivers[1].public_id])

    def test_an_unreadable_realtime_service_still_attempts_the_reservation_by_beeline(self):
        self.nearby.side_effect = realtime_client.RealtimeUnavailable("panne simulée")
        ride = self._ride()

        driver = dispatch.propose_to_closest_driver(self.env, ride, by_partner=ride.client_id)

        self.assertEqual(driver, self.drivers[0])
        self.assertEqual(self.reserve.call_args.kwargs["preferred_driver_public_ids"], [])

    def test_drivers_already_asked_are_not_measured_again_after_a_refusal(self):
        ride = self._ride()
        dispatch.propose_to_closest_driver(self.env, ride, by_partner=ride.client_id)

        dispatch.handle_driver_rejection(self.env, ride, self.drivers[0], reason="busy", expired=False)

        self.assertEqual(self.nearby.call_args.kwargs["exclude_driver_public_ids"], [self.drivers[0].public_id])

    def test_nobody_in_the_radius_leaves_the_ride_requested(self):
        self._service_offers()
        ride = self._ride()

        driver = dispatch.propose_to_closest_driver(self.env, ride, by_partner=ride.client_id)

        self.assertFalse(driver)
        self.assertEqual(ride.state, "requested")
        self.unmatched.assert_not_called()  # la réponse HTTP le dit déjà au client

    def test_only_the_client_of_the_ride_can_order_it(self):
        ride = self._ride()
        stranger = self.env["res.partner"].create({"name": "Autre client"})
        with self.assertRaises(RideInvalidTransition):
            dispatch.propose_to_closest_driver(self.env, ride, by_partner=stranger)
        self.reserve.assert_not_called()

    def test_a_ride_already_proposed_is_not_dispatched_twice_and_the_extra_driver_is_released(self):
        # Le cas du rejeu Odoo (D25) : deux commandes concurrentes de la même course, la perdante
        # rejouée. Son rejeu retrouve, par sa clé d'idempotence, le chauffeur que sa première
        # tentative avait réservé -- il doit être relâché quand la transition refuse, jamais laissé
        # réservé (et notifié) pour une course qui n'est pas la sienne.
        ride = self._ride()
        dispatch.propose_to_closest_driver(self.env, ride, by_partner=ride.client_id)
        with self.assertRaises(RideInvalidTransition):
            dispatch.propose_to_closest_driver(self.env, ride, by_partner=ride.client_id)
        self.assertEqual(ride.driver_id, self.drivers[0])
        self.release.assert_called_once_with(driver_public_id=self.drivers[1].public_id)

    def test_the_reservation_is_released_if_the_transition_fails(self):
        suspended = self._make_driver("Suspendu")
        suspended.write({"state": "suspended"})
        self._service_offers(suspended)
        ride = self._ride()

        with self.assertRaises(Exception):
            dispatch.propose_to_closest_driver(self.env, ride, by_partner=ride.client_id)
        self.release.assert_called_once_with(driver_public_id=suspended.public_id)

    # --- Refus ou expiration : le suivant, automatiquement -------------------------------------

    def test_after_a_refusal_the_next_closest_driver_is_asked(self):
        ride = self._ride()
        dispatch.propose_to_closest_driver(self.env, ride, by_partner=ride.client_id)

        dispatch.handle_driver_rejection(self.env, ride, self.drivers[0], reason="trop loin", expired=False)

        self.assertEqual(ride.state, "proposed")
        self.assertEqual(ride.driver_id, self.drivers[1])
        self.assertEqual(self._excluded_in_call(1), [self.drivers[0].public_id])
        self.assertEqual(len(ride.rejection_ids), 1, "le refus reste tracé sur la même course")
        self.unmatched.assert_not_called()

    def test_an_expired_proposal_also_moves_on_to_the_next_driver(self):
        ride = self._ride()
        dispatch.propose_to_closest_driver(self.env, ride, by_partner=ride.client_id)

        dispatch.handle_driver_rejection(self.env, ride, self.drivers[0], reason=None, expired=True)

        self.assertEqual(ride.driver_id, self.drivers[1])

    def test_every_driver_already_asked_in_this_round_is_skipped(self):
        ride = self._ride()
        dispatch.propose_to_closest_driver(self.env, ride, by_partner=ride.client_id)
        dispatch.handle_driver_rejection(self.env, ride, self.drivers[0], reason=None, expired=True)
        dispatch.handle_driver_rejection(self.env, ride, self.drivers[1], reason=None, expired=False)

        self.assertEqual(ride.driver_id, self.drivers[2])
        self.assertEqual(sorted(self._excluded_in_call(2)), sorted([self.drivers[0].public_id, self.drivers[1].public_id]))

    def test_after_the_maximum_number_of_drivers_the_client_is_told(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.dispatch_max_attempts", "2")
        ride = self._ride()
        dispatch.propose_to_closest_driver(self.env, ride, by_partner=ride.client_id)
        dispatch.handle_driver_rejection(self.env, ride, self.drivers[0], reason=None, expired=False)
        dispatch.handle_driver_rejection(self.env, ride, self.drivers[1], reason=None, expired=False)

        self.assertEqual(ride.state, "rejected")
        self.assertEqual(self.reserve.call_count, 2, "deux chauffeurs sollicités, pas un de plus")
        self.unmatched.assert_called_once()
        self.assertEqual(self.unmatched.call_args.kwargs["ride_public_id"], ride.public_id)

    def test_when_nobody_is_left_nearby_the_client_is_told(self):
        self._service_offers(self.drivers[0])
        ride = self._ride()
        dispatch.propose_to_closest_driver(self.env, ride, by_partner=ride.client_id)

        dispatch.handle_driver_rejection(self.env, ride, self.drivers[0], reason=None, expired=False)

        self.assertEqual(ride.state, "rejected")
        self.unmatched.assert_called_once()

    def test_an_unreachable_realtime_service_still_records_the_refusal(self):
        # Le refus est un fait : il s'écrit même si la recherche du suivant échoue -- le client est
        # prévenu et peut réessayer, plutôt qu'une course bloquée en `proposed` sur un refus.
        ride = self._ride()
        dispatch.propose_to_closest_driver(self.env, ride, by_partner=ride.client_id)
        self.reserve.side_effect = realtime_client.RealtimeUnavailable("panne simulée")

        dispatch.handle_driver_rejection(self.env, ride, self.drivers[0], reason=None, expired=False)

        self.assertEqual(ride.state, "rejected")
        self.assertEqual(len(ride.rejection_ids), 1)
        self.unmatched.assert_called_once()

    def test_a_late_expiry_for_a_previous_driver_does_not_touch_the_next_proposal(self):
        # Le service temps réel peut redélivrer un refus déjà traité (file persistante, L3-12) :
        # la course est alors déjà proposée au suivant, que ce rapport tardif ne doit pas défaire.
        ride = self._ride()
        dispatch.propose_to_closest_driver(self.env, ride, by_partner=ride.client_id)
        dispatch.handle_driver_rejection(self.env, ride, self.drivers[0], reason=None, expired=True)

        with self.assertRaises(RideInvalidTransition):
            dispatch.handle_driver_rejection(self.env, ride, self.drivers[0], reason=None, expired=True)
        self.assertEqual(ride.state, "proposed")
        self.assertEqual(ride.driver_id, self.drivers[1])

    # --- « Réessayer » : un nouveau tour ------------------------------------------------------

    def test_retry_starts_a_new_round_that_asks_everyone_again(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.dispatch_max_attempts", "1")
        self._service_offers(self.drivers[0], self.drivers[0])
        ride = self._ride()
        dispatch.propose_to_closest_driver(self.env, ride, by_partner=ride.client_id)
        dispatch.handle_driver_rejection(self.env, ride, self.drivers[0], reason=None, expired=True)
        self.assertEqual(ride.state, "rejected")

        dispatch.propose_to_closest_driver(self.env, ride, by_partner=ride.client_id)

        self.assertEqual(self._excluded_in_call(1), [], "un nouveau tour n'écarte personne")
        self.assertEqual(ride.state, "proposed")
        # Et c'est bien un nouveau tour : son premier refus redonne droit au suivant.
        self.env["ir.config_parameter"].sudo().set_param("babana.dispatch_max_attempts", "2")
        self.reserve.reset_mock()
        self._service_offers(self.drivers[1])
        dispatch.handle_driver_rejection(self.env, ride, self.drivers[0], reason=None, expired=True)
        self.assertEqual(ride.driver_id, self.drivers[1])
        self.assertEqual(self._excluded_in_call(0), [self.drivers[0].public_id])


@tagged("post_install", "-at_install")
class TestDispatchSettings(TransactionCase):
    def test_radius_and_attempts_are_babana_settings(self):
        self.env["res.config.settings"].create(
            {"babana_dispatch_radius_meters": 3500, "babana_dispatch_max_attempts": 4}
        ).execute()
        get = self.env["ir.config_parameter"].sudo().get_param
        self.assertEqual(get("babana.dispatch_radius_meters"), "3500")
        self.assertEqual(get("babana.dispatch_max_attempts"), "4")

    def test_they_must_be_positive(self):
        with self.assertRaises(ValidationError):
            self.env["res.config.settings"].create({"babana_dispatch_max_attempts": 0}).execute()
        with self.assertRaises(ValidationError):
            self.env["res.config.settings"].create({"babana_dispatch_radius_meters": 0}).execute()
