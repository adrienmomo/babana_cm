# Tests d'action_settle au niveau du modèle (L4-05) : ce que la couche HTTP (POST /rides/{id}/
# settle, testée dans test_ride_controller.py aux côtés du reste du cycle de vie) ne peut pas
# prouver facilement -- l'atomicité des trois effets, et leur intégration avec le plafond
# d'encaisse (L5-02). Pas besoin du vrai service temps réel ni de mock-google-identity ici :
# action_settle() s'appelle directement, comme test_ride_state_machine.py le fait déjà pour les
# sept autres transitions.
from __future__ import annotations

from unittest.mock import patch

from odoo.exceptions import UserError
from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestSettlement(TransactionCase):
    def _make_partner(self, name="Client"):
        return self.env["res.partner"].create({"name": name})

    def _make_driver(self, name="Chauffeur"):
        employee = self.env["hr.employee"].create({"name": name})
        return self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})

    def _ride_ready_to_settle(self, *, final_amount=1200):
        client = self._make_partner()
        driver = self._make_driver()
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
        ride.action_complete(
            by_driver=driver,
            actual_distance_km=5.0,
            actual_duration_minutes=15,
            final_amount=final_amount,
        )
        return ride, driver

    # --- Critère 1 : l'encaissement incrémente le compte courant du montant exact -------------

    def test_settle_creates_a_collection_movement_referencing_the_ride(self):
        ride, driver = self._ride_ready_to_settle(final_amount=1200)

        ride.action_settle(by_driver=driver, amount_collected=1200)

        movement = self.env["babana.cash.movement"].search([("ride_id", "=", ride.id)])
        self.assertEqual(len(movement), 1)
        self.assertEqual(movement.movement_type, "collection")
        self.assertEqual(movement.amount, 1200)
        self.assertEqual(movement.driver_id, driver)
        driver.invalidate_recordset()
        self.assertEqual(driver.cash_balance, 1200)

    # --- Critère 4 : le chauffeur ne peut pas saisir un montant différent ---------------------

    def test_settle_with_a_different_amount_is_rejected_and_nothing_happens(self):
        ride, driver = self._ride_ready_to_settle(final_amount=1200)

        with self.assertRaises(UserError):
            ride.action_settle(by_driver=driver, amount_collected=1000)

        self.assertEqual(ride.state, "completed")
        self.assertFalse(self.env["babana.cash.movement"].search([("ride_id", "=", ride.id)]))
        driver.invalidate_recordset()
        self.assertEqual(driver.cash_balance, 0)

    # --- Critère 2 : l'échec d'un effet annule tous les autres --------------------------------

    def test_settle_is_atomic_if_the_ledger_movement_fails(self):
        ride, driver = self._ride_ready_to_settle(final_amount=1200)
        CashMovement = type(self.env["babana.cash.movement"])

        with patch.object(CashMovement, "create", side_effect=UserError("boom")):
            with self.assertRaises(UserError):
                ride.action_settle(by_driver=driver, amount_collected=1200)

        # Le savepoint doit avoir tout défait : ni la transition, ni le mouvement (celui-ci a
        # échoué à se créer, mais le vérifier explicitement documente l'intention), ni le solde.
        self.assertEqual(
            ride.state, "completed", "aucun effet ne doit être appliqué si l'un d'eux échoue"
        )
        self.assertFalse(self.env["babana.cash.movement"].search([("ride_id", "=", ride.id)]))
        driver.invalidate_recordset()
        self.assertEqual(driver.cash_balance, 0)

    # --- Critère 5 de L5-02 : le franchissement met hors ligne dans la même transaction -------

    def test_settle_forces_the_driver_offline_when_crossing_the_cash_limit(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.cash_limit", "1000")
        ride, driver = self._ride_ready_to_settle(final_amount=1200)
        motorcycle = self.env["babana.motorcycle"].create({"license_plate": "LT-9999-ZZ"})
        motorcycle.write({"driver_id": driver.id})
        driver.write({"is_online": True})

        ride.action_settle(by_driver=driver, amount_collected=1200)

        driver.invalidate_recordset()
        self.assertEqual(driver.cash_balance, 1200)
        self.assertFalse(
            driver.is_online, "le plafond franchi (1200 >= 1000) doit mettre hors ligne"
        )

    def test_settle_does_not_go_offline_when_under_the_limit(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.cash_limit", "50000")
        ride, driver = self._ride_ready_to_settle(final_amount=1200)
        motorcycle = self.env["babana.motorcycle"].create({"license_plate": "LT-8888-ZZ"})
        motorcycle.write({"driver_id": driver.id})
        driver.write({"is_online": True})

        ride.action_settle(by_driver=driver, amount_collected=1200)

        driver.invalidate_recordset()
        self.assertTrue(driver.is_online, "bien en dessous du plafond, rien ne doit changer")

    # --- Critère 4 (L5-02) : une course en cours n'est jamais interrompue par le franchissement -

    def test_crossing_the_limit_does_not_touch_any_other_ride(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.cash_limit", "1000")
        settled_ride, driver = self._ride_ready_to_settle(final_amount=1200)
        # code/docs/odoo-pitfalls.md : un write() n'est pas toujours poussé en base avant qu'un
        # create() suivant ne heurte une contrainte SQL dans la même transaction --
        # babana_ride_one_active_per_driver (index unique partiel) ne verrait sinon pas encore
        # settled_ride passé à 'completed' au moment où other_ride s'insère en 'in_progress'.
        settled_ride.flush_recordset()
        motorcycle = self.env["babana.motorcycle"].create({"license_plate": "LT-7777-ZZ"})
        motorcycle.write({"driver_id": driver.id})
        driver.write({"is_online": True})

        # Une seconde course, déjà en cours pour le même chauffeur au moment du franchissement,
        # ne doit jamais être annulée ni transitionnée par _babana_apply_cash_limit -- rien dans
        # cette méthode ne touche babana.ride, vérifié ici plutôt que supposé.
        other_client = self._make_partner("Autre client")
        other_ride = (
            self.env["babana.ride"]
            .with_context(babana_allow_state_write=True)
            .create(
                {
                    "client_id": other_client.id,
                    "driver_id": driver.id,
                    "pickup_latitude": 4.05,
                    "pickup_longitude": 9.70,
                    "dropoff_latitude": 4.06,
                    "dropoff_longitude": 9.77,
                    "state": "in_progress",
                }
            )
        )

        settled_ride.action_settle(by_driver=driver, amount_collected=1200)

        self.assertEqual(other_ride.state, "in_progress")
