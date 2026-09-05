# Tests de babana.fare.rule (L2-01).
from __future__ import annotations

from datetime import datetime, time, timedelta

import pytz

from odoo.exceptions import UserError
from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestBabanaFareRule(TransactionCase):
    def _make_rule(self, **vals):
        base = {
            "name": "Règle de test",
            "base_fare": 200.0,
            "price_per_km": 100.0,
            "minimum_fare": 300.0,
        }
        base.update(vals)
        return self.env["babana.fare.rule"].create(base)

    # --- Critère 1 : aucun champ de prix à la minute n'existe ---------------------------------

    def test_no_per_minute_price_field_exists(self):
        field_names = self.env["babana.fare.rule"]._fields.keys()
        self.assertFalse(
            any("minute" in name for name in field_names),
            "D15 : aucun prix à la minute, même en champ inutilisé.",
        )

    # --- Critère 2 : sélection déterministe entre règles concurrentes -------------------------

    def test_higher_priority_rule_wins_when_rules_overlap(self):
        self._make_rule(name="Basse priorité", priority=0)
        high = self._make_rule(name="Haute priorité", priority=10)

        found = self.env["babana.fare.rule"]._find_applicable_rule(at_datetime=datetime.now())

        self.assertEqual(found, high)

    def test_most_recently_created_wins_at_equal_priority(self):
        self._make_rule(name="Ancienne", priority=5)
        newest = self._make_rule(name="Récente", priority=5)

        found = self.env["babana.fare.rule"]._find_applicable_rule(at_datetime=datetime.now())

        self.assertEqual(found, newest)

    def test_vehicle_class_specific_rule_wins_over_generic_at_equal_priority(self):
        # Une règle plus spécifique ne gagne pas automatiquement : c'est la priorité qui
        # tranche, pas la spécificité -- documenté ici pour ne pas le supposer implicitement.
        generic = self._make_rule(name="Toutes gammes", priority=5)
        self._make_rule(name="Premium seulement", vehicle_class="premium", priority=5)

        found = self.env["babana.fare.rule"]._find_applicable_rule(
            vehicle_class="standard", at_datetime=datetime.now()
        )

        self.assertEqual(found, generic)

    # --- Critère 3 : il existe toujours au moins une règle applicable -------------------------

    def test_default_fallback_rule_is_always_applicable(self):
        # La règle de repli de data/fare_rule_default.xml doit être trouvée même sans aucune
        # autre règle explicitement créée dans ce test.
        found = self.env["babana.fare.rule"]._find_applicable_rule(at_datetime=datetime.now())
        self.assertTrue(found)

    def test_no_applicable_rule_raises_instead_of_computing_silently(self):
        self.env["babana.fare.rule"].search([]).unlink()
        with self.assertRaises(UserError):
            self.env["babana.fare.rule"]._find_applicable_rule(at_datetime=datetime.now())

    def test_time_window_restricts_applicability(self):
        rule = self._make_rule(
            name="Heure de pointe", time_start=7.0, time_end=9.0, priority=20
        )
        # Date du jour, pas une date écrite en dur (bombe à retardement -- constaté le 14 août
        # sur cette règle même : active_from défaut à aujourd'hui, une date fixe finit toujours
        # par tomber avant elle une fois le calendrier avancé). Seule l'heure compte ici.
        today = datetime.now().date()
        peak = datetime(today.year, today.month, today.day, 8, 0)
        off_peak = datetime(today.year, today.month, today.day, 14, 0)

        self.assertEqual(
            self.env["babana.fare.rule"]._find_applicable_rule(at_datetime=peak), rule
        )
        self.assertNotEqual(
            self.env["babana.fare.rule"]._find_applicable_rule(at_datetime=off_peak), rule
        )

    def test_time_window_is_matched_in_operating_local_time_not_utc(self):
        # L9-04 (nuit J34) : `at_datetime` arrive en UTC naïf (fields.Datetime.now(), comme
        # controllers/quote.py en produit), mais time_start/time_end sont saisis par le
        # superviseur en heure locale de Douala (UTC+1, D45) -- documenté sur le champ
        # time_start. Sans conversion, une plage 20h-21h locale ne matchait jamais un
        # at_datetime UTC correspondant à 20h30 locale (19h30 UTC), puisque 19.5 tombe hors de
        # [20, 21] : c'est le défaut que ce test prouve corrigé.
        rule = self._make_rule(name="Soirée", time_start=20.0, time_end=21.0, priority=20)
        today = datetime.now().date()
        at_1930_utc = datetime(today.year, today.month, today.day, 19, 30)

        found = self.env["babana.fare.rule"]._find_applicable_rule(at_datetime=at_1930_utc)

        self.assertEqual(
            found,
            rule,
            "19h30 UTC == 20h30 heure locale de Douala (UTC+1) : dans la plage 20h-21h locale, "
            "donc la règle doit s'appliquer même si 19h30 est hors de [20, 21] en UTC brut.",
        )

    def test_weekday_mask_restricts_applicability(self):
        monday_only = 0b0000001  # bit 0
        rule = self._make_rule(name="Lundi seulement", weekday_mask=monday_only, priority=20)

        # D76 (amoa/01-architecture.md §9 undecies) : ce test construisait un « lundi » depuis
        # l'heure courante (`datetime.now()`) sans jamais fixer l'heure du jour. Entre 23h et
        # minuit UTC, `_find_applicable_rule` convertit cet instant vers l'heure locale
        # d'exploitation (Africa/Douala, UTC+1) AVANT de lire le jour de semaine -- la conversion
        # fait alors franchir minuit, et le « lundi » du test devient un mardi côté code, sans
        # qu'aucune ligne de ce test ne le sache. Un test ne dépend de rien qu'il n'ait posé
        # lui-même : fixer midi en heure locale, plutôt que l'heure courante, élimine la fenêtre
        # de bascule entièrement, au lieu de la déplacer sur un autre quart d'heure de la
        # journée. La DATE reste calculée depuis aujourd'hui (calculée dans le même fuseau que le
        # code sous test, pas supposée UTC) : active_from de la règle vaut fields.Date.today() à
        # la création, une date de test trop ancienne la rendrait elle-même non candidate.
        operating_tz = self.env["babana.fare.rule"]._operating_timezone()
        local_now = datetime.now(operating_tz)
        a_monday_date = local_now.date() + timedelta(days=(0 - local_now.weekday()) % 7)
        local_monday_noon = operating_tz.localize(datetime.combine(a_monday_date, time(12, 0)))
        local_tuesday_noon = local_monday_noon + timedelta(days=1)

        a_monday = local_monday_noon.astimezone(pytz.UTC).replace(tzinfo=None)
        a_tuesday = local_tuesday_noon.astimezone(pytz.UTC).replace(tzinfo=None)

        self.assertEqual(
            self.env["babana.fare.rule"]._find_applicable_rule(at_datetime=a_monday), rule
        )
        self.assertNotEqual(
            self.env["babana.fare.rule"]._find_applicable_rule(at_datetime=a_tuesday), rule
        )

    # --- Critère 4 : modifier une règle déjà UTILISÉE crée une version, ne la modifie pas -----

    def _make_ride_using(self, rule):
        # L4-01R2 (correction du 13 août) : c'est cette référence, pas seulement le gel par
        # valeur, qui détermine si une règle a "servi" au sens du critère 4.
        client = self.env["res.partner"].create({"name": "Client de test"})
        return (
            self.env["babana.ride"]
            .with_context(babana_allow_state_write=True)
            .create(
                {
                    "client_id": client.id,
                    "pickup_latitude": 4.05,
                    "pickup_longitude": 9.70,
                    "dropoff_latitude": 4.06,
                    "dropoff_longitude": 9.77,
                    "fare_rule_id": rule.id,
                }
            )
        )

    def test_direct_write_of_a_pricing_field_on_a_used_rule_is_rejected(self):
        rule = self._make_rule()
        self._make_ride_using(rule)

        with self.assertRaises(UserError):
            rule.write({"base_fare": 999.0})

    # --- Critère 4 bis : une règle JAMAIS utilisée reste librement modifiable -----------------

    def test_direct_write_of_a_pricing_field_on_an_unused_rule_is_allowed(self):
        rule = self._make_rule(base_fare=200.0)

        rule.write({"base_fare": 250.0})

        self.assertEqual(rule.base_fare, 250.0)

    def test_new_version_closes_the_old_rule_and_creates_another(self):
        rule = self._make_rule(base_fare=200.0)

        new_rule = rule.new_version({"base_fare": 250.0})

        self.assertEqual(rule.base_fare, 200.0, "L'ancienne règle n'a pas changé de valeur.")
        self.assertTrue(rule.active_to, "L'ancienne règle est close.")
        self.assertEqual(new_rule.base_fare, 250.0)
        self.assertFalse(new_rule.active_to)

    # --- Critère 5 : minimum_fare est appliqué (intégration avec le moteur, L2-03) ------------

    def test_minimum_fare_field_is_never_negative(self):
        with self.assertRaises(Exception):
            self._make_rule(minimum_fare=-1.0)
