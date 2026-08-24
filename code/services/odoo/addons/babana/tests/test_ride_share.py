# Tests du partage de trajet (L8-03). Même discipline que test_incident.py : ride construit
# directement à l'état voulu (babana_allow_state_write), jetons émis directement.
from __future__ import annotations

import json
import os

from odoo.tests.common import HttpCase, TransactionCase, tagged

from ..models.babana_ride_share import SHARE_LINK_GRACE_MINUTES_PARAM


@tagged("post_install", "-at_install")
class TestBabanaRideShareModel(TransactionCase):
    def _make_ride(self, **vals):
        client = self.env["res.partner"].create({"name": "Client de test"})
        employee = self.env["hr.employee"].create({"name": "Chauffeur de test"})
        driver = self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})
        base = {
            "client_id": client.id,
            "driver_id": driver.id,
            "state": "in_progress",
            "pickup_latitude": 4.0483,
            "pickup_longitude": 9.7043,
            "dropoff_latitude": 4.0611,
            "dropoff_longitude": 9.7679,
        }
        base.update(vals)
        return self.env["babana.ride"].with_context(babana_allow_state_write=True).create(base)

    # --- Critère 1 : jeton cryptographiquement aléatoire, sans lien avec l'identifiant de course

    def test_token_is_not_derived_from_ride_identifiers(self):
        ride = self._make_ride()
        share = self.env["babana.ride.share"].action_get_or_create(ride)

        self.assertNotIn(str(ride.id), share.token)
        self.assertNotIn(ride.public_id, share.token)
        self.assertGreaterEqual(len(share.token), 32)

    def test_two_tokens_are_never_equal(self):
        ride1 = self._make_ride()
        ride2 = self._make_ride()
        share1 = self.env["babana.ride.share"].action_get_or_create(ride1)
        share2 = self.env["babana.ride.share"].action_get_or_create(ride2)

        self.assertNotEqual(share1.token, share2.token)

    # --- get_or_create réutilise le jeton actif -------------------------------------------

    def test_get_or_create_reuses_the_active_token(self):
        ride = self._make_ride()
        first = self.env["babana.ride.share"].action_get_or_create(ride)
        second = self.env["babana.ride.share"].action_get_or_create(ride)

        self.assertEqual(first.id, second.id)
        self.assertEqual(first.token, second.token)

    # --- Critère 4 : révocation immédiate, idempotente -----------------------------------

    def test_revoke_is_immediate_and_idempotent(self):
        ride = self._make_ride()
        share = self.env["babana.ride.share"].action_get_or_create(ride)

        share.action_revoke()
        self.assertTrue(share.revoked_at)
        self.assertTrue(share._is_expired())

        # Une seconde révocation ne doit ni échouer ni changer l'horodatage.
        first_revoked_at = share.revoked_at
        share.action_revoke()
        self.assertEqual(share.revoked_at, first_revoked_at)

    def test_get_or_create_issues_a_new_token_after_revocation(self):
        ride = self._make_ride()
        first = self.env["babana.ride.share"].action_get_or_create(ride)
        first.action_revoke()

        second = self.env["babana.ride.share"].action_get_or_create(ride)

        self.assertNotEqual(first.id, second.id)
        self.assertNotEqual(first.token, second.token)

    # --- Critère 3 : expiration à la fin de la course plus un délai --------------------------

    def test_not_expired_while_ride_is_active(self):
        ride = self._make_ride(state="assigned")
        share = self.env["babana.ride.share"].action_get_or_create(ride)

        self.assertFalse(share._is_expired())

    def test_not_expired_right_after_completion_within_grace(self):
        from odoo import fields

        ride = self._make_ride(state="completed", completed_at=fields.Datetime.now())
        share = self.env["babana.ride.share"].action_get_or_create(ride)

        self.assertFalse(share._is_expired())

    def test_expired_once_grace_period_has_elapsed(self):
        from datetime import timedelta

        from odoo import fields

        self.env["ir.config_parameter"].sudo().set_param(SHARE_LINK_GRACE_MINUTES_PARAM, "30")
        ride = self._make_ride(
            state="completed", completed_at=fields.Datetime.now() - timedelta(minutes=31)
        )
        share = self.env["babana.ride.share"].action_get_or_create(ride)

        self.assertTrue(share._is_expired())

    def test_grace_period_is_configurable(self):
        from datetime import timedelta

        from odoo import fields

        self.env["ir.config_parameter"].sudo().set_param(SHARE_LINK_GRACE_MINUTES_PARAM, "5")
        ride = self._make_ride(
            state="completed", completed_at=fields.Datetime.now() - timedelta(minutes=10)
        )
        share = self.env["babana.ride.share"].action_get_or_create(ride)

        self.assertTrue(share._is_expired())

    def test_a_rejected_ride_never_expires_the_share_by_itself(self):
        # 'rejected' n'est pas terminal côté client (D11) -- une course refusée retourne à la
        # sélection, jamais à une fin de trajet.
        ride = self._make_ride(state="rejected", driver_id=False)
        share = self.env["babana.ride.share"].action_get_or_create(ride)

        self.assertFalse(share._is_expired())


@tagged("post_install", "-at_install")
class TestShareController(HttpCase):
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

    def _make_client_user(self, sub):
        from ..controllers.auth import _issue_access_token

        user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub=sub, email=f"{sub}@example.invalid", name="Client partage", role="client"
        )
        token, _ = _issue_access_token(user)
        return token, user

    def _make_driver_user(self, sub):
        from ..controllers.auth import _issue_access_token

        user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub=sub, email=f"{sub}@example.invalid", name="Chauffeur partage", role="driver"
        )
        driver = user._babana_driver()
        employee = self.env["hr.employee"].create({"name": "Chauffeur partage"})
        driver.sudo().write({"employee_id": employee.id, "state": "approved"})
        token, _ = _issue_access_token(user)
        return token, user, driver

    def _create_share(self, ride_public_id, token):
        # HttpCase.url_open ne pose POST que si `data` est non vide (odoo/tests/common.py) --
        # ces deux routes n'ont pas de corps à parser, mais un corps non vide est nécessaire
        # rien que pour obtenir la bonne méthode HTTP.
        return self.url_open(
            f"/api/v1/rides/{ride_public_id}/share",
            data=b"{}",
            headers={"Authorization": f"Bearer {token}"},
        )

    def _revoke_share(self, ride_public_id, token):
        return self.url_open(
            f"/api/v1/rides/{ride_public_id}/share/revoke",
            data=b"{}",
            headers={"Authorization": f"Bearer {token}"},
        )

    # --- Critère 5 : consultable sans compte ni application, un lien apex ---------------------

    def test_create_returns_an_apex_url(self):
        client_token, client_user = self._make_client_user("sub-share-client-1")
        _, _, driver = self._make_driver_user("sub-share-driver-1")
        ride = self._make_ride(client_user.partner_id, driver, state="assigned")

        response = self._create_share(ride.public_id, client_token)

        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertTrue(body["token"])
        self.assertTrue(body["url"].startswith("https://"))
        self.assertIn(f"/s/{body['token']}", body["url"])
        # Apex, jamais un sous-domaine : pas de "api." ni "admin." devant le domaine.
        self.assertNotRegex(body["url"], r"https://(api|admin)\.")

    def test_create_reuses_the_same_token_across_calls(self):
        client_token, client_user = self._make_client_user("sub-share-client-2")
        _, _, driver = self._make_driver_user("sub-share-driver-2")
        ride = self._make_ride(client_user.partner_id, driver, state="assigned")

        first = self._create_share(ride.public_id, client_token).json()
        second = self._create_share(ride.public_id, client_token).json()

        self.assertEqual(first["token"], second["token"])

    def test_only_the_client_can_create_a_share_not_the_driver(self):
        client_token, client_user = self._make_client_user("sub-share-client-3")
        driver_token, _, driver = self._make_driver_user("sub-share-driver-3")
        ride = self._make_ride(client_user.partner_id, driver, state="assigned")

        response = self._create_share(ride.public_id, driver_token)

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "RIDE_NOT_OWNED")

    def test_rejected_before_assignment(self):
        client_token, client_user = self._make_client_user("sub-share-client-4")
        ride = self._make_ride(client_user.partner_id, None, state="requested")

        response = self._create_share(ride.public_id, client_token)

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "RIDE_NOT_ACTIVE")

    # --- Critère 4 : révocation immédiate, depuis l'API ----------------------------------------

    def test_revoke_makes_the_share_inactive_immediately(self):
        client_token, client_user = self._make_client_user("sub-share-client-5")
        _, _, driver = self._make_driver_user("sub-share-driver-5")
        ride = self._make_ride(client_user.partner_id, driver, state="assigned")
        created = self._create_share(ride.public_id, client_token).json()

        response = self._revoke_share(ride.public_id, client_token)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"revoked": True})
        share = self.env["babana.ride.share"].sudo().search([("token", "=", created["token"])])
        self.assertTrue(share.revoked_at)

    def test_revoke_without_any_share_still_succeeds(self):
        client_token, client_user = self._make_client_user("sub-share-client-6")
        _, _, driver = self._make_driver_user("sub-share-driver-6")
        ride = self._make_ride(client_user.partner_id, driver, state="assigned")

        response = self._revoke_share(ride.public_id, client_token)

        self.assertEqual(response.status_code, 200)


@tagged("post_install", "-at_install")
class TestInternalResolveShareController(HttpCase):
    def _real_secret(self) -> str:
        return os.environ["REALTIME_SHARED_SECRET"]

    def _resolve(self, token, secret=None):
        headers = {"Content-Type": "application/json"}
        if secret is not None:
            headers["X-Realtime-Secret"] = secret
        return self.url_open(
            "/api/internal/share/resolve",
            data=json.dumps({"token": token}).encode(),
            headers=headers,
        )

    def _make_active_share(self):
        client = self.env["res.partner"].create({"name": "Client partage interne"})
        employee = self.env["hr.employee"].create({"name": "Amina Etoundi"})
        motorcycle = self.env["babana.motorcycle"].create(
            {"license_plate": "LT-9999-IS", "vehicle_class": "premium"}
        )
        driver = self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})
        motorcycle.write({"driver_id": driver.id})
        driver.invalidate_recordset()
        ride = (
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
        share = self.env["babana.ride.share"].action_get_or_create(ride)
        return share, ride

    def test_missing_secret_is_unauthorized(self):
        response = self._resolve("whatever")
        self.assertEqual(response.status_code, 401)

    def test_unknown_token_is_inactive(self):
        response = self._resolve("does-not-exist", secret=self._real_secret())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"active": False})

    # --- Critère 2 : liste blanche -- position (via le service temps réel), ETA, destination,
    # prénom, gamme. Jamais le nom du client, son téléphone, l'historique, le montant, ni
    # l'identité complète du chauffeur -------------------------------------------------------

    def test_active_share_exposes_only_the_whitelisted_fields(self):
        share, ride = self._make_active_share()

        response = self._resolve(share.token, secret=self._real_secret())

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(
            sorted(body.keys()),
            sorted(
                ["active", "rideId", "phase", "destination", "driverFirstName", "motorcycleClass", "expiresAt"]
            ),
        )
        self.assertTrue(body["active"])
        self.assertEqual(body["rideId"], ride.public_id)
        self.assertEqual(body["phase"], "course")
        self.assertEqual(body["destination"], {"latitude": 4.0611, "longitude": 9.7679})
        self.assertEqual(body["driverFirstName"], "Amina")
        self.assertEqual(body["motorcycleClass"], "premium")
        self.assertIsNone(body["expiresAt"])
        # Explicitement absent : nom complet du chauffeur, immatriculation, tout ce qui
        # concerne le client, le montant.
        dumped = json.dumps(body)
        self.assertNotIn("Etoundi", dumped)
        self.assertNotIn("9999", dumped)
        self.assertNotIn("Client partage interne", dumped)

    def test_revoked_share_is_inactive(self):
        share, _ = self._make_active_share()
        share.action_revoke()

        response = self._resolve(share.token, secret=self._real_secret())

        self.assertEqual(response.json(), {"active": False})
