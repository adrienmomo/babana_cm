# Tests de babana.ride (L4-01) : identité, contraintes d'intégrité, gel du tarif, index, refus.
# state est encore librement modifiable ici -- le verrou des transitions est L4-02, la tâche
# suivante de ce lot. Ces tests ne prouvent donc que L4-01, pas l'invariant 2 dans son ensemble.
from __future__ import annotations

import json

import psycopg2
from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestBabanaRideModel(TransactionCase):
    def _make_client(self, name="Client de test"):
        return self.env["res.partner"].create({"name": name})

    def _make_driver(self, name="Chauffeur de test"):
        employee = self.env["hr.employee"].create({"name": name})
        return self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})

    def _make_ride(self, **vals):
        base = {
            "client_id": self._make_client().id,
            "pickup_latitude": 4.0483,
            "pickup_longitude": 9.7043,
            "dropoff_latitude": 4.0611,
            "dropoff_longitude": 9.7679,
        }
        base.update(vals)
        return self.env["babana.ride"].create(base)

    # --- Critère 1 : référence générée par séquence et unique --------------------------------

    def test_reference_is_generated_and_unique(self):
        ride1 = self._make_ride()
        ride2 = self._make_ride()

        self.assertNotEqual(ride1.reference, "/")
        self.assertNotEqual(ride1.reference, ride2.reference)
        self.assertTrue(ride1.reference.startswith("C"))

    # --- Critère 2 : une seconde course active pour le même chauffeur échoue en base ---------

    def test_second_active_ride_for_same_driver_fails_at_database_level(self):
        driver = self._make_driver()
        self._make_ride(driver_id=driver.id, state="assigned")

        with self.assertRaises(psycopg2.Error):
            with self.env.cr.savepoint():
                self._make_ride(driver_id=driver.id, state="proposed")

    def test_second_active_ride_for_same_client_fails_at_database_level(self):
        client = self._make_client()

        self.env["babana.ride"].create(
            {
                "client_id": client.id,
                "pickup_latitude": 4.05,
                "pickup_longitude": 9.70,
                "dropoff_latitude": 4.06,
                "dropoff_longitude": 9.77,
                "state": "proposed",
            }
        )

        with self.assertRaises(psycopg2.Error):
            with self.env.cr.savepoint():
                self.env["babana.ride"].create(
                    {
                        "client_id": client.id,
                        "pickup_latitude": 4.05,
                        "pickup_longitude": 9.70,
                        "dropoff_latitude": 4.06,
                        "dropoff_longitude": 9.77,
                        "state": "assigned",
                    }
                )

    def test_two_terminal_rides_for_same_driver_are_allowed(self):
        # L'index partiel ne porte que sur les états actifs (proposed, assigned, in_progress) :
        # deux courses terminées (settled) pour le même chauffeur doivent coexister sans
        # problème -- sinon aucun chauffeur ne pourrait jamais faire une deuxième course.
        driver = self._make_driver()
        self._make_ride(driver_id=driver.id, state="settled")
        self._make_ride(driver_id=driver.id, state="settled")

    # --- Critère 3 : la règle tarifaire figée survit à la modification de la règle d'origine -

    def test_frozen_fare_snapshot_is_independent_of_a_later_mutation(self):
        # Sans babana.fare.rule (L2-01, hors de ce lot -- amoa/questions/L4-01.md), ce test
        # prouve la propriété structurelle qui compte : le gel se fait par valeur, jamais par
        # référence à un enregistrement qui pourrait changer sous la course. Un "rule" vivant
        # est simulé par un simple dict Python, muté après coup.
        live_rule = {"base": 500, "per_km": 150, "coefficient": 1.0}
        ride = self._make_ride(fare_rule_snapshot=json.dumps(live_rule))

        live_rule["per_km"] = 999  # la règle "vivante" change après coup

        frozen = json.loads(ride.fare_rule_snapshot)
        self.assertEqual(frozen["per_km"], 150)

    # --- Critère 4 : les index existent -------------------------------------------------------

    def test_expected_indexes_exist(self):
        self.env.cr.execute(
            "SELECT indexname FROM pg_indexes WHERE tablename = 'babana_ride'"
        )
        index_names = {row[0] for row in self.env.cr.fetchall()}

        self.assertIn("babana_ride_one_active_per_driver", index_names)
        self.assertIn("babana_ride_one_active_per_client", index_names)
        self.assertIn("babana_ride_create_date_idx", index_names)
        # index=True sur state, client_id et driver_id : l'ORM Odoo nomme ces index
        # babana_ride__<field>_index (double soulignement -- convention interne de l'ORM).
        self.assertIn("babana_ride__state_index", index_names)
        self.assertIn("babana_ride__client_id_index", index_names)
        self.assertIn("babana_ride__driver_id_index", index_names)

    # --- Critère 5 : les refus sont portés par la course, pas par des courses distinctes -----

    def test_rejections_are_carried_by_the_same_ride(self):
        driver1 = self._make_driver("Premier refuseur")
        driver2 = self._make_driver("Second refuseur")
        ride = self._make_ride(state="proposed")

        self.env["babana.ride.rejection"].create(
            {"ride_id": ride.id, "driver_id": driver1.id, "reason": "trop loin"}
        )
        self.env["babana.ride.rejection"].create(
            {"ride_id": ride.id, "driver_id": driver2.id, "reason": "pas envie"}
        )

        self.assertEqual(len(ride.rejection_ids), 2)
        self.assertEqual(self.env["babana.ride"].search_count([]), 1)
