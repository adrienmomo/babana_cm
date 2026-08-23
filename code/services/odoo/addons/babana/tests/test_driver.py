# Tests de babana.driver (L1-03). Le critère d'acceptation 3 (rating_avg se recalcule à chaque
# nouvel avis) n'est pas testé ici : babana.rating (L4-09) n'existe pas encore, voir
# amoa/questions/L1-03.md -- un test qui simulerait ce recalcul ne prouverait rien.
from __future__ import annotations

import unittest.mock
from datetime import date

from odoo.exceptions import ValidationError
from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestBabanaDriver(TransactionCase):
    def _make_driver(self, **vals):
        employee = self.env["hr.employee"].create({"name": "Chauffeur de test"})
        return self.env["babana.driver"].create({"employee_id": employee.id, **vals})

    # --- Critère 1 : un chauffeur pending ne peut pas passer is_online à vrai --------------

    def test_pending_driver_cannot_go_online(self):
        driver = self._make_driver()
        self.assertEqual(driver.state, "pending")

        with self.assertRaises(ValidationError):
            driver.write({"is_online": True})

    def test_approved_driver_can_go_online(self):
        driver = self._make_driver(state="approved")
        driver.write({"is_online": True})
        self.assertTrue(driver.is_online)

    # --- Critère 2 : un chauffeur suspendu passe automatiquement hors ligne ----------------

    def test_suspending_an_online_driver_forces_it_offline(self):
        driver = self._make_driver(state="approved", is_online=True)
        self.assertTrue(driver.is_online)

        driver.write({"state": "suspended", "rejection_reason": "test"})

        self.assertFalse(driver.is_online)
        self.assertEqual(driver.state, "suspended")

    def test_suspending_wins_even_if_caller_also_requests_online(self):
        # Un appelant qui tenterait de repasser en ligne dans le même appel que la suspension
        # ne doit pas réussir à contourner la règle.
        driver = self._make_driver(state="approved")
        driver.write({"state": "suspended", "is_online": True})
        self.assertFalse(driver.is_online)

    # --- Critère 4 : une tentative d'écriture directe de cash_balance échoue ---------------

    def test_direct_write_of_cash_balance_fails(self):
        driver = self._make_driver()
        with self.assertRaises(Exception):
            driver.write({"cash_balance": 1000})

    def test_cash_balance_is_zero_without_any_movement(self):
        driver = self._make_driver()
        self.assertEqual(driver.cash_balance, 0.0)

    # --- D45 (amoa/questions/REPONSES-2026-08-29.md §1) : la borne du jour local se convertit
    # en UTC avant d'interroger create_date -- "ce qui se teste, c'est la frontière" (CLAUDE.md) :
    # `today` est figé par patch plutôt que laissé à l'horloge réelle, pour que le test échoue ou
    # réussisse de la même façon quelle que soit l'heure à laquelle il tourne. -------------------

    def _make_driver_with_tz(self, tz_name):
        user = self.env["res.users"].create(
            {
                "name": "Chauffeur fuseau",
                "login": f"driver-tz-test-{tz_name}@example.invalid",
                "tz": tz_name,
            }
        )
        employee = self.env["hr.employee"].create({"name": "Chauffeur fuseau"})
        return self.env["babana.driver"].create(
            {"employee_id": employee.id, "user_id": user.id}
        )

    def _make_collection(self, driver, *, create_date):
        movement = self.env["babana.cash.movement"].create(
            {"driver_id": driver.id, "movement_type": "collection", "amount": 500}
        )
        self.env.cr.execute(
            "UPDATE babana_cash_movement SET create_date = %s WHERE id = %s",
            (create_date, movement.id),
        )
        movement.invalidate_recordset(["create_date"])
        return movement

    def test_collected_today_includes_a_movement_just_after_local_midnight(self):
        # Africa/Douala est UTC+1 : minuit local le 24 août correspond à 23h00 UTC le 23 août.
        # Un mouvement encaissé à 23h30 UTC le 23 est donc déjà dans le jour local du 24 --
        # exactement le mouvement qui « disparaissait » entre 22h et minuit UTC avant correctif.
        driver = self._make_driver_with_tz("Africa/Douala")
        self._make_collection(driver, create_date="2026-08-23 23:30:00")

        with unittest.mock.patch(
            "odoo.fields.Date.context_today", return_value=date(2026, 8, 24)
        ):
            collected = driver.with_user(driver.user_id)._babana_cash_collected_today()

        self.assertEqual(collected, 500)

    def test_collected_today_excludes_a_movement_from_the_next_local_day(self):
        # Symétrique : un mouvement à 23h30 UTC le 24 est déjà dans le jour local du 25 --
        # sous l'ancien calcul (bornes naïves comparées telles quelles à create_date UTC), il
        # aurait été compté à tort dans la recette du 24.
        driver = self._make_driver_with_tz("Africa/Douala")
        self._make_collection(driver, create_date="2026-08-24 23:30:00")

        with unittest.mock.patch(
            "odoo.fields.Date.context_today", return_value=date(2026, 8, 24)
        ):
            collected = driver.with_user(driver.user_id)._babana_cash_collected_today()

        self.assertEqual(collected, 0)

    def test_collected_today_uses_the_driver_own_timezone_not_utc(self):
        # Un chauffeur sans fuseau explicite hériterait du défaut Odoo (Europe/Brussels, UTC+2
        # en août) -- même défaut, même sens d'erreur, écart plus grand. Prouve que le calcul
        # suit bien le fuseau du compte, pas une valeur fixe.
        driver = self._make_driver_with_tz("Europe/Brussels")
        # 22h30 UTC le 23 août == 00h30 CEST le 24 août -- dans le jour local du 24 pour
        # Bruxelles, mais pas encore pour Douala (qui n'y entre qu'à 23h00 UTC).
        self._make_collection(driver, create_date="2026-08-23 22:30:00")

        with unittest.mock.patch(
            "odoo.fields.Date.context_today", return_value=date(2026, 8, 24)
        ):
            collected = driver.with_user(driver.user_id)._babana_cash_collected_today()

        self.assertEqual(collected, 500)

    # --- Contraintes structurelles ---------------------------------------------------------

    def test_one_driver_per_employee(self):
        employee = self.env["hr.employee"].create({"name": "Chauffeur unique"})
        self.env["babana.driver"].create({"employee_id": employee.id})

        with self.assertRaises(Exception):
            self.env["babana.driver"].create({"employee_id": employee.id})

    # --- L1-03R2 : employee_id facultatif à pending, obligatoire dès approved ---------------

    def test_candidacy_can_be_created_without_employee(self):
        # Un sign-in chauffeur (L1-01) crée exactement ceci : aucune fiche RH avant l'approbation.
        driver = self.env["babana.driver"].create({})
        self.assertEqual(driver.state, "pending")
        self.assertFalse(driver.employee_id)

    def test_approving_without_employee_is_forbidden(self):
        driver = self.env["babana.driver"].create({})
        with self.assertRaises(ValidationError):
            driver.write({"state": "approved"})

    def test_approving_with_employee_succeeds(self):
        driver = self.env["babana.driver"].create({})
        employee = self.env["hr.employee"].create({"name": "Rattaché à l'approbation"})
        driver.write({"employee_id": employee.id, "state": "approved"})
        self.assertEqual(driver.state, "approved")

    # --- ride_count n'est plus un champ-pont (code/docs/bridge-fields.md) ------------------

    def test_ride_count_reflects_the_driver_rides(self):
        driver = self._make_driver()

        # L4-02 (fusionnée depuis) : create() n'accepte plus de state autre que 'requested' hors
        # du drapeau de contexte -- ce test ne prouve pas l'invariant 2, seulement ride_count,
        # d'où l'usage du drapeau plutôt qu'un aller-retour par les huit méthodes de transition.
        self.env["babana.ride"].with_context(babana_allow_state_write=True).create(
            {
                "client_id": self.env["res.partner"].create({"name": "Client"}).id,
                "driver_id": driver.id,
                "pickup_latitude": 4.05,
                "pickup_longitude": 9.70,
                "dropoff_latitude": 4.06,
                "dropoff_longitude": 9.77,
                "state": "settled",
            }
        )

        # ride_count n'a pas de @api.depends -- rien à déclarer entre deux modèles sans lien
        # direct -- et le cache Odoo ne se sait donc pas périmé par la création d'une course :
        # invalidation explicite avant lecture, comme le ferait une requête HTTP fraîche.
        driver.invalidate_recordset()
        self.assertEqual(driver.ride_count, 1)

    def test_cash_limit_reads_the_single_fleet_wide_config_parameter(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.cash_limit", "75000")
        driver = self._make_driver()
        self.assertEqual(driver.cash_limit, 75000.0)

    def test_cash_limit_is_the_same_for_every_driver(self):
        # D28 : pas de plafond par chauffeur -- un seul paramètre pour toute la flotte.
        self.env["ir.config_parameter"].sudo().set_param("babana.cash_limit", "30000")
        driver_a = self._make_driver()
        driver_b = self._make_driver()
        self.assertEqual(driver_a.cash_limit, driver_b.cash_limit)

    def test_direct_write_of_cash_limit_fails(self):
        driver = self._make_driver()
        with self.assertRaises(Exception):
            driver.write({"cash_limit": 1000})
