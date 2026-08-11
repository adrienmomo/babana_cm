# Tests de babana.assignment (L1-08).
from __future__ import annotations

from datetime import timedelta

import psycopg2
from odoo.exceptions import UserError, ValidationError
from odoo.fields import Datetime
from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestBabanaAssignment(TransactionCase):
    def _make_motorcycle(self, **vals):
        base = {"license_plate": f"LT-{self.env['babana.motorcycle'].search_count([]) + 1:04d}-BC"}
        base.update(vals)
        return self.env["babana.motorcycle"].create(base)

    def _make_driver(self, name="Chauffeur de test"):
        employee = self.env["hr.employee"].create({"name": name})
        return self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})

    # --- Critère 1 : affecter une moto déjà affectée échoue -----------------------------------

    def test_assigning_an_already_assigned_motorcycle_fails(self):
        moto = self._make_motorcycle()
        driver1 = self._make_driver("Premier")
        driver2 = self._make_driver("Second")
        self.env["babana.assignment"].create(
            {"motorcycle_id": moto.id, "driver_id": driver1.id}
        )

        with self.assertRaises(psycopg2.Error):
            with self.env.cr.savepoint():
                self.env["babana.assignment"].create(
                    {"motorcycle_id": moto.id, "driver_id": driver2.id}
                )

    # --- Critère 2 : affecter une seconde moto à un chauffeur échoue --------------------------

    def test_assigning_a_second_motorcycle_to_a_driver_fails(self):
        driver = self._make_driver()
        moto1 = self._make_motorcycle()
        moto2 = self._make_motorcycle()
        self.env["babana.assignment"].create(
            {"motorcycle_id": moto1.id, "driver_id": driver.id}
        )

        with self.assertRaises(psycopg2.Error):
            with self.env.cr.savepoint():
                self.env["babana.assignment"].create(
                    {"motorcycle_id": moto2.id, "driver_id": driver.id}
                )

    # --- Critère 3 : clore puis réaffecter fonctionne, les deux restent dans l'historique -----

    def test_closing_then_reassigning_keeps_both_in_history(self):
        moto = self._make_motorcycle()
        driver1 = self._make_driver("Premier")
        driver2 = self._make_driver("Second")

        first = self.env["babana.assignment"].create(
            {
                "motorcycle_id": moto.id,
                "driver_id": driver1.id,
                "start_date": Datetime.now() - timedelta(days=10),
            }
        )
        first.write({"end_date": Datetime.now() - timedelta(days=1)})
        second = self.env["babana.assignment"].create(
            {"motorcycle_id": moto.id, "driver_id": driver2.id}
        )

        self.assertTrue(first.exists())
        self.assertTrue(second.exists())
        self.assertEqual(
            self.env["babana.assignment"].search_count([("motorcycle_id", "=", moto.id)]), 2
        )
        self.assertEqual(moto.driver_id, driver2)

    # --- Critère 4 : une affectation close ne peut plus être modifiée -------------------------

    def test_closed_assignment_cannot_be_modified(self):
        moto = self._make_motorcycle()
        driver = self._make_driver()
        assignment = self.env["babana.assignment"].create(
            {"motorcycle_id": moto.id, "driver_id": driver.id}
        )
        assignment.write({"end_date": Datetime.now()})

        with self.assertRaises(UserError):
            assignment.write({"end_date": Datetime.now() + timedelta(days=1)})

    def test_closed_assignment_cannot_be_deleted(self):
        moto = self._make_motorcycle()
        driver = self._make_driver()
        assignment = self.env["babana.assignment"].create(
            {"motorcycle_id": moto.id, "driver_id": driver.id}
        )

        with self.assertRaises(UserError):
            assignment.unlink()

    # --- Périodes qui ne se chevauchent pas, au-delà de la seule affectation active -----------

    def test_overlapping_historical_periods_are_rejected(self):
        moto = self._make_motorcycle()
        driver1 = self._make_driver("Premier")
        driver2 = self._make_driver("Second")
        first = self.env["babana.assignment"].create(
            {
                "motorcycle_id": moto.id,
                "driver_id": driver1.id,
                "start_date": Datetime.now() - timedelta(days=10),
            }
        )
        first.write({"end_date": Datetime.now() - timedelta(days=5)})

        with self.assertRaises(ValidationError):
            with self.env.cr.savepoint():
                self.env["babana.assignment"].create(
                    {
                        "motorcycle_id": moto.id,
                        "driver_id": driver2.id,
                        "start_date": Datetime.now() - timedelta(days=7),
                        "end_date": Datetime.now() - timedelta(days=1),
                    }
                )

    # --- Effet de bord : la moto suit l'affectation active (L1-07) ----------------------------

    def test_active_assignment_sets_motorcycle_driver(self):
        moto = self._make_motorcycle()
        driver = self._make_driver()

        self.env["babana.assignment"].create(
            {"motorcycle_id": moto.id, "driver_id": driver.id}
        )

        self.assertEqual(moto.driver_id, driver)
        self.assertEqual(moto.state, "assigned")

    def test_closing_assignment_frees_the_motorcycle(self):
        moto = self._make_motorcycle()
        driver = self._make_driver()
        assignment = self.env["babana.assignment"].create(
            {"motorcycle_id": moto.id, "driver_id": driver.id}
        )

        assignment.write({"end_date": Datetime.now()})

        self.assertFalse(moto.driver_id)
        self.assertEqual(moto.state, "available")
