# Tests de la validation de remise (L5-04) : declare/validate, la concordance déclaré/compté,
# le déblocage du plafond, puis l'endpoint POST /remittances (C-01 remittance.ts). Ce que
# L5-05/L5-06 ajoutent (écriture comptable, traitement d'écart) est hors de ce fichier -- leurs
# propres tâches, leurs propres tests.
from __future__ import annotations

import json
import uuid

from odoo.exceptions import AccessError, UserError
from odoo.tests.common import HttpCase, TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestRemittanceValidation(TransactionCase):
    def _make_driver(self, name="Chauffeur"):
        employee = self.env["hr.employee"].create({"name": name})
        return self.env["babana.driver"].create({"employee_id": employee.id, "state": "approved"})

    def _make_supervisor(self, name="Superviseur"):
        # base.group_user (Internal User) : un vrai superviseur back-office le porte toujours --
        # attribué automatiquement par l'écran "Utilisateurs" d'Odoo, jamais par le seul groupe
        # babana.group_babana_supervisor (celui-ci ne porte que les droits propres au module).
        # Sans lui, la lecture de modèles de base comme res.currency (compare_amounts,
        # action_validate) échoue -- constaté en écrivant ce test.
        supervisor_group = self.env.ref("babana.group_babana_supervisor")
        internal_user_group = self.env.ref("base.group_user")
        return self.env["res.users"].create(
            {
                "name": name,
                "login": f"{name.lower()}-{uuid.uuid4()}@example.invalid",
                "groups_id": [(6, 0, [supervisor_group.id, internal_user_group.id])],
            }
        )

    def _movement(self, driver, movement_type, amount, **vals):
        return self.env["babana.cash.movement"].create(
            {"driver_id": driver.id, "movement_type": movement_type, "amount": amount, **vals}
        )

    # --- Critère 6 : une remise déclarée mais non validée ne modifie pas le solde -------------

    def test_declaring_alone_does_not_touch_the_balance(self):
        driver = self._make_driver()
        self._movement(driver, "collection", 1200)
        driver.invalidate_recordset()

        remittance = self.env["babana.cash.remittance"].action_declare(
            driver=driver, declared_amount=1200
        )

        self.assertEqual(remittance.state, "declared")
        driver.invalidate_recordset()
        self.assertEqual(driver.cash_balance, 1200, "déclarer seul ne crée aucun mouvement")

    def test_declaring_a_non_positive_amount_is_rejected(self):
        driver = self._make_driver()
        with self.assertRaises(UserError):
            self.env["babana.cash.remittance"].action_declare(driver=driver, declared_amount=0)

    # --- Critère 3 : concordance -> validated, discordance -> disputed ------------------------

    def test_matching_declared_and_counted_amounts_validates(self):
        driver = self._make_driver()
        self._movement(driver, "collection", 1200)
        driver.invalidate_recordset()
        remittance = self.env["babana.cash.remittance"].action_declare(
            driver=driver, declared_amount=1200
        )
        supervisor = self._make_supervisor()

        remittance.with_user(supervisor).action_validate(
            supervisor=supervisor, counted_amount=1200
        )

        self.assertEqual(remittance.state, "validated")

    def test_mismatched_declared_and_counted_amounts_disputes(self):
        driver = self._make_driver()
        self._movement(driver, "collection", 1200)
        driver.invalidate_recordset()
        remittance = self.env["babana.cash.remittance"].action_declare(
            driver=driver, declared_amount=1200
        )
        supervisor = self._make_supervisor()

        remittance.with_user(supervisor).action_validate(
            supervisor=supervisor, counted_amount=1000
        )

        self.assertEqual(remittance.state, "disputed")

    # --- Critère 4 : la validation remet le solde à zéro, au montant compté près --------------

    def test_validation_reduces_the_balance_by_the_counted_amount(self):
        driver = self._make_driver()
        self._movement(driver, "collection", 1200)
        driver.invalidate_recordset()
        remittance = self.env["babana.cash.remittance"].action_declare(
            driver=driver, declared_amount=1200
        )
        supervisor = self._make_supervisor()

        remittance.with_user(supervisor).action_validate(
            supervisor=supervisor, counted_amount=1200
        )

        driver.invalidate_recordset()
        self.assertEqual(driver.cash_balance, 0)

    def test_a_partial_remittance_leaves_the_remainder_on_the_balance(self):
        # D29 (amoa/questions/REPONSES-2026-08-19.md) : "la remise remet le solde à zéro" (D8)
        # n'est vrai que pour une remise complète -- un chauffeur qui remet 40 000 sur 45 000
        # dus repart avec 5 000 au compte courant.
        driver = self._make_driver()
        self._movement(driver, "collection", 45000)
        driver.invalidate_recordset()
        remittance = self.env["babana.cash.remittance"].action_declare(
            driver=driver, declared_amount=40000
        )
        supervisor = self._make_supervisor()

        remittance.with_user(supervisor).action_validate(
            supervisor=supervisor, counted_amount=40000
        )

        driver.invalidate_recordset()
        self.assertEqual(driver.cash_balance, 5000)

    # --- Critère 1 : une remise ne peut être validée que par un superviseur -------------------

    def test_a_user_without_the_supervisor_group_cannot_validate(self):
        driver = self._make_driver()
        self._movement(driver, "collection", 1200)
        driver.invalidate_recordset()
        remittance = self.env["babana.cash.remittance"].action_declare(
            driver=driver, declared_amount=1200
        )
        plain_user = self.env["res.users"].create(
            {"name": "Sans groupe", "login": f"sans-groupe-{uuid.uuid4()}@example.invalid"}
        )

        with self.assertRaises(AccessError):
            remittance.with_user(plain_user).action_validate(
                supervisor=plain_user, counted_amount=1200
            )

    # --- Critère 2 : un chauffeur ne peut pas valider sa propre remise, même superviseur ------

    def test_a_driver_cannot_validate_their_own_remittance_even_as_supervisor(self):
        driver = self._make_driver()
        self._movement(driver, "collection", 1200)
        driver.invalidate_recordset()
        supervisor_group = self.env.ref("babana.group_babana_supervisor")
        internal_user_group = self.env.ref("base.group_user")
        driver_user = self.env["res.users"].create(
            {
                "name": "Chauffeur-superviseur",
                "login": f"chauffeur-superviseur-{uuid.uuid4()}@example.invalid",
                "groups_id": [(6, 0, [supervisor_group.id, internal_user_group.id])],
            }
        )
        driver.write({"user_id": driver_user.id})
        remittance = self.env["babana.cash.remittance"].action_declare(
            driver=driver, declared_amount=1200
        )

        with self.assertRaises(UserError):
            remittance.with_user(driver_user).action_validate(
                supervisor=driver_user, counted_amount=1200
            )

    # --- Critère 5 : un chauffeur bloqué au plafond est débloqué après validation -------------

    def test_a_driver_at_the_limit_can_go_online_again_after_full_validation(self):
        self.env["ir.config_parameter"].sudo().set_param("babana.cash_limit", "1000")
        driver = self._make_driver()
        motorcycle = self.env["babana.motorcycle"].create({"license_plate": "LT-3333-ZZ"})
        motorcycle.write({"driver_id": driver.id})
        self._movement(driver, "collection", 1200)
        driver.invalidate_recordset()
        self.assertEqual(driver._check_online_eligibility(), ("CASH_LIMIT_REACHED", "Le plafond d'encaisse est atteint."))

        remittance = self.env["babana.cash.remittance"].action_declare(
            driver=driver, declared_amount=1200
        )
        supervisor = self._make_supervisor()
        remittance.with_user(supervisor).action_validate(
            supervisor=supervisor, counted_amount=1200
        )

        driver.invalidate_recordset()
        refusal = driver._check_online_eligibility()
        self.assertIsNone(
            refusal,
            f"le chauffeur devrait pouvoir repasser en ligne, motif de refus restant : {refusal}",
        )


@tagged("post_install", "-at_install")
class TestRemittanceController(HttpCase):
    """POST /remittances (C-01 remittance.ts). Jeton réel émis directement
    (`_issue_access_token`, même raccourci que test_token.py) plutôt que le parcours Google mock
    complet : aucune interaction chauffeur-temps-réel n'est en jeu ici, contrairement à
    test_ride_controller.py."""

    def _make_driver_user(self, sub):
        # Même parcours que TestRideController._make_approved_driver (test_ride_controller.py) :
        # action_approve() exige des documents vérifiés et une moto affectée, pas une simple
        # écriture de state.
        from ..controllers.auth import _issue_access_token

        user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub=sub, email=f"{sub}@example.invalid", name=f"Chauffeur {sub}", role="driver"
        )
        driver = user._babana_driver()
        for document_type in ("license", "id_card"):
            vals = {
                "driver_id": driver.id,
                "document_type": document_type,
                "storage_key": f"test/{document_type}.jpg",
                "verification_status": "verified",
            }
            if document_type == "license":
                vals["expires_on"] = "2030-01-01"
            self.env["babana.driver.document"].sudo().create(vals)
        moto = self.env["babana.motorcycle"].sudo().create(
            {"license_plate": f"LT-{uuid.uuid4().hex[:4].upper()}-RM"}
        )
        moto.write({"driver_id": driver.id})
        driver.invalidate_recordset()
        driver.sudo().action_approve(new_employee_name=f"Chauffeur {sub}")
        access_token, _ = _issue_access_token(user)
        return access_token, driver

    def _post(self, path, token, body=None, idempotency_key=None):
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return self.url_open(path, data=json.dumps(body or {}).encode(), headers=headers)

    def test_declaring_a_remittance_returns_pending_and_the_unchanged_balance(self):
        token, driver = self._make_driver_user("sub-remittance-controller-1")
        self.env["babana.cash.movement"].sudo().create(
            {"driver_id": driver.id, "movement_type": "collection", "amount": 1200}
        )

        response = self._post("/api/v1/remittances", token, {"amount": 1200})

        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertEqual(body["amount"], 1200)
        self.assertEqual(body["status"], "pending")
        self.assertEqual(body["driverCashBalance"], 1200)

        remittance = self.env["babana.cash.remittance"].sudo().search(
            [("public_id", "=", body["id"])]
        )
        self.assertEqual(remittance.state, "declared")

    def test_declaring_a_remittance_replays_on_the_same_idempotency_key(self):
        token, driver = self._make_driver_user("sub-remittance-controller-2")
        self.env["babana.cash.movement"].sudo().create(
            {"driver_id": driver.id, "movement_type": "collection", "amount": 1200}
        )

        first = self._post("/api/v1/remittances", token, {"amount": 1200}, idempotency_key="k1")
        second = self._post("/api/v1/remittances", token, {"amount": 1200}, idempotency_key="k1")

        self.assertEqual(first.json()["id"], second.json()["id"])
        self.assertEqual(
            self.env["babana.cash.remittance"].sudo().search_count([("driver_id", "=", driver.id)]),
            1,
            "une même clé d'idempotence ne doit jamais créer une seconde remise",
        )

    def test_declaring_a_remittance_without_a_positive_amount_is_rejected(self):
        token, _driver = self._make_driver_user("sub-remittance-controller-3")

        response = self._post("/api/v1/remittances", token, {"amount": 0})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "VALIDATION_ERROR")

    def test_declaring_a_remittance_as_an_unapproved_driver_is_rejected(self):
        from ..controllers.auth import _issue_access_token

        user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub="sub-remittance-controller-4",
            email="sub-remittance-controller-4@example.invalid",
            name="Chauffeur non approuvé",
            role="driver",
        )
        access_token, _ = _issue_access_token(user)

        response = self._post("/api/v1/remittances", access_token, {"amount": 1200})

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "DRIVER_NOT_APPROVED")
