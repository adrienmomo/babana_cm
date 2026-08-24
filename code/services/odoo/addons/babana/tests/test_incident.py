# Tests du bouton d'urgence (L8-04). Ride construit directement à l'état voulu via le drapeau de
# contexte babana_allow_state_write (même patron que test_ride_model.py) -- ces tests ne portent
# pas sur la machine à états elle-même (test_ride_state_machine.py le fait), seulement sur les
# conditions et effets propres à l'incident. Jetons émis directement (_issue_access_token, même
# patron que test_driver_cash_controller.py) : aucune interaction chauffeur-temps-réel n'est en
# jeu, inutile de payer le coût du parcours WebSocket complet de test_ride_controller.py.
from __future__ import annotations

import json
import uuid

from odoo.tests.common import HttpCase, TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestBabanaIncidentModel(TransactionCase):
    def _make_client(self, phone=None):
        return self.env["res.partner"].create(
            {"name": "Client de test", "babana_emergency_contact": phone}
        )

    def _make_driver(self):
        employee = self.env["hr.employee"].create({"name": "Chauffeur de test"})
        driver = self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})
        return driver

    def _make_ride(self, client, driver):
        return (
            self.env["babana.ride"]
            .with_context(babana_allow_state_write=True)
            .create(
                {
                    "client_id": client.id,
                    "driver_id": driver.id,
                    "state": "in_progress",
                    "pickup_latitude": 4.0483,
                    "pickup_longitude": 9.7043,
                    "dropoff_latitude": 4.0611,
                    "dropoff_longitude": 9.7679,
                }
            )
        )

    def _make_incident(self, ride, actor_user):
        return self.env["babana.incident"].create(
            {
                "ride_id": ride.id,
                "trigger_actor": "client",
                "trigger_user_id": actor_user.id,
                "latitude": 4.05,
                "longitude": 9.70,
                "triggered_at": "2026-08-24 21:00:00",
            }
        )

    # --- Critère 4 : le contact d'urgence est notifié s'il existe -----------------------------

    def test_notifies_when_emergency_contact_is_set(self):
        client = self._make_client(phone="+237600000000")
        driver = self._make_driver()
        ride = self._make_ride(client, driver)
        admin = self.env.ref("base.user_admin")

        incident = self._make_incident(ride, admin)

        self.assertTrue(incident.emergency_contact_notified)
        self.assertEqual(incident.emergency_contact_phone, "+237600000000")

    def test_does_not_notify_when_no_emergency_contact(self):
        client = self._make_client(phone=None)
        driver = self._make_driver()
        ride = self._make_ride(client, driver)
        admin = self.env.ref("base.user_admin")

        incident = self._make_incident(ride, admin)

        self.assertFalse(incident.emergency_contact_notified)
        self.assertFalse(incident.emergency_contact_phone)

    def test_emergency_contact_is_snapshotted_not_relinked(self):
        # Une correction ultérieure de la fiche client ne doit pas réécrire l'histoire d'un
        # incident déjà enregistré.
        client = self._make_client(phone="+237600000000")
        driver = self._make_driver()
        ride = self._make_ride(client, driver)
        admin = self.env.ref("base.user_admin")
        incident = self._make_incident(ride, admin)

        client.write({"babana_emergency_contact": "+237611111111"})

        self.assertEqual(incident.emergency_contact_phone, "+237600000000")

    # --- Critère 5 : la course n'est pas interrompue automatiquement --------------------------

    def test_creating_an_incident_never_touches_ride_state(self):
        client = self._make_client()
        driver = self._make_driver()
        ride = self._make_ride(client, driver)

        self._make_incident(ride, self.env.ref("base.user_admin"))

        self.assertEqual(ride.state, "in_progress")

    # --- Traitement back-office ------------------------------------------------------------

    def test_acknowledge_then_close_records_the_handler(self):
        client = self._make_client()
        driver = self._make_driver()
        ride = self._make_ride(client, driver)
        supervisor = self.env.ref("base.user_admin")
        incident = self._make_incident(ride, supervisor)

        incident.action_acknowledge(user=supervisor)
        self.assertEqual(incident.status, "acknowledged")
        self.assertEqual(incident.handled_by_id, supervisor)

        incident.action_close(user=supervisor, notes="Fausse alerte, confirmé par téléphone.")
        self.assertEqual(incident.status, "closed")
        self.assertEqual(incident.resolution_notes, "Fausse alerte, confirmé par téléphone.")


@tagged("post_install", "-at_install")
class TestIncidentController(HttpCase):
    def _make_ride(self, client_partner, driver, state="in_progress"):
        return (
            self.env["babana.ride"]
            .with_context(babana_allow_state_write=True)
            .create(
                {
                    "client_id": client_partner.id,
                    "driver_id": driver.id if driver else False,
                    "state": state,
                    "pickup_latitude": 4.0483,
                    "pickup_longitude": 9.7043,
                    "dropoff_latitude": 4.0611,
                    "dropoff_longitude": 9.7679,
                }
            )
        )

    def _make_client_user(self, sub="sub-incident-client"):
        from ..controllers.auth import _issue_access_token

        user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub=sub, email=f"{sub}@example.invalid", name="Client incident", role="client"
        )
        token, _ = _issue_access_token(user)
        return token, user

    def _make_driver_user(self, sub="sub-incident-driver"):
        from ..controllers.auth import _issue_access_token

        user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub=sub, email=f"{sub}@example.invalid", name="Chauffeur incident", role="driver"
        )
        driver = user._babana_driver()
        employee = self.env["hr.employee"].create({"name": "Chauffeur incident"})
        driver.sudo().write({"employee_id": employee.id, "state": "approved"})
        token, _ = _issue_access_token(user)
        return token, user, driver

    def _post(self, ride_public_id, token, body):
        return self.url_open(
            f"/api/v1/rides/{ride_public_id}/incidents",
            data=json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )

    _BODY = {"latitude": 4.05, "longitude": 9.70, "triggeredAt": "2026-08-24T21:00:00.000Z"}

    # --- Critère 1/2 : déclenchable par le client, enregistre la position exacte --------------

    def test_client_can_trigger_during_an_active_ride(self):
        client_token, client_user = self._make_client_user()
        _, _, driver = self._make_driver_user()
        ride = self._make_ride(client_user.partner_id, driver, state="assigned")

        response = self._post(ride.public_id, client_token, self._BODY)

        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertEqual(body["status"], "open")
        self.assertEqual(body["position"], {"latitude": 4.05, "longitude": 9.70})

        incident = self.env["babana.incident"].sudo().search([("ride_id", "=", ride.id)])
        self.assertEqual(len(incident), 1)
        self.assertEqual(incident.trigger_actor, "client")

    # --- Déclenchable par le chauffeur, symétrique --------------------------------------------

    def test_driver_can_trigger_during_an_active_ride(self):
        client_token, client_user = self._make_client_user(sub="sub-incident-client-2")
        driver_token, driver_user, driver = self._make_driver_user(sub="sub-incident-driver-2")
        ride = self._make_ride(client_user.partner_id, driver, state="in_progress")

        response = self._post(ride.public_id, driver_token, self._BODY)

        self.assertEqual(response.status_code, 201)
        incident = self.env["babana.incident"].sudo().search([("ride_id", "=", ride.id)])
        self.assertEqual(incident.trigger_actor, "driver")

    # --- Ni avant l'affectation, ni après la fin -----------------------------------------------

    def test_rejected_before_assignment(self):
        client_token, client_user = self._make_client_user(sub="sub-incident-client-3")
        ride = self._make_ride(client_user.partner_id, None, state="requested")

        response = self._post(ride.public_id, client_token, self._BODY)

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "RIDE_NOT_ACTIVE")

    def test_rejected_after_settlement(self):
        client_token, client_user = self._make_client_user(sub="sub-incident-client-4")
        _, _, driver = self._make_driver_user(sub="sub-incident-driver-4")
        ride = self._make_ride(client_user.partner_id, driver, state="settled")

        response = self._post(ride.public_id, client_token, self._BODY)

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "RIDE_NOT_ACTIVE")

    # --- Un tiers à la course est rejeté --------------------------------------------------------

    def test_rejected_for_a_ride_that_is_not_the_caller_s(self):
        _, someone_elses_client = self._make_client_user(sub="sub-incident-client-owner")
        _, driver_user_x, driver_x = self._make_driver_user(sub="sub-incident-driver-owner")
        ride = self._make_ride(someone_elses_client.partner_id, driver_x, state="assigned")

        outsider_token, _ = self._make_client_user(sub="sub-incident-client-outsider")
        response = self._post(ride.public_id, outsider_token, self._BODY)

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "RIDE_NOT_OWNED")

    # --- Validation ------------------------------------------------------------------------

    def test_rejected_without_position(self):
        client_token, client_user = self._make_client_user(sub="sub-incident-client-5")
        _, _, driver = self._make_driver_user(sub="sub-incident-driver-5")
        ride = self._make_ride(client_user.partner_id, driver, state="assigned")

        response = self._post(
            ride.public_id, client_token, {"triggeredAt": "2026-08-24T21:00:00.000Z"}
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "VALIDATION_ERROR")

    # --- Critère 6 : rejeu hors connexion, même Idempotency-Key ne crée qu'un seul incident ---

    def test_replaying_with_the_same_idempotency_key_creates_only_one_incident(self):
        client_token, client_user = self._make_client_user(sub="sub-incident-client-6")
        _, _, driver = self._make_driver_user(sub="sub-incident-driver-6")
        ride = self._make_ride(client_user.partner_id, driver, state="assigned")

        key = str(uuid.uuid4())
        headers = {
            "Authorization": f"Bearer {client_token}",
            "Content-Type": "application/json",
            "Idempotency-Key": key,
        }
        first = self.url_open(
            f"/api/v1/rides/{ride.public_id}/incidents",
            data=json.dumps(self._BODY).encode(),
            headers=headers,
        )
        second = self.url_open(
            f"/api/v1/rides/{ride.public_id}/incidents",
            data=json.dumps(self._BODY).encode(),
            headers=headers,
        )

        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)
        self.assertEqual(first.json()["id"], second.json()["id"])
        count = self.env["babana.incident"].sudo().search_count([("ride_id", "=", ride.id)])
        self.assertEqual(count, 1)
