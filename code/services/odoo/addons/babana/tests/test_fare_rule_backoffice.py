# Vues tarification back-office (L9-04). Testent les champs et méthodes sur lesquels les vues
# s'appuient (recouvrement, verrouillage par usage, assistant de nouvelle version), pas leur
# rendu -- même approche que test_motorcycle_backoffice.py (L9-02).
from __future__ import annotations

from datetime import date, timedelta

from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestFareRuleBackoffice(TransactionCase):
    def _make_rule(self, **vals):
        base = {
            "name": "Règle de test",
            "base_fare": 200.0,
            "price_per_km": 100.0,
            "minimum_fare": 300.0,
        }
        base.update(vals)
        return self.env["babana.fare.rule"].create(base)

    # --- Critère 1 : le recouvrement de deux règles produit un avertissement -----------------

    def test_two_overlapping_time_windows_are_flagged(self):
        morning = self._make_rule(name="Matin", time_start=7.0, time_end=10.0, priority=10)
        overlapping = self._make_rule(
            name="Chevauche le matin", time_start=8.0, time_end=11.0, priority=10
        )

        self.assertTrue(morning.has_overlap)
        self.assertTrue(overlapping.has_overlap)
        self.assertIn(overlapping, morning.overlap_rule_ids)
        self.assertIn(morning, overlapping.overlap_rule_ids)

    def test_disjoint_time_windows_are_not_flagged_against_each_other(self):
        morning = self._make_rule(name="Matin", time_start=7.0, time_end=9.0, priority=10)
        afternoon = self._make_rule(name="Après-midi", time_start=14.0, time_end=16.0, priority=10)

        self.assertFalse(afternoon in morning.overlap_rule_ids)
        self.assertFalse(morning in afternoon.overlap_rule_ids)

    def test_generic_fallback_rule_does_not_flag_every_other_rule(self):
        # data/fare_rule_default.xml pose une règle sans aucune restriction -- toute autre règle
        # la recouvre par construction (repli assumé). La signaler serait du bruit sur chaque
        # règle jamais créée (voir babana_fare_rule.py::_is_generic).
        fallback = self.env.ref("babana.babana_fare_rule_default")
        specific = self._make_rule(name="Spécifique", time_start=7.0, time_end=9.0)

        self.assertFalse(specific.has_overlap)
        self.assertNotIn(fallback, specific.overlap_rule_ids)

    def test_rule_closed_in_the_past_is_never_flagged(self):
        # active_to == aujourd'hui reste valide jusqu'à la fin du jour (_find_applicable_rule
        # compare avec >=) : ce n'est qu'une fois la date de clôture PASSÉE que la règle cesse
        # d'être un paramétrage actif à surveiller.
        rule = self._make_rule(name="Ancienne", time_start=7.0, time_end=9.0, priority=10)
        self._make_rule(name="Chevauche", time_start=8.0, time_end=10.0, priority=10)
        yesterday = date.today() - timedelta(days=1)
        rule.with_context(babana_allow_versioned_write=True).write({"active_to": yesterday})

        self.assertFalse(rule.has_overlap, "Une règle close hier n'est plus un paramétrage actif.")
        self.assertEqual(len(rule.overlap_rule_ids), 0)

    # --- Critère 5 : la création de version est explicite, jamais une modification en place --

    def test_new_version_wizard_prefills_from_the_locked_rule(self):
        rule = self._make_rule(base_fare=200.0)
        client = self.env["res.partner"].create({"name": "Client de test"})
        self.env["babana.ride"].with_context(babana_allow_state_write=True).create(
            {
                "client_id": client.id,
                "pickup_latitude": 4.05,
                "pickup_longitude": 9.70,
                "dropoff_latitude": 4.06,
                "dropoff_longitude": 9.77,
                "fare_rule_id": rule.id,
            }
        )
        self.assertTrue(rule.locked_by_usage)

        action = rule.action_open_new_version_wizard()

        self.assertEqual(action["res_model"], "babana.fare.rule.version.wizard")
        self.assertEqual(action["context"]["default_source_rule_id"], rule.id)
        self.assertEqual(action["context"]["default_base_fare"], 200.0)

        wizard = self.env["babana.fare.rule.version.wizard"].create(
            {**{k[len("default_") :]: v for k, v in action["context"].items()}, "base_fare": 260.0}
        )
        result = wizard.action_confirm()

        self.assertEqual(rule.base_fare, 200.0, "La règle verrouillée n'a pas bougé.")
        self.assertTrue(rule.active_to, "La règle d'origine est close par la nouvelle version.")
        new_rule = self.env["babana.fare.rule"].browse(result["res_id"])
        self.assertEqual(new_rule.base_fare, 260.0)
        self.assertFalse(new_rule.active_to)

    def test_unlocked_rule_has_no_locked_flag(self):
        rule = self._make_rule()
        self.assertFalse(rule.locked_by_usage)
