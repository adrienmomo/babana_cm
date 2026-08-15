# Tests de la validation du dossier chauffeur (L1-06) : approbation, rejet, suspension,
# réactivation.
from __future__ import annotations

from odoo.exceptions import UserError
from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestDriverApproval(TransactionCase):
    def _make_candidate(self):
        # Une candidature comme L1-01R la crée réellement : pending, sans employee_id.
        return self.env["babana.driver"].create({})

    def _make_motorcycle(self):
        n = self.env["babana.motorcycle"].search_count([]) + 1
        return self.env["babana.motorcycle"].create({"license_plate": f"LT-{n:04d}-BC"})

    def _verify_required_documents(self, driver):
        for document_type in ("license", "id_card"):
            vals = {
                "driver_id": driver.id,
                "document_type": document_type,
                "storage_key": f"test/{document_type}.jpg",
                "verification_status": "verified",
            }
            if document_type == "license":
                vals["expires_on"] = "2030-01-01"
            self.env["babana.driver.document"].create(vals)

    def _make_approvable_candidate(self):
        driver = self._make_candidate()
        self._verify_required_documents(driver)
        self._make_motorcycle().write({"driver_id": driver.id})
        driver.invalidate_recordset()  # motorcycle_id est calculé -- voir test_driver.py
        return driver

    # --- Critère 1 : approuver sans document vérifié échoue -----------------------------------

    def test_approving_without_verified_documents_fails(self):
        driver = self._make_candidate()
        self._make_motorcycle().write({"driver_id": driver.id})
        driver.invalidate_recordset()

        with self.assertRaises(UserError):
            driver.action_approve(new_employee_name="Chauffeur")

    def test_approving_with_unverified_document_fails(self):
        driver = self._make_candidate()
        self.env["babana.driver.document"].create(
            {
                "driver_id": driver.id,
                "document_type": "license",
                "storage_key": "test/license.jpg",
                "expires_on": "2030-01-01",
                "verification_status": "pending",
            }
        )
        self.env["babana.driver.document"].create(
            {
                "driver_id": driver.id,
                "document_type": "id_card",
                "storage_key": "test/id.jpg",
                "verification_status": "verified",
            }
        )
        self._make_motorcycle().write({"driver_id": driver.id})
        driver.invalidate_recordset()

        with self.assertRaises(UserError):
            driver.action_approve(new_employee_name="Chauffeur")

    # --- Critère 1 bis : l'approbation crée ou rattache hr.employee, seule écriture dans hr ---

    def test_approving_with_new_employee_name_creates_exactly_one_employee(self):
        driver = self._make_approvable_candidate()
        employee_count_before = self.env["hr.employee"].search_count([])

        driver.action_approve(new_employee_name="Nouvelle recrue")

        self.assertEqual(self.env["hr.employee"].search_count([]), employee_count_before + 1)
        self.assertEqual(driver.state, "approved")
        self.assertEqual(driver.employee_id.name, "Nouvelle recrue")

    def test_approving_with_existing_employee_id_attaches_without_creating(self):
        driver = self._make_approvable_candidate()
        existing_employee = self.env["hr.employee"].create({"name": "Déjà embauché"})
        employee_count_before = self.env["hr.employee"].search_count([])

        driver.action_approve(employee_id=existing_employee.id)

        self.assertEqual(self.env["hr.employee"].search_count([]), employee_count_before)
        self.assertEqual(driver.employee_id, existing_employee)

    def test_approving_requires_exactly_one_of_employee_id_or_new_employee_name(self):
        driver = self._make_approvable_candidate()

        with self.assertRaises(UserError):
            driver.action_approve()

        existing_employee = self.env["hr.employee"].create({"name": "Les deux à la fois"})
        with self.assertRaises(UserError):
            driver.action_approve(employee_id=existing_employee.id, new_employee_name="Aussi")

    # --- Critère 1 ter : approuver sans fiche RH est structurellement impossible --------------

    def test_direct_write_to_approved_without_employee_is_forbidden(self):
        driver = self._make_approvable_candidate()
        with self.assertRaises(Exception):
            driver.write({"state": "approved"})

    # --- Critère 2 : approuver sans moto affectée échoue ---------------------------------------

    def test_approving_without_a_motorcycle_fails(self):
        driver = self._make_candidate()
        self._verify_required_documents(driver)

        with self.assertRaises(UserError):
            driver.action_approve(new_employee_name="Chauffeur")

    # --- Critère 3 : rejeter sans motif échoue --------------------------------------------------

    def test_rejecting_without_reason_fails(self):
        driver = self._make_candidate()
        with self.assertRaises(UserError):
            driver.action_reject(reason="")

    def test_rejecting_with_reason_succeeds(self):
        driver = self._make_candidate()
        driver.action_reject(reason="Permis illisible")
        self.assertEqual(driver.state, "rejected")
        self.assertEqual(driver.rejection_reason, "Permis illisible")

    # --- Critère 4 : suspendre passe hors ligne et révoque les jetons -------------------------

    def test_suspending_without_reason_fails(self):
        driver = self._make_approvable_candidate()
        driver.action_approve(new_employee_name="Chauffeur")
        with self.assertRaises(UserError):
            driver.action_suspend(reason="")

    def test_suspending_puts_driver_offline_and_revokes_tokens(self):
        driver = self._make_approvable_candidate()
        driver.action_approve(new_employee_name="Chauffeur")
        user = self.env["res.users"].sudo().create(
            {"name": "Compte chauffeur", "login": "driver-suspend-test@example.invalid"}
        )
        driver.write({"user_id": user.id})
        driver.write({"is_online": True})
        refresh_token = self.env["babana.token"]._issue_family(user)

        driver.action_suspend(reason="Comportement signalé")

        self.assertEqual(driver.state, "suspended")
        self.assertFalse(driver.is_online)
        with self.assertRaises(Exception):
            self.env["babana.token"]._rotate(refresh_token)

    # --- Critère 5 : suspendre un chauffeur en course ne l'interrompt pas ---------------------

    def test_suspending_a_driver_mid_ride_does_not_interrupt_it(self):
        driver = self._make_approvable_candidate()
        driver.action_approve(new_employee_name="Chauffeur")
        client = self.env["res.partner"].create({"name": "Client de test"})
        ride = self.env["babana.ride"].action_request(
            {
                "client_id": client.id,
                "pickup_latitude": 4.05,
                "pickup_longitude": 9.70,
                "dropoff_latitude": 4.06,
                "dropoff_longitude": 9.77,
            }
        )
        ride.action_propose(by_partner=client, driver=driver)
        ride.action_accept(by_driver=driver)
        ride.action_start(by_driver=driver)

        driver.action_suspend(reason="Suspension pendant une course")

        self.assertEqual(ride.state, "in_progress", "La course en cours n'est pas interrompue.")
        # Il ne peut simplement plus en accepter de nouvelle : le chauffeur n'est plus approuvé.
        other_ride = self.env["babana.ride"].action_request(
            {
                "client_id": self.env["res.partner"].create({"name": "Autre client"}).id,
                "pickup_latitude": 4.05,
                "pickup_longitude": 9.70,
                "dropoff_latitude": 4.06,
                "dropoff_longitude": 9.77,
            }
        )
        with self.assertRaises(UserError):
            other_ride.action_propose(by_partner=other_ride.client_id, driver=driver)

    # --- Critère 6 : réactivation depuis suspended uniquement ----------------------------------

    def test_reactivating_from_suspended_succeeds(self):
        driver = self._make_approvable_candidate()
        driver.action_approve(new_employee_name="Chauffeur")
        driver.action_suspend(reason="Motif")

        driver.action_reactivate()

        self.assertEqual(driver.state, "approved")

    def test_reactivating_from_a_state_other_than_suspended_fails(self):
        driver = self._make_candidate()
        with self.assertRaises(UserError):
            driver.action_reactivate()

    # --- Critère 6 : chaque changement d'état est journalisé, avec auteur et motif ------------

    def test_state_changes_are_logged_in_the_chatter(self):
        driver = self._make_approvable_candidate()
        before = len(driver.message_ids)

        driver.action_approve(new_employee_name="Chauffeur du fil")

        self.assertGreater(len(driver.message_ids), before)
        last_message = driver.message_ids.sorted("id", reverse=True)[0]
        self.assertIn("Chauffeur du fil", last_message.body)
        self.assertEqual(last_message.author_id, self.env.user.partner_id)
