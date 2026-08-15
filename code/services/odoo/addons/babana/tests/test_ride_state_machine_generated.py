# Tests de la machine à états générés depuis fixtures/transitions.json (L4-10). Aucune assertion
# écrite à la main sur une transition précise ici -- la table est chargée, la matrice complète
# état x action est calculée, un test est généré par cellule. Ajouter une transition à la table
# sans la traduire dans _ACTION_BY_TRANSITION (ou en retirer une du code sans y toucher) fait
# donc échouer la suite au chargement du module, avant même qu'un test ne s'exécute (critère
# d'acceptation 2) -- pas besoin d'écrire un nouveau test à la main pour que l'oubli se voie.
#
# Ce que ce fichier NE couvre PAS, par choix documenté :
# - écriture directe de state, modification après settled : déjà couverts par
#   test_ride_state_machine.py (L4-02) -- pas dupliqués ici, la matrice ne porte que sur les
#   méthodes de transition elles-mêmes.
# - transitions concurrentes sur la même course : L4-11 (test/concurrency/, hors du harnais
#   Odoo). TransactionCase enveloppe chaque test dans une transaction annulée à la fin -- une
#   seconde connexion réelle n'y voit rien, ou attend un verrou qui ne se libère qu'à la fin du
#   test (constaté le 11 août, retiré du harnais dans L4-02R -- amoa/questions/L4-02.md, point 4).
from __future__ import annotations

import json
import os

from odoo.tests.common import TransactionCase, tagged

from ..models.babana_ride_state import RideInvalidTransition

_FIXTURE_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "transitions.json")

with open(_FIXTURE_PATH, encoding="utf-8") as _f:
    _FIXTURE = json.load(_f)

ALL_STATES = _FIXTURE["states"]
TRANSITIONS = _FIXTURE["transitions"]

# Traduit chaque paire (from, to) de la table en la méthode de transition Odoo qui la produit
# (babana_ride_state.py, L4-02). Une KeyError ici, pas un .get() silencieux, est précisément ce
# qui matérialise le critère d'acceptation 2 : une transition ajoutée à la table sans être
# ajoutée ici fait échouer le chargement du module de test.
_ACTION_BY_TRANSITION = {
    ("draft", "requested"): "action_request",
    ("requested", "proposed"): "action_propose",
    ("rejected", "proposed"): "action_propose",
    ("proposed", "assigned"): "action_accept",
    ("proposed", "rejected"): "action_reject",
    ("assigned", "in_progress"): "action_start",
    ("in_progress", "completed"): "action_complete",
    ("completed", "settled"): "action_settle",
    ("requested", "cancelled"): "action_cancel",
    ("proposed", "cancelled"): "action_cancel",
    ("assigned", "cancelled"): "action_cancel",
    ("rejected", "cancelled"): "action_cancel",
    ("in_progress", "cancelled"): "action_cancel",
}

for _t in TRANSITIONS:
    _pair = (_t["from"], _t["to"])
    if _pair not in _ACTION_BY_TRANSITION:
        raise AssertionError(
            f"fixtures/transitions.json porte la transition {_pair!r}, absente de "
            "_ACTION_BY_TRANSITION dans test_ride_state_machine_generated.py -- implémentation "
            "et table ont divergé (L4-10, critère d'acceptation 2)."
        )

# action_request exclue : elle ne part pas d'un état persisté -- draft n'existe jamais en base
# (C-03) -- donc n'a pas de "from" à faire varier dans la matrice.
TESTED_ACTIONS = sorted(
    {action for action in _ACTION_BY_TRANSITION.values() if action != "action_request"}
)
TESTED_FROM_STATES = [s for s in ALL_STATES if s != "draft"]

VALID_FROM_STATES_BY_ACTION = {
    action: {frm for (frm, _to), a in _ACTION_BY_TRANSITION.items() if a == action}
    for action in TESTED_ACTIONS
}


class _GeneratedTransitionMatrixBase(TransactionCase):
    """Les méthodes de test sont ajoutées dynamiquement plus bas -- aucune ici, seulement les
    fabriques de fixtures qu'elles partagent."""

    def _make_client(self):
        return self.env["res.partner"].create({"name": "Client (généré, L4-10)"})

    def _make_driver(self):
        employee = self.env["hr.employee"].create({"name": "Chauffeur (généré, L4-10)"})
        return self.env["babana.driver"].create(
            {"employee_id": employee.id, "state": "approved"}
        )

    def _make_ride_in_state(self, state, *, client, driver):
        vals = {
            "client_id": client.id,
            "driver_id": driver.id,
            "pickup_latitude": 4.05,
            "pickup_longitude": 9.70,
            "dropoff_latitude": 4.06,
            "dropoff_longitude": 9.77,
            "state": state,
        }
        return self.env["babana.ride"].with_context(babana_allow_state_write=True).create(vals)

    def _call_action(self, ride, action, *, driver, client):
        if action == "action_propose":
            return ride.action_propose(by_partner=client, driver=driver)
        if action == "action_accept":
            return ride.action_accept(by_driver=driver)
        if action == "action_reject":
            return ride.action_reject(by_driver=driver, reason="motif de test (généré)")
        if action == "action_start":
            return ride.action_start(by_driver=driver)
        if action == "action_complete":
            return ride.action_complete(
                by_driver=driver,
                actual_distance_km=5.0,
                actual_duration_minutes=15,
                final_amount=1200,
            )
        if action == "action_settle":
            return ride.action_settle(by_driver=driver)
        if action == "action_cancel":
            # in_progress n'admet qu'une annulation par le chauffeur (L4-07) -- action_cancel le
            # vérifie après le contrôle d'état, donc seul importe ici pour les cas VALIDES ;
            # pour les cas invalides (état non annulable), le contrôle d'état précède et rend ce
            # choix indifférent.
            actor_role = "driver" if ride.state == "in_progress" else "client"
            actor_record = driver if actor_role == "driver" else client
            return ride.action_cancel(
                actor_role=actor_role, actor_record=actor_record, reason="motif de test (généré)"
            )
        raise AssertionError(f"action non gérée par le générateur de L4-10 : {action}")


def _make_valid_test(action: str, from_state: str, to_state: str):
    def test(self):
        client = self._make_client()
        driver = self._make_driver()
        ride = self._make_ride_in_state(from_state, client=client, driver=driver)

        self._call_action(ride, action, driver=driver, client=client)

        self.assertEqual(ride.state, to_state)

    test.__name__ = f"test_valid__from_{from_state}__{action}__to_{to_state}"
    test.__doc__ = f"{from_state} --[{action}]--> {to_state} (généré depuis transitions.json)"
    return test


def _make_invalid_test(action: str, from_state: str):
    def test(self):
        client = self._make_client()
        driver = self._make_driver()
        ride = self._make_ride_in_state(from_state, client=client, driver=driver)

        with self.assertRaises(RideInvalidTransition):
            self._call_action(ride, action, driver=driver, client=client)

    test.__name__ = f"test_invalid__from_{from_state}__{action}"
    test.__doc__ = f"{from_state} --[{action}]--> refusé (généré, absent de transitions.json)"
    return test


def _generate_matrix_methods() -> dict:
    methods = {}
    for action in TESTED_ACTIONS:
        valid_froms = VALID_FROM_STATES_BY_ACTION[action]
        for from_state in TESTED_FROM_STATES:
            if from_state in valid_froms:
                to_state = next(
                    to
                    for (frm, to), a in _ACTION_BY_TRANSITION.items()
                    if a == action and frm == from_state
                )
                test = _make_valid_test(action, from_state, to_state)
            else:
                test = _make_invalid_test(action, from_state)
            assert test.__name__ not in methods, f"collision de nom de test : {test.__name__}"
            methods[test.__name__] = test
    return methods


# Critère d'acceptation 1 : les tests sont générés, pas écrits -- type() construit la classe de
# test depuis le dictionnaire de méthodes calculé ci-dessus, qu'aucune main humaine n'a énuméré.
TestRideStateMachineGenerated = tagged("post_install", "-at_install")(
    type(
        "TestRideStateMachineGenerated",
        (_GeneratedTransitionMatrixBase,),
        _generate_matrix_methods(),
    )
)
