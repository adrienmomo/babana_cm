# Tests du moteur de cotation (L2-03). Fonction pure : BaseCase (pas TransactionCase) suffit,
# aucune transaction de base de données n'est nécessaire -- un simple unittest.TestCase n'a en
# revanche pas les attributs que le sélecteur de tags d'Odoo (--test-tags) exige de chaque test.
from __future__ import annotations

from odoo.tests.common import BaseCase, tagged

from ..services.pricing import FareRuleInput, PromotionInput, compute_fare

_RULE = FareRuleInput(base_fare=200.0, price_per_km=100.0, minimum_fare=300.0)


@tagged("post_install", "-at_install")
class TestPricingEngine(BaseCase):
    # --- Critères 1 et 2 : fonction pure, aucun appel externe ----------------------------------

    def test_calling_twice_with_the_same_inputs_returns_the_same_result(self):
        first = compute_fare(_RULE, 5000, rounding_step=25.0)
        second = compute_fare(_RULE, 5000, rounding_step=25.0)
        self.assertEqual(first, second)

    # --- Critère 6 : distance nulle -> max(base_fare, minimum_fare), pas une erreur -----------

    def test_zero_distance_produces_the_maximum_of_base_and_minimum_fare(self):
        # base_fare (200) < minimum_fare (300), et 300 est déjà un multiple du pas (25) : le
        # résultat attendu est exactement minimum_fare, sans que l'arrondi ne le déplace.
        breakdown = compute_fare(_RULE, 0, rounding_step=25.0)
        self.assertEqual(breakdown.total, 300.0)
        self.assertTrue(breakdown.minimum_fare_applied)

    def test_zero_distance_with_a_high_base_fare_keeps_the_base_fare(self):
        rule = FareRuleInput(base_fare=500.0, price_per_km=100.0, minimum_fare=300.0)
        breakdown = compute_fare(rule, 0, rounding_step=25.0)
        self.assertEqual(breakdown.total, 500.0)
        self.assertFalse(breakdown.minimum_fare_applied)

    # --- Critère 3 : le plancher s'applique après la promotion --------------------------------

    def test_floor_applies_after_the_discount_not_before(self):
        rule = FareRuleInput(base_fare=200.0, price_per_km=100.0, minimum_fare=300.0)
        # 5 km -> 200 + 500 = 700 avant remise ; 90% de remise -> 70, largement sous le plancher.
        promotion = PromotionInput(code="PROMO90", type="percentage", value=90.0)
        breakdown = compute_fare(rule, 5000, rounding_step=25.0, promotion=promotion)

        self.assertTrue(breakdown.minimum_fare_applied)
        self.assertEqual(breakdown.total, 300.0)

    def test_promotion_above_the_floor_is_not_overridden(self):
        promotion = PromotionInput(code="PROMO10", type="percentage", value=10.0)
        breakdown = compute_fare(_RULE, 5000, rounding_step=25.0, promotion=promotion)

        self.assertFalse(breakdown.minimum_fare_applied)
        # 200 + 500 = 700, -10% = 630, arrondi au pas de 25 supérieur -> 650.
        self.assertEqual(breakdown.total, 650.0)
        self.assertEqual(breakdown.discount_amount, 70.0)

    def test_fixed_amount_promotion_and_max_discount_cap(self):
        promotion = PromotionInput(
            code="MOINS1000", type="fixed_amount", value=1000.0, max_discount=100.0
        )
        # La remise de 1000 FCFA est plafonnée à 100 par max_discount.
        breakdown = compute_fare(_RULE, 5000, rounding_step=25.0, promotion=promotion)
        self.assertEqual(breakdown.discount_amount, 100.0)

    # --- Critère 4 : le détail décomposé est complet, sa somme égale le total -----------------

    def test_breakdown_sum_matches_the_total_in_every_scenario(self):
        scenarios = [
            compute_fare(_RULE, 0, rounding_step=25.0),
            compute_fare(_RULE, 5000, rounding_step=25.0),
            compute_fare(_RULE, 12345, rounding_step=50.0),
            compute_fare(
                _RULE,
                5000,
                rounding_step=25.0,
                promotion=PromotionInput(code="P", type="percentage", value=15.0),
            ),
            compute_fare(
                FareRuleInput(base_fare=300, price_per_km=120, minimum_fare=400, surge_multiplier=1.5),
                8000,
                rounding_step=50.0,
            ),
        ]
        for breakdown in scenarios:
            self.assertTrue(
                breakdown.sum_matches_total(),
                f"la somme des composantes ne reconstruit pas le total : {breakdown}",
            )

    # --- Critère 5 : l'arrondi suit le pas configuré -------------------------------------------

    def test_rounding_goes_up_to_the_next_step(self):
        rule = FareRuleInput(base_fare=201.0, price_per_km=0.0, minimum_fare=0.0)
        breakdown = compute_fare(rule, 0, rounding_step=25.0)
        self.assertEqual(breakdown.total, 225.0)

    def test_amount_already_on_the_step_is_not_bumped_up(self):
        rule = FareRuleInput(base_fare=225.0, price_per_km=0.0, minimum_fare=0.0)
        breakdown = compute_fare(rule, 0, rounding_step=25.0)
        self.assertEqual(breakdown.total, 225.0)

    def test_rounding_step_of_fifty_is_honored(self):
        rule = FareRuleInput(base_fare=201.0, price_per_km=0.0, minimum_fare=0.0)
        breakdown = compute_fare(rule, 0, rounding_step=50.0)
        self.assertEqual(breakdown.total, 250.0)

    # --- Coefficient d'heure de pointe -----------------------------------------------------

    def test_surge_multiplier_applies_to_base_and_distance_together(self):
        rule = FareRuleInput(
            base_fare=200.0, price_per_km=100.0, minimum_fare=0.0, surge_multiplier=1.5
        )
        # (200 + 500) x 1.5 = 1050, déjà multiple de 25.
        breakdown = compute_fare(rule, 5000, rounding_step=25.0)
        self.assertEqual(breakdown.total, 1050.0)
        self.assertEqual(breakdown.surge_amount, 350.0)
