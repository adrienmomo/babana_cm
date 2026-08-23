# Tests de la machine à états (L4-02). Couvre les sept critères d'acceptation ; le critère 4
# (deux action_accept concurrents) est désormais L4-11 (amoa/specs/L4-course.md), hors du
# harnais Odoo -- TransactionCase enveloppe chaque test dans une transaction annulée à la fin,
# ce qu'une preuve de concurrence à deux connexions réelles ne peut pas traverser. Extrait le 11
# août (amoa/questions/REPONSES-2026-08-11.md) ; l'ancien test_ride_state_concurrency.py est
# supprimé d'ici.
from __future__ import annotations

import json
from unittest.mock import patch

import psycopg2
from odoo.exceptions import UserError
from odoo.tests.common import TransactionCase, tagged

from ..models.babana_ride_state import RideInvalidTransition
from ..services import realtime_client


@tagged("post_install", "-at_install")
class TestRideStateMachine(TransactionCase):
    def _make_partner(self, name="Client"):
        return self.env["res.partner"].create({"name": name})

    def _make_driver(self, name="Chauffeur"):
        employee = self.env["hr.employee"].create({"name": name})
        return self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})

    def _base_vals(self, client):
        return {
            "client_id": client.id,
            "pickup_latitude": 4.05,
            "pickup_longitude": 9.70,
            "dropoff_latitude": 4.06,
            "dropoff_longitude": 9.77,
        }

    def _ride_at_proposed(self):
        client = self._make_partner()
        driver = self._make_driver()
        ride = self.env["babana.ride"].action_request(self._base_vals(client))
        ride.action_propose(by_partner=client, driver=driver)
        return ride, client, driver

    def _ride_at_assigned(self):
        ride, client, driver = self._ride_at_proposed()
        ride.action_accept(by_driver=driver)
        return ride, client, driver

    def _ride_completed(self):
        ride, client, driver = self._ride_at_assigned()
        ride.action_start(by_driver=driver)
        ride.action_complete(
            by_driver=driver,
            actual_distance_km=5.0,
            actual_duration_minutes=15,
            final_amount=1000,
        )
        return ride, client, driver

    # === Critère 1 : chaque transition valide de C-03 passe =================================

    def test_action_request_creates_ride_in_requested_state(self):
        client = self._make_partner()
        ride = self.env["babana.ride"].action_request(self._base_vals(client))
        self.assertEqual(ride.state, "requested")
        self.assertTrue(ride.requested_at)

    def test_action_propose_from_requested(self):
        client = self._make_partner()
        driver = self._make_driver()
        ride = self.env["babana.ride"].action_request(self._base_vals(client))
        ride.action_propose(by_partner=client, driver=driver)
        self.assertEqual(ride.state, "proposed")
        self.assertEqual(ride.driver_id, driver)

    def test_action_accept(self):
        ride, _client, driver = self._ride_at_proposed()
        ride.action_accept(by_driver=driver)
        self.assertEqual(ride.state, "assigned")
        self.assertTrue(ride.assigned_at)

    def test_action_reject(self):
        ride, _client, driver = self._ride_at_proposed()
        ride.action_reject(by_driver=driver, reason="trop loin")
        self.assertEqual(ride.state, "rejected")
        self.assertFalse(ride.driver_id)

    def test_action_propose_again_after_rejection(self):
        ride, client, driver1 = self._ride_at_proposed()
        ride.action_reject(by_driver=driver1, reason="trop loin")
        driver2 = self._make_driver("Second chauffeur")
        ride.action_propose(by_partner=client, driver=driver2)
        self.assertEqual(ride.state, "proposed")
        self.assertEqual(ride.driver_id, driver2)

    def test_action_start_writes_in_progress(self):
        # amoa/questions/L4-02.md, point 2 : la version initialement documentée par C-03R (aucune
        # écriture Odoo) s'est révélée intenable -- action_complete exige state == in_progress
        # comme précondition, ce qu'aucune écriture ne pourrait jamais satisfaire sinon.
        ride, _client, driver = self._ride_at_assigned()
        ride.action_start(by_driver=driver)
        self.assertEqual(ride.state, "in_progress")
        self.assertTrue(ride.started_at)

    def test_action_complete(self):
        ride, _client, driver = self._ride_at_assigned()
        ride.action_start(by_driver=driver)
        ride.action_complete(
            by_driver=driver,
            actual_distance_km=5.2,
            actual_duration_minutes=18,
            final_amount=1200,
        )
        self.assertEqual(ride.state, "completed")
        self.assertEqual(ride.final_amount, 1200)

    def test_action_settle(self):
        ride, _client, driver = self._ride_completed()
        ride.action_settle(by_driver=driver, amount_collected=ride.final_amount)
        self.assertEqual(ride.state, "settled")
        self.assertTrue(ride.settled_at)

    def test_action_cancel_from_requested_by_client(self):
        client = self._make_partner()
        ride = self.env["babana.ride"].action_request(self._base_vals(client))
        ride.action_cancel(actor_role="client", actor_record=client)
        self.assertEqual(ride.state, "cancelled")

    def test_action_cancel_from_proposed_by_client(self):
        ride, client, _driver = self._ride_at_proposed()
        ride.action_cancel(actor_role="client", actor_record=client)
        self.assertEqual(ride.state, "cancelled")

    def test_action_cancel_from_assigned_by_driver_with_reason(self):
        ride, _client, driver = self._ride_at_assigned()
        ride.action_cancel(actor_role="driver", actor_record=driver, reason="empêchement")
        self.assertEqual(ride.state, "cancelled")

    def test_action_cancel_from_rejected_by_client(self):
        ride, client, driver = self._ride_at_proposed()
        ride.action_reject(by_driver=driver, reason="x")
        ride.action_cancel(actor_role="client", actor_record=client)
        self.assertEqual(ride.state, "cancelled")
        # L4-07 corrigé le 11 août (amoa/questions/REPONSES-2026-08-11.md) : l'abandon après
        # refus porte une catégorie dédiée et le rang du refus, exploitables par L9-09 sans
        # reconstitution depuis l'historique des refus.
        self.assertEqual(ride.cancel_category, "abandon_after_rejection")
        self.assertEqual(ride.cancelled_after_rejection_rank, 1)

    def test_action_cancel_from_rejected_records_rank_after_several_rejections(self):
        ride, client, driver1 = self._ride_at_proposed()
        ride.action_reject(by_driver=driver1, reason="trop loin")
        driver2 = self._make_driver("Second chauffeur")
        ride.action_propose(by_partner=client, driver=driver2)
        ride.action_reject(by_driver=driver2, reason="pas envie")

        ride.action_cancel(actor_role="client", actor_record=client)

        self.assertEqual(ride.cancelled_after_rejection_rank, 2)

    def test_action_cancel_from_assigned_is_ordinary_category(self):
        # Une annulation ordinaire (hors abandon après refus) ne porte pas cette catégorie --
        # sinon l'indicateur L9-09 compterait des annulations qui n'ont rien à voir avec un
        # refus.
        ride, client, _driver = self._ride_at_assigned()
        ride.action_cancel(actor_role="client", actor_record=client, reason="changement de plan")
        self.assertEqual(ride.cancel_category, "ordinary")
        self.assertEqual(ride.cancelled_after_rejection_rank, 0)

    def test_action_cancel_in_progress_by_driver_with_reason(self):
        ride, _client, driver = self._ride_at_assigned()
        ride.action_start(by_driver=driver)
        ride.action_cancel(actor_role="driver", actor_record=driver, reason="panne moteur")
        self.assertEqual(ride.state, "cancelled")
        self.assertEqual(ride.cancel_reason, "panne moteur")

    # === Critère 2 : chaque transition interdite échoue avec RIDE_INVALID_TRANSITION =========

    def test_requested_to_assigned_directly_is_forbidden(self):
        client = self._make_partner()
        ride = self.env["babana.ride"].action_request(self._base_vals(client))
        driver = self._make_driver()
        with self.assertRaises(RideInvalidTransition):
            ride.action_accept(by_driver=driver)

    def test_rejected_to_assigned_directly_is_forbidden(self):
        ride, _client, driver = self._ride_at_proposed()
        ride.action_reject(by_driver=driver, reason="x")
        with self.assertRaises(RideInvalidTransition):
            ride.action_accept(by_driver=driver)

    def test_completed_cannot_restart(self):
        ride, _client, driver = self._ride_completed()
        with self.assertRaises(RideInvalidTransition):
            ride.action_start(by_driver=driver)

    def test_client_cannot_cancel_in_progress(self):
        ride, client, driver = self._ride_at_assigned()
        ride.action_start(by_driver=driver)
        with self.assertRaises(RideInvalidTransition):
            ride.action_cancel(actor_role="client", actor_record=client)

    def test_settled_is_terminal(self):
        ride, _client, driver = self._ride_completed()
        ride.action_settle(by_driver=driver, amount_collected=ride.final_amount)
        with self.assertRaises(UserError):
            ride.action_settle(by_driver=driver, amount_collected=ride.final_amount)

    def test_cancelled_is_terminal(self):
        client = self._make_partner()
        ride = self.env["babana.ride"].action_request(self._base_vals(client))
        ride.action_cancel(actor_role="client", actor_record=client)
        with self.assertRaises(RideInvalidTransition):
            ride.action_cancel(actor_role="client", actor_record=client)

    def test_wrong_driver_cannot_accept(self):
        ride, _client, _driver = self._ride_at_proposed()
        other_driver = self._make_driver("Autre chauffeur")
        with self.assertRaises(RideInvalidTransition):
            ride.action_accept(by_driver=other_driver)

    def test_wrong_client_cannot_propose(self):
        client = self._make_partner()
        other_client = self._make_partner("Autre client")
        driver = self._make_driver()
        ride = self.env["babana.ride"].action_request(self._base_vals(client))
        with self.assertRaises(RideInvalidTransition):
            ride.action_propose(by_partner=other_client, driver=driver)

    def test_second_non_terminal_request_for_same_client_is_forbidden(self):
        # Depuis le 11 août (L4-01R, amoa/questions/REPONSES-2026-08-11.md), la garantie vient de
        # l'index partiel PostgreSQL de babana.ride, pas d'un contrôle applicatif ici devenu
        # redondant et retiré -- même schéma que test_ride_model.py.
        client = self._make_partner()
        self.env["babana.ride"].action_request(self._base_vals(client))
        with self.assertRaises(psycopg2.Error):
            with self.env.cr.savepoint():
                self.env["babana.ride"].action_request(self._base_vals(client))

    # === Critère 3 : écriture directe de state échoue ==========================================

    def test_direct_state_write_is_forbidden(self):
        client = self._make_partner()
        ride = self.env["babana.ride"].action_request(self._base_vals(client))
        with self.assertRaises(UserError):
            ride.write({"state": "cancelled"})

    def test_direct_state_write_forbidden_even_via_sudo(self):
        client = self._make_partner()
        ride = self.env["babana.ride"].action_request(self._base_vals(client))
        with self.assertRaises(UserError):
            ride.sudo().write({"state": "cancelled"})

    # === Critère 3 bis : création avec un state autre que requested échoue (L4-02R2) =========

    def test_create_with_non_requested_state_is_forbidden(self):
        client = self._make_partner()
        with self.assertRaises(UserError):
            self.env["babana.ride"].create({**self._base_vals(client), "state": "settled"})

    def test_create_with_non_requested_state_is_forbidden_even_via_sudo(self):
        # amoa/questions/REPONSES-2026-08-13.md : create({'state': 'settled', ...}) ne doit pas
        # faire naître une course déjà encaissée sans transition -- settled alimente le compte
        # courant chauffeur et la facturation (L4-05, L4-06).
        client = self._make_partner()
        with self.assertRaises(UserError):
            self.env["babana.ride"].sudo().create(
                {**self._base_vals(client), "state": "settled"}
            )

    def test_create_without_state_defaults_to_requested(self):
        client = self._make_partner()
        ride = self.env["babana.ride"].create(self._base_vals(client))
        self.assertEqual(ride.state, "requested")

    def test_action_request_create_is_not_blocked_by_its_own_guard(self):
        # action_request crée explicitement avec state='requested' -- le seul état qu'une
        # création est autorisée à porter hors du chemin de transition, donc sans avoir besoin
        # du drapeau de contexte babana_allow_state_write.
        client = self._make_partner()
        ride = self.env["babana.ride"].action_request(self._base_vals(client))
        self.assertEqual(ride.state, "requested")

    # === Critère 5 : montant d'une course completed immuable ==================================

    def test_cannot_modify_amount_after_completed(self):
        ride, _client, _driver = self._ride_completed()
        with self.assertRaises(UserError):
            ride.with_context(babana_allow_state_write=True).write({"final_amount": 999999})

    def test_normal_field_still_writable_after_completed(self):
        # Le piège documenté par la spécification : un blocage trop large rendrait le module
        # ininstallable. Un champ hors de l'ensemble figé doit rester modifiable après completed
        # (settled_at, écrit par action_settle, en est la preuve la plus directe).
        ride, _client, driver = self._ride_completed()
        ride.action_settle(by_driver=driver, amount_collected=ride.final_amount)
        self.assertEqual(ride.state, "settled")

    # === Critère 6 : rien ne change après settled ==============================================

    def test_nothing_changes_after_settled(self):
        ride, _client, driver = self._ride_completed()
        ride.action_settle(by_driver=driver, amount_collected=ride.final_amount)
        with self.assertRaises(UserError):
            ride.write({"pickup_label": "Nouvelle adresse"})

    def test_nothing_changes_after_settled_even_via_sudo(self):
        ride, _client, driver = self._ride_completed()
        ride.action_settle(by_driver=driver, amount_collected=ride.final_amount)
        with self.assertRaises(UserError):
            ride.sudo().write({"pickup_label": "Nouvelle adresse"})

    # === Critère 7 : historique des refus conservé sur la même course =========================

    def test_rejection_history_preserved_across_reselection(self):
        ride, client, driver1 = self._ride_at_proposed()
        ride.action_reject(by_driver=driver1, reason="premier refus")
        driver2 = self._make_driver("Second")
        ride.action_propose(by_partner=client, driver=driver2)
        ride.action_reject(by_driver=driver2, reason="second refus")

        self.assertEqual(len(ride.rejection_ids), 2)
        self.assertEqual(
            set(ride.rejection_ids.mapped("reason")), {"premier refus", "second refus"}
        )
        self.assertEqual(
            self.env["babana.ride"].search_count([("reference", "=", ride.reference)]), 1
        )

    # === L4-03R : violation de l'index unique traduite en DRIVER_ALREADY_TAKEN ================
    #
    # La vraie fenêtre de course (deux clients qui proposent le même chauffeur presque en même
    # temps) a besoin de deux connexions réellement concurrentes -- TransactionCase ne le permet
    # pas (même raison que L4-11). Ce test prouve directement le mécanisme de traduction lui-même
    # (babana_ride_state.py:action_propose, savepoint + except UniqueViolation) en contournant le
    # chemin rapide Python pour forcer l'écriture à heurter l'index en base pour de vrai -- pas en
    # simulant l'exception.

    def test_index_violation_is_translated_to_driver_already_taken(self):
        from unittest.mock import patch

        client1 = self._make_partner("Client 1")
        client2 = self._make_partner("Client 2")
        driver = self._make_driver()
        ride1 = self.env["babana.ride"].action_request(self._base_vals(client1))
        ride2 = self.env["babana.ride"].action_request(self._base_vals(client2))
        ride1.action_propose(by_partner=client1, driver=driver)

        RideModel = type(ride2)
        original_search = RideModel.search

        def _fake_search(self, domain, *args, **kwargs):
            # Ne court-circuite que le SELECT du chemin rapide (celui qui porte driver_id) --
            # tout le reste (setUp, chargement de champs, etc.) passe par le vrai search().
            if domain and any(cond == ("driver_id", "=", driver.id) for cond in domain):
                return self.browse()
            return original_search(self, domain, *args, **kwargs)

        with patch.object(RideModel, "search", _fake_search):
            with self.assertRaises(UserError) as ctx:
                ride2.action_propose(by_partner=client2, driver=driver)

        self.assertEqual(str(ctx.exception), "DRIVER_ALREADY_TAKEN")
        self.assertEqual(ride2.state, "requested", "aucune transition n'a eu lieu")

    # === L3-19 : action_start / action_complete appellent l'émetteur du cycle de vie ==========
    #
    # Preuve de CÂBLAGE (cette méthode appelle bien la bonne fonction, avec les bons arguments) --
    # complète, sans la remplacer, la preuve du POINT D'ACCROCHE au commit (D32/D33,
    # test_realtime_commit_hook.py, contre un _FakeEnv qui simule réellement commit/rollback) et
    # celle de la LIVRAISON aux deux destinataires (services/realtime/test/internal.test.ts,
    # contre un Redis et des WebSocket réels). Un test HttpCase de bout en bout NE PEUT PAS
    # prouver ce câblage-ci : constaté en en écrivant un (amoa/rapport-nuit-J19.md) -- `--test-
    # enable` enveloppe TOUTE requête HTTP dans TestCursor (`Registry.cursor`), dont `commit()`
    # vide `postcommit` SANS jamais l'exécuter (`odoo.sql_db.TestCursor.commit`, docstring :
    # "TestCursor ignores post-commit hooks by default") -- aucun appel HTTP interne n'a jamais
    # atteint le service temps réel, sans la moindre erreur ni avertissement pour le signaler.

    def _link_user_to_partner(self, partner, label):
        """`_make_partner` (fixture de ce fichier) ne crée qu'un res.partner, jamais le
        res.users qu'une vraie inscription /auth/google pose à côté (res_users.py) -- ce
        qu'`action_start`/`action_complete` doivent traverser pour retrouver
        `babana_public_id` (babana_ride.py::_babana_client_public_id). Posé ici pour les tests
        qui en ont besoin, jamais dans `_make_partner` lui-même : les tests qui n'en ont pas
        besoin doivent rester le cas dégradé (voir test_action_start_does_not_notify_without_a_
        linked_user ci-dessous)."""
        return self.env["res.users"].sudo().create(
            {"name": f"Client {label}", "login": f"{label}-{partner.id}@example.invalid", "partner_id": partner.id}
        )

    def _base_vals_with_snapshot(self, client):
        vals = self._base_vals(client)
        vals["fare_rule_snapshot"] = json.dumps(
            {
                "base_fare": 200.0,
                "distance_fare": 1000.0,
                "surge_amount": 0.0,
                "discount_amount": 0.0,
                "floor_amount": 0.0,
                "rounding_amount": 0.0,
                "minimum_fare_applied": False,
                "total": 1200.0,
            }
        )
        return vals

    def test_action_start_notifies_ride_started(self):
        client = self._make_partner()
        client_user = self._link_user_to_partner(client, "start-notify")
        driver = self._make_driver()
        ride = self.env["babana.ride"].action_request(self._base_vals(client))
        ride.action_propose(by_partner=client, driver=driver)
        ride.action_accept(by_driver=driver)

        with patch.object(realtime_client, "notify_ride_started") as mock_notify:
            ride.action_start(by_driver=driver)

        mock_notify.assert_called_once_with(
            self.env,
            ride_public_id=ride.public_id,
            client_user_public_id=client_user.babana_public_id,
            driver_public_id=driver.public_id,
        )

    def test_action_start_does_not_notify_without_a_linked_user(self):
        # Dégradation silencieuse (babana_ride.py::_babana_client_public_id) plutôt qu'une
        # exception : un client_id sans res.users rattaché (jamais le cas d'une vraie course,
        # toujours celui d'une fixture de test qui crée directement le partenaire) ne doit pas
        # faire échouer la transition elle-même.
        ride, _client, driver = self._ride_at_assigned()

        with patch.object(realtime_client, "notify_ride_started") as mock_notify:
            ride.action_start(by_driver=driver)

        mock_notify.assert_not_called()

    def test_action_complete_notifies_ride_completed_with_the_frozen_breakdown(self):
        client = self._make_partner()
        client_user = self._link_user_to_partner(client, "complete-notify")
        driver = self._make_driver()
        ride = self.env["babana.ride"].action_request(self._base_vals_with_snapshot(client))
        ride.action_propose(by_partner=client, driver=driver)
        ride.action_accept(by_driver=driver)
        ride.action_start(by_driver=driver)

        with patch.object(realtime_client, "notify_ride_completed") as mock_notify:
            ride.action_complete(
                by_driver=driver,
                actual_distance_km=5.2,
                actual_duration_minutes=18,
                final_amount=1200,
            )

        mock_notify.assert_called_once_with(
            self.env,
            ride_public_id=ride.public_id,
            client_user_public_id=client_user.babana_public_id,
            driver_public_id=driver.public_id,
            distance_meters=5200,
            duration_seconds=1080,
            amount=1200,
            breakdown={
                "baseFare": 200,
                "distanceFare": 1000,
                "surgeAmount": 0,
                "discountAmount": 0,
                "floorAmount": 0,
                "roundingAmount": 0,
                "minimumFareApplied": False,
            },
        )

    def test_action_complete_does_not_notify_without_a_fare_rule_snapshot(self):
        # _ride_at_assigned() (fixture de ce fichier) crée la course par action_request direct,
        # sans passer par /quote -- fare_rule_snapshot reste vide, comme documenté dans
        # babana_ride_state.py::action_complete.
        ride, _client, driver = self._ride_at_assigned()
        ride.action_start(by_driver=driver)

        with patch.object(realtime_client, "notify_ride_completed") as mock_notify:
            ride.action_complete(
                by_driver=driver, actual_distance_km=5.0, actual_duration_minutes=15, final_amount=1000,
            )

        mock_notify.assert_not_called()

    # === L4-12 : ride.cancelled, destinataire dépendant de l'acteur (amoa/questions/
    # REPONSES-2026-08-28.md §2) ===============================================================

    def test_action_cancel_by_client_notifies_only_the_driver(self):
        client = self._make_partner()
        client_user = self._link_user_to_partner(client, "cancel-by-client")
        driver = self._make_driver()
        ride = self.env["babana.ride"].action_request(self._base_vals(client))
        ride.action_propose(by_partner=client, driver=driver)
        ride.action_accept(by_driver=driver)

        with patch.object(realtime_client, "notify_ride_cancelled") as mock_notify:
            ride.action_cancel(actor_role="client", actor_record=client, reason="changement de plan")

        mock_notify.assert_called_once_with(
            self.env,
            ride_public_id=ride.public_id,
            cancelled_by="client",
            reason="changement de plan",
            notify_client_user_id=None,
            notify_driver_id=driver.public_id,
        )
        # Sanity check indirect : si _babana_client_public_id() avait été appelé malgré tout, ce
        # test l'aurait quand même laissé passer (client_user existe) -- la valeur ci-dessus le
        # couvre déjà (notify_client_user_id=None), gardé explicite pour ne pas dépendre de
        # l'ordre des assertions.
        self.assertTrue(client_user.babana_public_id)

    def test_action_cancel_by_driver_notifies_only_the_client(self):
        client = self._make_partner()
        client_user = self._link_user_to_partner(client, "cancel-by-driver")
        driver = self._make_driver()
        ride = self.env["babana.ride"].action_request(self._base_vals(client))
        ride.action_propose(by_partner=client, driver=driver)
        ride.action_accept(by_driver=driver)
        ride.action_start(by_driver=driver)

        with patch.object(realtime_client, "notify_ride_cancelled") as mock_notify:
            ride.action_cancel(actor_role="driver", actor_record=driver, reason="panne moteur")

        mock_notify.assert_called_once_with(
            self.env,
            ride_public_id=ride.public_id,
            cancelled_by="driver",
            reason="panne moteur",
            notify_client_user_id=client_user.babana_public_id,
            notify_driver_id=None,
        )

    def test_action_cancel_by_supervisor_notifies_both(self):
        client = self._make_partner()
        client_user = self._link_user_to_partner(client, "cancel-by-supervisor")
        driver = self._make_driver()
        ride = self.env["babana.ride"].action_request(self._base_vals(client))
        ride.action_propose(by_partner=client, driver=driver)
        ride.action_accept(by_driver=driver)

        with patch.object(realtime_client, "notify_ride_cancelled") as mock_notify:
            ride.action_cancel(actor_role="supervisor", reason="incident signalé")

        mock_notify.assert_called_once_with(
            self.env,
            ride_public_id=ride.public_id,
            cancelled_by="supervisor",
            reason="incident signalé",
            notify_client_user_id=client_user.babana_public_id,
            notify_driver_id=driver.public_id,
        )

    def test_action_cancel_from_requested_has_no_driver_to_notify(self):
        # Aucun chauffeur affecté à ce stade -- notify_ride_cancelled ne doit même pas être
        # appelée (rien à envoyer d'un côté, et le client qui annule n'a pas à se notifier
        # lui-même de l'autre).
        client = self._make_partner()
        ride = self.env["babana.ride"].action_request(self._base_vals(client))

        with patch.object(realtime_client, "notify_ride_cancelled") as mock_notify:
            ride.action_cancel(actor_role="client", actor_record=client)

        mock_notify.assert_not_called()

    def test_action_cancel_from_rejected_has_no_driver_to_notify(self):
        # action_reject efface driver_id (état 'rejected') -- le chauffeur qui a refusé n'est
        # plus partie à cette course, il n'y a donc personne côté chauffeur à prévenir d'un
        # abandon qui suit ce refus.
        client = self._make_partner()
        driver = self._make_driver()
        ride = self.env["babana.ride"].action_request(self._base_vals(client))
        ride.action_propose(by_partner=client, driver=driver)
        ride.action_reject(by_driver=driver, reason="indisponible")

        with patch.object(realtime_client, "notify_ride_cancelled") as mock_notify:
            ride.action_cancel(actor_role="client", actor_record=client)

        mock_notify.assert_not_called()

    def test_action_cancel_does_not_notify_without_a_linked_user(self):
        # Même dégradation silencieuse que action_start/action_complete
        # (_babana_client_public_id) : un client_id sans res.users rattaché ne doit pas faire
        # échouer l'annulation elle-même, seulement omettre la notification qu'aucune identité
        # ne peut recevoir.
        ride, _client, driver = self._ride_at_assigned()

        with patch.object(realtime_client, "notify_ride_cancelled") as mock_notify:
            ride.action_cancel(actor_role="driver", actor_record=driver, reason="empêchement")

        mock_notify.assert_not_called()
