# Tests du journal d'audit immuable (L8-09, D67). CLAUDE.md place ce lot sous vigilance
# particulière : un litige pendant le pilote (une remise contestée, un montant discuté) ne se
# tranche que si le journal existe, ne ment jamais sur ce qui s'est passé (avant/après
# exploitables), et ne peut être trafiqué -- même par un administrateur.
from __future__ import annotations

import json
import uuid
from datetime import timedelta
from unittest.mock import patch

from odoo.exceptions import UserError
from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestAuditLogBase(TransactionCase):
    def _make_driver(self, name="Chauffeur"):
        employee = self.env["hr.employee"].create({"name": name})
        return self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})

    def _make_partner(self, name="Client"):
        return self.env["res.partner"].create({"name": name})

    def _make_supervisor(self, name="Superviseur"):
        supervisor_group = self.env.ref("babana.group_babana_supervisor")
        internal_user_group = self.env.ref("base.group_user")
        return self.env["res.users"].create(
            {
                "name": name,
                "login": f"{name.lower()}-{uuid.uuid4()}@example.invalid",
                "groups_id": [(6, 0, [supervisor_group.id, internal_user_group.id])],
            }
        )

    def _make_admin(self, name="Admin"):
        admin_group = self.env.ref("babana.group_babana_admin")
        internal_user_group = self.env.ref("base.group_user")
        return self.env["res.users"].create(
            {
                "name": name,
                "login": f"{name.lower()}-{uuid.uuid4()}@example.invalid",
                "groups_id": [(6, 0, [admin_group.id, internal_user_group.id])],
            }
        )

    def _entries_for(self, model_name, res_id):
        return self.env["babana.audit.log"].sudo().search(
            [("model_name", "=", model_name), ("res_id", "=", res_id)]
        )

    def _base_ride_vals(self, client):
        return {
            "client_id": client.id,
            "pickup_latitude": 4.05,
            "pickup_longitude": 9.70,
            "dropoff_latitude": 4.06,
            "dropoff_longitude": 9.77,
        }


# === Critère 1 : chaque événement de la liste produit une entrée =============================


@tagged("post_install", "-at_install")
class TestAuditLogCoversRequiredEvents(TestAuditLogBase):
    def test_ride_transition_produces_an_entry(self):
        # Machine à états (L4-02) : le point d'accroche est _babana_journalize, appelé depuis
        # le premier jour à chaque transition -- ici, une seule (action_request) suffit à
        # prouver que le chemin fonctionne ; test_ride_state_machine.py couvre déjà les huit.
        client = self._make_partner()
        ride = self.env["babana.ride"].action_request(self._base_ride_vals(client))

        entries = self._entries_for("babana.ride", ride.id)
        self.assertTrue(entries, "aucune entrée pour la création de la course (transition)")
        self.assertEqual(entries[0].event, "ride.request_creation")

    def test_cash_movement_produces_an_entry(self):
        driver = self._make_driver()
        movement = self.env["babana.cash.movement"].create(
            {"driver_id": driver.id, "movement_type": "collection", "amount": 1500}
        )

        entries = self._entries_for("babana.cash.movement", movement.id)
        self.assertTrue(entries, "aucune entrée pour un mouvement de compte courant")
        self.assertEqual(entries[0].event, "cash_movement.collection")

    def test_adjustment_movement_produces_an_entry(self):
        # Un ajustement est un babana.cash.movement comme un autre (movement_type='adjustment')
        # -- pas une catégorie à journaliser séparément.
        driver = self._make_driver()
        movement = self.env["babana.cash.movement"].create(
            {
                "driver_id": driver.id,
                "movement_type": "adjustment",
                "amount": -500,
                "reason": "Correction de test",
            }
        )

        entries = self._entries_for("babana.cash.movement", movement.id)
        self.assertEqual(entries[0].event, "cash_movement.adjustment")

    def test_remittance_declare_and_validate_each_produce_an_entry(self):
        driver = self._make_driver()
        self.env["babana.cash.movement"].create(
            {"driver_id": driver.id, "movement_type": "collection", "amount": 1200}
        )
        driver.invalidate_recordset()

        remittance = self.env["babana.cash.remittance"].action_declare(
            driver=driver, declared_amount=1200
        )
        declare_entries = self._entries_for("babana.cash.remittance", remittance.id)
        self.assertEqual(
            [e.event for e in declare_entries], ["cash_remittance.declare"],
            "la déclaration doit produire exactement une entrée",
        )

        supervisor = self._make_supervisor()
        remittance.with_user(supervisor).action_validate(
            supervisor=supervisor, counted_amount=1200
        )
        all_entries = self._entries_for("babana.cash.remittance", remittance.id)
        events = sorted(e.event for e in all_entries)
        self.assertEqual(
            events,
            ["cash_remittance.declare", "cash_remittance.validate"],
            "la déclaration ET la validation doivent chacune produire leur entrée",
        )

    def test_driver_state_change_produces_an_entry(self):
        driver = self._make_driver()
        driver.action_suspend(reason="Test L8-09")

        entries = self._entries_for("babana.driver", driver.id)
        state_changes = entries.filtered(lambda e: e.event == "driver.state_change")
        self.assertTrue(state_changes, "aucune entrée pour le changement d'état chauffeur")

    def test_driver_document_access_produces_an_entry(self):
        # Le seul événement de la liste qui ne passe par aucune transition (spécification) --
        # ici via le chemin back-office (action_preview), le plus simple à exercer sans HTTP ;
        # controllers/documents.py::_signed_url appelle le même point d'écriture.
        driver = self._make_driver()
        document = self.env["babana.driver.document"].create(
            {
                "driver_id": driver.id,
                "document_type": "id_card",
                "storage_key": "test/audit-log/id.jpg",
                "mime_type": "image/jpeg",
            }
        )

        document.action_preview()

        entries = self._entries_for("babana.driver.document", document.id)
        self.assertTrue(entries, "aucune entrée pour l'accès à un document chauffeur")
        self.assertEqual(entries[0].event, "driver_document.access")


# === Critère 2 : immuable, y compris pour un administrateur ==================================


@tagged("post_install", "-at_install")
class TestAuditLogImmutable(TestAuditLogBase):
    def _one_entry(self):
        client = self._make_partner()
        ride = self.env["babana.ride"].action_request(self._base_ride_vals(client))
        return self._entries_for("babana.ride", ride.id)[0]

    def test_admin_cannot_write(self):
        entry = self._one_entry()
        admin = self._make_admin()
        with self.assertRaises(UserError):
            entry.with_user(admin).write({"event": "falsifié"})

    def test_admin_cannot_unlink(self):
        entry = self._one_entry()
        admin = self._make_admin()
        with self.assertRaises(UserError):
            entry.with_user(admin).unlink()

    def test_sudo_does_not_bypass_write_or_unlink(self):
        # Interdit au niveau du MODÈLE (write()/unlink() lèvent inconditionnellement), pas par
        # une règle d'enregistrement -- les règles ne s'appliquent pas en sudo (D54). C'est
        # précisément ce que ce test prouve : sudo() ne suffit pas ici.
        entry = self._one_entry()
        with self.assertRaises(UserError):
            entry.sudo().write({"event": "falsifié"})
        with self.assertRaises(UserError):
            entry.sudo().unlink()


# === Critère 3 : un échec d'écriture du journal ne bloque jamais l'opération métier ===========


@tagged("post_install", "-at_install")
class TestAuditLogNeverBlocksBusinessOperation(TestAuditLogBase):
    def test_ride_transition_succeeds_even_if_audit_log_write_fails(self):
        client = self._make_partner()
        # Patché sur la classe assemblée par le registre (celle réellement instanciée), pas sur
        # le module Python du modèle -- le seul moyen fiable d'intercepter l'appel réel.
        AuditLogModel = type(self.env["babana.audit.log"])

        with patch.object(AuditLogModel, "create", side_effect=RuntimeError("panne simulée")):
            ride = self.env["babana.ride"].action_request(self._base_ride_vals(client))

        # La transition a eu lieu malgré l'échec du journal (critère d'acceptation 3).
        self.assertEqual(ride.state, "requested")
        # Et, sans surprise, rien n'a été journalisé pour cette course précise.
        self.assertFalse(self._entries_for("babana.ride", ride.id))

    def test_cash_movement_creation_succeeds_even_if_audit_log_write_fails(self):
        driver = self._make_driver()
        AuditLogModel = type(self.env["babana.audit.log"])

        with patch.object(AuditLogModel, "create", side_effect=RuntimeError("panne simulée")):
            movement = self.env["babana.cash.movement"].create(
                {"driver_id": driver.id, "movement_type": "collection", "amount": 800}
            )

        self.assertTrue(movement.exists())
        self.assertEqual(movement.amount, 800)


# === D68 : un échec silencieux du critère 3 doit se voir ailleurs que dans le journal =========
#
# Le journal ne lève jamais (critère 3) et personne ne peut y écrire à sa place (critère 2) --
# ensemble, sans ce qui suit, un échec d'écriture n'aurait plus d'autre trace que
# `_logger.exception`, c'est-à-dire le journal applicatif que L8-09 existe pour remplacer
# (01-architecture.md §9 decies). Ces tests PROVOQUENT l'échec ; aucun ne se contente de vérifier
# qu'un succès réussit -- ça, c'est déjà couvert ci-dessus.


@tagged("post_install", "-at_install")
class TestAuditLogFailureVisibility(TestAuditLogBase):
    def _health(self):
        # Même geste que l'ouverture réelle de l'écran (babana_audit_log_views.xml) : create({})
        # sur le TransientModel déclenche default_get(), même patron que
        # babana.cash.dashboard dans test_cash_backoffice.py.
        return self.env["babana.audit.log.health"].create({})

    def test_no_failure_before_anything_broke(self):
        health = self._health()
        self.assertFalse(health.has_failure)
        self.assertEqual(health.failure_count, 0)

    def test_write_failure_becomes_visible_without_opening_a_log_file(self):
        client = self._make_partner()
        AuditLogModel = type(self.env["babana.audit.log"])

        with patch.object(AuditLogModel, "create", side_effect=RuntimeError("panne simulée")):
            self.env["babana.ride"].action_request(self._base_ride_vals(client))

        health = self._health()
        self.assertTrue(
            health.has_failure,
            "un échec d'écriture du journal doit se voir sur babana.audit.log.health",
        )
        self.assertEqual(health.failure_count, 1)
        self.assertEqual(health.last_failure_event, "ride.request_creation")
        self.assertEqual(health.last_failure_model_name, "babana.ride")
        self.assertIn("panne simulée", health.last_failure_error)

    def test_signal_survives_even_though_the_model_that_failed_cannot_carry_it(self):
        # Le point du D68 : le signal ne vit PAS dans babana.audit.log -- il reste lisible
        # alors même que ce modèle est celui qui casse, tout du long, sur DEUX pannes
        # successives (le compteur doit les accumuler, pas se contenter d'un booléen).
        driver = self._make_driver()
        AuditLogModel = type(self.env["babana.audit.log"])

        with patch.object(AuditLogModel, "create", side_effect=RuntimeError("panne 1")):
            self.env["babana.cash.movement"].create(
                {"driver_id": driver.id, "movement_type": "collection", "amount": 500}
            )
        with patch.object(AuditLogModel, "create", side_effect=RuntimeError("panne 2")):
            self.env["babana.cash.movement"].create(
                {"driver_id": driver.id, "movement_type": "collection", "amount": 500}
            )

        health = self._health()
        self.assertTrue(health.has_failure)
        self.assertEqual(health.failure_count, 2)
        self.assertIn("panne 2", health.last_failure_error)

    def test_acknowledge_clears_the_signal_but_only_on_an_explicit_gesture(self):
        client = self._make_partner()
        AuditLogModel = type(self.env["babana.audit.log"])
        with patch.object(AuditLogModel, "create", side_effect=RuntimeError("panne simulée")):
            self.env["babana.ride"].action_request(self._base_ride_vals(client))
        self.assertTrue(self._health().has_failure)

        # Un événement journalisé AVEC succès entre-temps ne doit pas effacer le signal tout
        # seul -- un échec intermittent redevenu vert doit rester visible jusqu'à ce qu'un
        # administrateur l'ait réellement vu, pas jusqu'au prochain événement qui réussit.
        self.env["babana.ride"].action_request(self._base_ride_vals(self._make_partner("B")))
        self.assertTrue(
            self._health().has_failure,
            "un succès ultérieur ne doit pas effacer silencieusement un échec passé",
        )

        admin = self._make_admin()
        health = self.env["babana.audit.log.health"].with_user(admin).create({})
        health.action_acknowledge()

        after = self._health()
        self.assertFalse(after.has_failure)
        self.assertEqual(after.failure_count, 0)


# === Critère 4 : avant/après exploitables pour reconstituer un historique =====================


@tagged("post_install", "-at_install")
class TestAuditLogBeforeAfter(TestAuditLogBase):
    def test_driver_state_change_records_before_and_after(self):
        driver = self._make_driver()
        driver.action_suspend(reason="Motif de test")

        entry = self._entries_for("babana.driver", driver.id).filtered(
            lambda e: e.event == "driver.state_change"
        )
        self.assertEqual(len(entry), 1)
        before = json.loads(entry.before)
        after = json.loads(entry.after)
        self.assertEqual(before["state"], "approved")
        self.assertEqual(after["state"], "suspended")

    def test_ride_acceptance_records_before_and_after(self):
        client = self._make_partner()
        driver = self._make_driver()
        ride = self.env["babana.ride"].action_request(self._base_ride_vals(client))
        ride.action_propose(by_partner=client, driver=driver)
        ride.action_accept(by_driver=driver)

        entry = self._entries_for("babana.ride", ride.id).filtered(
            lambda e: e.event == "ride.acceptance"
        )
        self.assertEqual(len(entry), 1)
        self.assertEqual(json.loads(entry.before)["state"], "proposed")
        self.assertEqual(json.loads(entry.after)["state"], "assigned")

    def test_cash_movement_after_reflects_written_values(self):
        driver = self._make_driver()
        movement = self.env["babana.cash.movement"].create(
            {"driver_id": driver.id, "movement_type": "collection", "amount": 950}
        )

        entry = self._entries_for("babana.cash.movement", movement.id)[0]
        self.assertFalse(entry.before, "une création n'a pas d'état antérieur")
        after = json.loads(entry.after)
        self.assertEqual(after["amount"], 950)
        self.assertEqual(after["movement_type"], "collection")
        self.assertEqual(after["driver_id"], driver.id)


# === Critère 5 : la purge respecte la durée de rétention ======================================


@tagged("post_install", "-at_install")
class TestAuditLogPurge(TestAuditLogBase):
    def test_purge_removes_only_entries_past_retention(self):
        # Deux clients distincts, pas le même deux fois : babana_ride_one_active_per_client
        # (L4-01) refuse une seconde course 'requested' pour un client qui en a déjà une.
        old_ride = self.env["babana.ride"].action_request(
            self._base_ride_vals(self._make_partner("Client A"))
        )
        recent_ride = self.env["babana.ride"].action_request(
            self._base_ride_vals(self._make_partner("Client B"))
        )

        old_entry = self._entries_for("babana.ride", old_ride.id)[0]
        recent_entry = self._entries_for("babana.ride", recent_ride.id)[0]

        retention_days = 30
        self.env["ir.config_parameter"].sudo().set_param(
            "babana.audit_log_retention_days", str(retention_days)
        )
        # write() est bloqué par construction (critère 2) -- le SQL direct est le seul moyen de
        # simuler une ancienneté dans ce test, exactement comme il faudrait le faire en
        # production pour n'importe quelle autre raison (aucune, précisément le point).
        past_threshold = old_entry.create_date - timedelta(days=retention_days + 1)
        self.env.cr.execute(
            "UPDATE babana_audit_log SET create_date = %s WHERE id = %s",
            (past_threshold, old_entry.id),
        )
        old_entry.invalidate_recordset()

        self.env["babana.audit.log"]._cron_purge()

        self.assertFalse(old_entry.exists(), "l'entrée hors rétention doit avoir été purgée")
        self.assertTrue(recent_entry.exists(), "l'entrée récente ne doit pas être purgée")

    def test_purge_uses_configured_retention_not_a_hardcoded_value(self):
        # Invariant 5 : rien de codé en dur -- une rétention très courte doit purger une entrée
        # qui vient tout juste d'être créée.
        client = self._make_partner()
        ride = self.env["babana.ride"].action_request(self._base_ride_vals(client))
        entry = self._entries_for("babana.ride", ride.id)[0]

        self.env["ir.config_parameter"].sudo().set_param("babana.audit_log_retention_days", "0")
        self.env.cr.execute(
            "UPDATE babana_audit_log SET create_date = create_date - interval '1 second' "
            "WHERE id = %s",
            (entry.id,),
        )
        entry.invalidate_recordset()

        self.env["babana.audit.log"]._cron_purge()

        self.assertFalse(entry.exists())
