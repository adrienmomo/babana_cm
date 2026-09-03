# Tests des endpoints internes reçus du service temps réel (L3-17, controllers/internal.py).
# HttpCase, pas TransactionCase : ce sont des routes HTTP, authentifiées par un secret partagé
# plutôt que par un jeton d'utilisateur -- même raison que test_ride_controller.py, mais sans
# avoir besoin du vrai service temps réel ni de mock-google-identity : ces tests exercent
# uniquement le SENS RECEVANT (temps réel -> Odoo), indépendant de la façon dont la course a été
# proposée.
from __future__ import annotations

import json
import os
import uuid
from unittest.mock import patch

from odoo.tests.common import HttpCase, tagged

from ..services import push


def _internal_url(path: str) -> str:
    return f"/api/internal{path}"


@tagged("post_install", "-at_install")
class TestInternalController(HttpCase):
    def _post(self, path, body=None, secret=None, idempotency_key=None):
        headers = {"Content-Type": "application/json"}
        if secret is not None:
            headers["X-Realtime-Secret"] = secret
        if idempotency_key is not None:
            headers["Idempotency-Key"] = idempotency_key
        return self.url_open(_internal_url(path), data=json.dumps(body or {}).encode(), headers=headers)

    def _real_secret(self) -> str:
        return os.environ["REALTIME_SHARED_SECRET"]

    def _make_partner(self, name="Client"):
        return self.env["res.partner"].create({"name": name})

    def _make_driver(self, name="Chauffeur"):
        employee = self.env["hr.employee"].create({"name": name})
        return self.env["babana.driver"].sudo().create({"employee_id": employee.id, "state": "approved"})

    def _base_vals(self, client):
        return {
            "client_id": client.id,
            "pickup_latitude": 4.05,
            "pickup_longitude": 9.70,
            "dropoff_latitude": 4.06,
            "dropoff_longitude": 9.77,
        }

    def _ride_at_proposed(self):
        client = self._make_partner()
        driver = self._make_driver()
        ride = self.env["babana.ride"].sudo().action_request(self._base_vals(client))
        ride.sudo().action_propose(by_partner=client, driver=driver)
        return ride, driver

    def _make_client_user(self, sub):
        return self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub=sub, email=f"{sub}@example.invalid", name=f"Client {sub}", role="client"
        )

    def _make_driver_user(self, sub):
        # Même montage que TestDriverCashController._make_driver_user
        # (test_driver_cash_controller.py) : documents vérifiés + moto affectée sont les
        # préconditions réelles d'action_approve, pas un raccourci d'écriture directe de `state`.
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
            {"license_plate": f"LT-{uuid.uuid4().hex[:4].upper()}-CI"}
        )
        moto.write({"driver_id": driver.id})
        driver.invalidate_recordset()
        driver.sudo().action_approve(new_employee_name=f"Chauffeur {sub}")
        return user, driver

    # --- Authentification, commune aux trois routes --------------------------------------------

    def test_missing_secret_is_unauthorized_on_every_route(self):
        ride, driver = self._ride_at_proposed()
        for path in (
            f"/rides/{ride.public_id}/driver-accepted",
            f"/rides/{ride.public_id}/driver-rejected",
            "/drivers/engaged",
        ):
            response = self._post(path, {"driverId": driver.public_id})
            self.assertEqual(response.status_code, 401, path)
            self.assertEqual(response.json()["error"]["code"], "UNAUTHORIZED", path)

    def test_wrong_secret_is_unauthorized(self):
        ride, driver = self._ride_at_proposed()
        response = self._post(
            f"/rides/{ride.public_id}/driver-accepted", {"driverId": driver.public_id}, secret="not-the-secret"
        )
        self.assertEqual(response.status_code, 401)

    # --- driver-accepted -----------------------------------------------------------------------

    def test_driver_accepted_transitions_proposed_to_assigned(self):
        ride, driver = self._ride_at_proposed()

        response = self._post(
            f"/rides/{ride.public_id}/driver-accepted", {"driverId": driver.public_id}, secret=self._real_secret()
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(ride.state, "assigned")

    def test_driver_accepted_on_unknown_ride_is_not_found(self):
        response = self._post(
            "/rides/00000000-0000-4000-8000-000000000000/driver-accepted",
            {"driverId": "irrelevant"},
            secret=self._real_secret(),
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "RIDE_NOT_FOUND")

    def test_driver_accepted_with_unknown_driver_is_a_validation_error(self):
        ride, _driver = self._ride_at_proposed()
        response = self._post(
            f"/rides/{ride.public_id}/driver-accepted", {"driverId": "unknown"}, secret=self._real_secret()
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "VALIDATION_ERROR")

    def test_driver_accepted_on_a_ride_not_proposed_is_invalid_transition(self):
        ride, driver = self._ride_at_proposed()
        ride.sudo().action_accept(by_driver=driver)  # déjà 'assigned'

        response = self._post(
            f"/rides/{ride.public_id}/driver-accepted", {"driverId": driver.public_id}, secret=self._real_secret()
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "RIDE_INVALID_TRANSITION")

    # --- L3-12 : idempotence par Idempotency-Key (L4-03, C-01R), désormais câblée ici pour la
    # file persistante du service temps réel (services/realtime/src/odoo/outbox.ts) ------------

    def test_driver_accepted_replayed_with_the_same_idempotency_key_is_not_reapplied(self):
        ride, driver = self._ride_at_proposed()

        first = self._post(
            f"/rides/{ride.public_id}/driver-accepted",
            {"driverId": driver.public_id},
            secret=self._real_secret(),
            idempotency_key="outbox-entry-1",
        )
        self.assertEqual(first.status_code, 200)
        self.assertEqual(ride.state, "assigned")

        # Rejeu -- exactement ce que fait odoo/outbox.ts après un échec ou un redémarrage du
        # service : même chemin, même identifiant. Sans le câblage de ce soir, ceci ré-exécuterait
        # action_accept sur une course déjà 'assigned' et échouerait en RIDE_INVALID_TRANSITION --
        # toléré par la file (traité comme "déjà appliqué"), mais ce n'est plus ce qui se passe :
        # la réponse mise en cache par le premier appel est renvoyée telle quelle.
        second = self._post(
            f"/rides/{ride.public_id}/driver-accepted",
            {"driverId": driver.public_id},
            secret=self._real_secret(),
            idempotency_key="outbox-entry-1",
        )
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json(), first.json())
        self.assertEqual(ride.state, "assigned", "le rejeu ne doit pas avoir ré-exécuté la transition")

    def test_driver_rejected_replayed_with_the_same_idempotency_key_is_not_reapplied(self):
        ride, driver = self._ride_at_proposed()

        first = self._post(
            f"/rides/{ride.public_id}/driver-rejected",
            {"driverId": driver.public_id, "reason": "trop loin", "expired": False},
            secret=self._real_secret(),
            idempotency_key="outbox-entry-2",
        )
        self.assertEqual(first.status_code, 200)
        self.assertEqual(ride.state, "rejected")
        self.assertEqual(len(ride.rejection_ids), 1)

        second = self._post(
            f"/rides/{ride.public_id}/driver-rejected",
            {"driverId": driver.public_id, "reason": "trop loin", "expired": False},
            secret=self._real_secret(),
            idempotency_key="outbox-entry-2",
        )
        self.assertEqual(second.status_code, 200)
        self.assertEqual(
            len(ride.rejection_ids), 1, "le rejeu ne doit pas avoir ajouté une seconde ligne de refus"
        )

    def test_driver_accepted_replayed_without_an_idempotency_key_keeps_the_old_409_safety_net(self):
        # Comportement inchangé pour un appelant qui n'envoie pas la clé (aucun aujourd'hui, hors
        # de la file) -- même filet que celui documenté avant ce soir : un rejeu ré-exécute
        # action_accept, qui échoue proprement sur une course déjà 'assigned'.
        ride, driver = self._ride_at_proposed()
        ride.sudo().action_accept(by_driver=driver)

        response = self._post(
            f"/rides/{ride.public_id}/driver-accepted", {"driverId": driver.public_id}, secret=self._real_secret()
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "RIDE_INVALID_TRANSITION")

    # --- driver-rejected -------------------------------------------------------------------------

    def test_driver_rejected_explicit_transitions_proposed_to_rejected(self):
        ride, driver = self._ride_at_proposed()

        response = self._post(
            f"/rides/{ride.public_id}/driver-rejected",
            {"driverId": driver.public_id, "reason": "trop loin", "expired": False},
            secret=self._real_secret(),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(ride.state, "rejected")
        self.assertEqual(ride.rejection_ids.reason, "trop loin")

    def test_driver_rejected_expired_carries_a_distinct_reason(self):
        ride, driver = self._ride_at_proposed()

        response = self._post(
            f"/rides/{ride.public_id}/driver-rejected",
            {"driverId": driver.public_id, "expired": True},
            secret=self._real_secret(),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(ride.state, "rejected")
        self.assertEqual(ride.rejection_ids.reason, "expiré")

    # --- drivers/engaged (réconciliation, critère 7) --------------------------------------------

    def test_engaged_drivers_lists_assigned_and_in_progress_only(self):
        assigned_ride, assigned_driver = self._ride_at_proposed()
        assigned_ride.sudo().action_accept(by_driver=assigned_driver)  # 'assigned'

        in_progress_ride, in_progress_driver = self._ride_at_proposed()
        in_progress_ride.sudo().action_accept(by_driver=in_progress_driver)
        in_progress_ride.sudo().action_start(by_driver=in_progress_driver)  # 'in_progress'

        proposed_ride, proposed_driver = self._ride_at_proposed()  # reste 'proposed'

        response = self._post("/drivers/engaged", {}, secret=self._real_secret())

        self.assertEqual(response.status_code, 200)
        engaged = response.json()["engaged"]
        by_driver_id = {entry["driverId"]: entry["rideId"] for entry in engaged}
        self.assertEqual(by_driver_id[assigned_driver.public_id], assigned_ride.public_id)
        self.assertEqual(by_driver_id[in_progress_driver.public_id], in_progress_ride.public_id)
        self.assertNotIn(
            proposed_driver.public_id,
            by_driver_id,
            "'proposed' est protégé par la réservation à expiration (L3-06), pas par l'engagement",
        )

    # --- session/active-ride (L3-11, resynchronisation à la reconnexion) -----------------------

    def test_active_ride_missing_fields_is_validation_error(self):
        response = self._post("/session/active-ride", {}, secret=self._real_secret())

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "VALIDATION_ERROR")

    def test_active_ride_unknown_user_returns_nulls_not_an_error(self):
        response = self._post(
            "/session/active-ride",
            {"userId": "jamais-vu", "role": "client"},
            secret=self._real_secret(),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"rideId": None, "state": None})

    def test_active_ride_for_client_returns_the_one_active_ride(self):
        client = self._make_client_user("sub-active-ride-client")
        _driver_user, driver = self._make_driver_user("sub-active-ride-client-driver")
        ride = self.env["babana.ride"].sudo().action_request(self._base_vals(client.partner_id))
        ride.sudo().action_propose(by_partner=client.partner_id, driver=driver)

        response = self._post(
            "/session/active-ride",
            {"userId": client.babana_public_id, "role": "client"},
            secret=self._real_secret(),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"rideId": ride.public_id, "state": "proposed"})

    def test_active_ride_for_driver_returns_the_one_active_ride(self):
        client = self._make_client_user("sub-active-ride-driver-client")
        driver_user, driver = self._make_driver_user("sub-active-ride-driver")
        ride = self.env["babana.ride"].sudo().action_request(self._base_vals(client.partner_id))
        ride.sudo().action_propose(by_partner=client.partner_id, driver=driver)
        ride.sudo().action_accept(by_driver=driver)

        response = self._post(
            "/session/active-ride",
            {"userId": driver_user.babana_public_id, "role": "driver"},
            secret=self._real_secret(),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"rideId": ride.public_id, "state": "assigned"})

    def test_active_ride_none_active_returns_nulls(self):
        client = self._make_client_user("sub-active-ride-none")

        response = self._post(
            "/session/active-ride",
            {"userId": client.babana_public_id, "role": "client"},
            secret=self._real_secret(),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"rideId": None, "state": None})

    def test_active_ride_falls_back_to_last_known_ride_id_when_nothing_is_active(self):
        # Un client qui se reconnecte juste après que sa course est passée `completed` (hors de
        # CLIENT_ACTIVE_STATES, l'encaissement n'étant pas bloquant) doit apprendre ce vrai état
        # plutôt qu'un néant ambigu -- exactement le cas que lastKnownRideId cible.
        client = self._make_client_user("sub-active-ride-fallback")
        _driver_user, driver = self._make_driver_user("sub-active-ride-fallback-driver")
        ride = self.env["babana.ride"].sudo().action_request(self._base_vals(client.partner_id))
        ride.sudo().action_propose(by_partner=client.partner_id, driver=driver)
        ride.sudo().action_accept(by_driver=driver)
        ride.sudo().action_start(by_driver=driver)
        ride.sudo().action_complete(by_driver=driver, final_amount=1200)

        response = self._post(
            "/session/active-ride",
            {"userId": client.babana_public_id, "role": "client", "lastKnownRideId": ride.public_id},
            secret=self._real_secret(),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"rideId": ride.public_id, "state": "completed"})

    def test_active_ride_never_leaks_a_ride_that_does_not_belong_to_the_caller(self):
        # lastKnownRideId est un identifiant public, présentable par n'importe quel appelant : la
        # réponse doit toujours être filtrée par propriété, jamais renvoyée telle quelle.
        victim = self._make_client_user("sub-active-ride-owner")
        attacker = self._make_client_user("sub-active-ride-attacker")
        _driver_user, driver = self._make_driver_user("sub-active-ride-leak-driver")
        ride = self.env["babana.ride"].sudo().action_request(self._base_vals(victim.partner_id))
        ride.sudo().action_propose(by_partner=victim.partner_id, driver=driver)
        ride.sudo().action_accept(by_driver=driver)
        ride.sudo().action_start(by_driver=driver)
        ride.sudo().action_complete(by_driver=driver, final_amount=1200)

        response = self._post(
            "/session/active-ride",
            {"userId": attacker.babana_public_id, "role": "client", "lastKnownRideId": ride.public_id},
            secret=self._real_secret(),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"rideId": None, "state": None})

    def test_active_ride_missing_secret_is_unauthorized(self):
        response = self._post("/session/active-ride", {"userId": "irrelevant", "role": "client"})

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "UNAUTHORIZED")

    # --- drivers/proposal-push (L7-04, sens temps réel -> Odoo) -------------------------------
    #
    # L'ENVOI lui-même (fournisseur, marquage, nettoyage des jetons) est prouvé par test_push.py ;
    # `notify_users_async` y est prouvé ne programmer qu'un `cr.postcommit` (critères 3/5 de
    # L7-01). Ici on vérifie ce que CE contrôleur ajoute : résoudre le bon compte et composer un
    # message minimal, haute priorité, avec les bonnes données de routage -- en interceptant
    # `notify_users_async` à sa frontière (le postcommit + fil de fond d'un HttpCase n'est pas un
    # point d'observation fiable, même découpage que test_realtime_commit_hook.py).

    def test_proposal_push_composes_a_minimal_high_priority_notification_for_the_driver_account(self):
        driver_user, driver = self._make_driver_user("sub-proposal-push")

        with patch.object(push, "notify_users_async") as mock_notify:
            response = self._post(
                "/drivers/proposal-push",
                {
                    "driverId": driver.public_id,
                    "rideId": "11111111-1111-4111-8111-111111111111",
                    "expiresAt": "2026-09-05T10:00:30.000Z",
                },
                secret=self._real_secret(),
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True, "notified": True})

        self.assertEqual(mock_notify.call_count, 1)
        _env, users, message = mock_notify.call_args[0]
        # Le bon compte : celui du chauffeur visé.
        self.assertEqual(list(users.ids), driver_user.ids)
        # Haute priorité (réveille l'appareil) et une seule proposition à la fois (collapse).
        self.assertTrue(message.high_priority)
        self.assertEqual(message.collapse_key, "babana-proposal")
        # Données de routage : ouvrent l'écran de proposition, portent la véritable échéance.
        self.assertEqual(message.data["type"], "proposal")
        self.assertEqual(message.data["rideId"], "11111111-1111-4111-8111-111111111111")
        self.assertEqual(message.data["expiresAt"], "2026-09-05T10:00:30.000Z")
        # Contenu MINIMAL et sans donnée sensible : ni montant, ni point (écran verrouillé).
        blob = (message.title + " " + message.body).lower()
        self.assertNotIn("fcfa", blob)
        self.assertNotIn("4.0", blob)
        self.assertNotIn("9.7", blob)

    def test_proposal_push_does_not_send_when_there_is_no_account_to_reach(self):
        driver = self._make_driver("Sans compte")
        with patch.object(push, "notify_users_async") as mock_notify:
            response = self._post(
                "/drivers/proposal-push",
                {"driverId": driver.public_id, "rideId": "r", "expiresAt": "x"},
                secret=self._real_secret(),
            )
        self.assertEqual(response.json(), {"ok": True, "notified": False})
        mock_notify.assert_not_called()

    def test_proposal_push_unknown_driver_is_a_validation_error(self):
        response = self._post(
            "/drivers/proposal-push",
            {"driverId": "unknown", "rideId": "r", "expiresAt": "x"},
            secret=self._real_secret(),
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "VALIDATION_ERROR")

    def test_proposal_push_missing_secret_is_unauthorized(self):
        response = self._post(
            "/drivers/proposal-push", {"driverId": "x", "rideId": "r", "expiresAt": "x"}
        )
        self.assertEqual(response.status_code, 401)
