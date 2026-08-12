# Moteur de cotation (L2-03). Fonction pure : aucune lecture de l'horloge ni de la base à
# l'intérieur du calcul -- c'est ce qui permet de rejouer un litige tarifaire à l'identique six
# mois plus tard (amoa/specs/L2-tarification.md, L2-03). Toutes les entrées, y compris la
# promotion déjà résolue et le pas d'arrondi, sont passées en paramètre par l'appelant (L2-04,
# hors de ce lot) -- ce module ne connaît ni l'ORM ni babana.fare.rule.
from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class FareRuleInput:
    """Vue en lecture seule des champs de babana.fare.rule utiles au calcul -- pas le
    recordset Odoo lui-même, pour que cette fonction reste indépendante de l'ORM."""

    base_fare: float
    price_per_km: float
    minimum_fare: float
    surge_multiplier: float = 1.0


@dataclass(frozen=True)
class PromotionInput:
    """Vue en lecture seule d'une promotion déjà résolue et validée par l'appelant (L2-06,
    absente ce soir). `type` vaut 'percentage' ou 'fixed_amount'."""

    code: str
    type: str
    value: float
    max_discount: float | None = None


@dataclass(frozen=True)
class FareBreakdown:
    """Détail décomposé (critère d'acceptation 4) : chaque composante est additive, la somme de
    toutes reconstruit exactement `total` (voir `sum_matches_total`) -- un montant sans
    décomposition vérifiable est indéfendable en cas de contestation."""

    base_fare: float
    distance_fare: float
    surge_amount: float
    discount_amount: float
    floor_amount: float
    rounding_amount: float
    minimum_fare_applied: bool
    total: float

    def sum_matches_total(self) -> bool:
        return math.isclose(
            self.base_fare
            + self.distance_fare
            + self.surge_amount
            - self.discount_amount
            + self.floor_amount
            + self.rounding_amount,
            self.total,
            abs_tol=1e-6,
        )


def compute_fare(
    rule: FareRuleInput,
    distance_m: float,
    *,
    rounding_step: float,
    promotion: PromotionInput | None = None,
) -> FareBreakdown:
    """Calcule le montant d'une course (L2-03), dans l'ordre imposé par la spécification :
    1. base + distance x prix au km ; 2. coefficient d'heure de pointe ; 3. promotion
    éventuelle ; 4. plancher, après la promotion ; 5. arrondi FCFA au pas configuré."""
    distance_km = distance_m / 1000.0
    distance_fare = distance_km * rule.price_per_km
    subtotal = (rule.base_fare + distance_fare) * rule.surge_multiplier
    surge_amount = subtotal - (rule.base_fare + distance_fare)

    discount_amount = _compute_discount(subtotal, promotion) if promotion is not None else 0.0
    after_discount = subtotal - discount_amount

    # Critère 3 : le plancher s'applique après la promotion, pas avant -- une promotion ne fait
    # jamais descendre une course sous son minimum.
    minimum_fare_applied = after_discount < rule.minimum_fare
    floored = max(after_discount, rule.minimum_fare)
    floor_amount = floored - after_discount

    total = _round_up_to_step(floored, rounding_step)
    rounding_amount = total - floored

    return FareBreakdown(
        base_fare=rule.base_fare,
        distance_fare=distance_fare,
        surge_amount=surge_amount,
        discount_amount=discount_amount,
        floor_amount=floor_amount,
        rounding_amount=rounding_amount,
        minimum_fare_applied=minimum_fare_applied,
        total=total,
    )


def _compute_discount(subtotal: float, promotion: PromotionInput) -> float:
    if promotion.type == "percentage":
        discount = subtotal * (promotion.value / 100.0)
    elif promotion.type == "fixed_amount":
        discount = promotion.value
    else:
        raise ValueError(f"Type de promotion inconnu : {promotion.type!r}")
    if promotion.max_discount is not None:
        discount = min(discount, promotion.max_discount)
    # Une remise ne peut pas rendre le sous-total négatif avant même le plancher.
    return min(discount, subtotal)


def _round_up_to_step(amount: float, step: float) -> float:
    """Arrondi au multiple supérieur du pas (critère 5) -- 25 ou 50 FCFA typiquement, jamais à
    l'unité (le FCFA n'a pas de subdivision en circulation). `round(..., 9)` avant `ceil` : sans
    ça, un montant déjà exactement multiple du pas peut se retrouver légèrement au-dessus à
    cause de l'imprécision binaire des flottants, et se faire arrondir un cran plus haut qu'il
    ne devrait."""
    if step <= 0:
        return amount
    return math.ceil(round(amount / step, 9)) * step
