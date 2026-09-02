# Vues de suivi des courses (L9-03). Testent les champs / filtres sur lesquels les vues
# s'appuient, et l'attribut edit="false" du formulaire.
from __future__ import annotations

from odoo import fields
from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestRideBackoffice(TransactionCase):
    def _client(self):
        return self.env["res.partner"].create({"name": "Client suivi"})

    def _driver(self):
        employee = self.env["hr.employee"].create({"name": "Chauffeur suivi"})
        return self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})

    def _ride(self, **vals):
        base = {
            "client_id": self._client().id,
            "pickup_latitude": 4.0483,
            "pickup_longitude": 9.7043,
            "dropoff_latitude": 4.0611,
            "dropoff_longitude": 9.7679,
        }
        base.update(vals)
        return self.env["babana.ride"].with_context(babana_allow_state_write=True).create(base)

    # --- Critère 1 : le formulaire est en lecture seule, y compris en administrateur ---------

    def test_form_view_is_not_editable(self):
        arch = self.env.ref("babana.babana_ride_view_form").arch
        self.assertIn('edit="false"', arch)
        self.assertIn('create="false"', arch)

    # --- Critère 3 : la chronologie des transitions est complète ----------------------------

    def test_timeline_fields_are_all_on_the_form(self):
        arch = self.env.ref("babana.babana_ride_view_form").arch
        for field_name in (
            "requested_at",
            "proposed_at",
            "assigned_at",
            "started_at",
            "completed_at",
            "settled_at",
            "cancelled_at",
        ):
            self.assertIn(field_name, arch, f"{field_name} manquant de la chronologie")

    # --- Critère 4 : les filtres listés fonctionnent ---------------------------------------

    def test_state_and_zone_and_actor_filters(self):
        zone = self.env["babana.zone"].search([], limit=1)
        driver = self._driver()
        in_progress = self._ride(state="in_progress", driver_id=driver.id, pickup_zone_id=zone.id)
        cancelling_user = self.env.user
        cancelled = self._ride(
            state="cancelled",
            cancel_category="abandon_after_rejection",
            cancelled_by_user_id=cancelling_user.id,
        )

        Ride = self.env["babana.ride"]
        self.assertIn(
            in_progress,
            Ride.search([("state", "in", ("requested", "proposed", "assigned", "in_progress"))]),
        )
        self.assertIn(cancelled, Ride.search([("state", "=", "cancelled")]))
        if zone:
            self.assertIn(in_progress, Ride.search([("pickup_zone_id", "=", zone.id)]))
        self.assertIn(
            cancelled, Ride.search([("cancel_category", "=", "abandon_after_rejection")])
        )
        self.assertIn(
            cancelled, Ride.search([("cancelled_by_user_id", "=", cancelling_user.id)])
        )

    # --- Critère 5 : les courses à écart signalé sont filtrables ---------------------------

    def test_distance_deviation_flagged_is_filterable(self):
        flagged = self._ride(
            state="completed",
            trip_measured=True,
            reference_distance_km=2.0,
            actual_distance_km=25.0,
        )
        clean = self._ride(
            state="completed",
            trip_measured=True,
            reference_distance_km=3.0,
            actual_distance_km=3.1,
        )
        self.assertTrue(flagged.distance_deviation_flagged)
        self.assertFalse(clean.distance_deviation_flagged)
        found = self.env["babana.ride"].search([("distance_deviation_flagged", "=", True)])
        self.assertIn(flagged, found)
        self.assertNotIn(clean, found)

    # --- incidents liés visibles depuis la course ----------------------------------------

    def test_related_incidents_are_visible_from_the_ride(self):
        ride = self._ride(state="in_progress", driver_id=self._driver().id)
        incident = self.env["babana.incident"].create(
            {
                "ride_id": ride.id,
                "incident_type": "emergency",
                "trigger_actor": "client",
                "trigger_user_id": self.env.user.id,
                "triggered_at": fields.Datetime.now(),
                "latitude": 4.05,
                "longitude": 9.70,
            }
        )
        self.assertIn(incident, ride.incident_ids)
