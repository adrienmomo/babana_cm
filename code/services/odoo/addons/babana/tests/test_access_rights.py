# L8-02 -- Tests d'habilitation des utilisateurs mobiles. GÉNÉRÉS depuis
# tests/fixtures/access_matrix.json (critère 1). Un modèle babana.* absent de la matrice fait
# échouer la suite (critère 2, test_matrix_covers_every_babana_model).
#
# Chaque test tente l'accès AU NOM de l'utilisateur concerné (`with_user`), jamais en
# super-utilisateur avec un filtre (critère 3) : un test qui contourne le mécanisme de
# sécurité ne teste pas la sécurité. Et pour chaque propriété on écrit la NÉGATIVE -- « il ne
# voit pas celles d'un autre », « il ne peut pas écrire » -- parce que c'est elle qui compte
# et c'est elle qu'une matrice fausse laisse passer en vert.
#
# CLAUDE.md place L8-01/L8-02 sous revue humaine obligatoire : la suite est dérivée de la
# matrice qu'elle vérifie, elle ne peut pas se contrôler elle-même. La matrice se relit à la
# main, ligne à ligne.
from __future__ import annotations

import json
import os
import uuid

from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.tests.common import TransactionCase, tagged

_MATRIX_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "access_matrix.json")

with open(_MATRIX_PATH, encoding="utf-8") as _fh:
    ACCESS_MATRIX = json.load(_fh)

OPERATIONS = ACCESS_MATRIX["operations"]  # ["read", "write", "create", "unlink"]
# models + inherited_models : les modèles Odoo standard exposés par héritage/relation sont
# testés au même titre (L8-01 critère 6).
MATRIX_MODELS = dict(ACCESS_MATRIX["models"])
MATRIX_MODELS.update(
    {k: v for k, v in ACCESS_MATRIX["inherited_models"].items() if not k.startswith("_")}
)


@tagged("post_install", "-at_install")
class TestAccessRights(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.env = cls.env(context=dict(cls.env.context, tracking_disable=True))
        portal = cls.env.ref("base.group_portal")

        def _portal_user(login_prefix):
            return cls.env["res.users"].create(
                {
                    "name": login_prefix,
                    "login": "%s-%s" % (login_prefix, uuid.uuid4()),
                    "email": "%s@example.invalid" % login_prefix,
                    "groups_id": [(6, 0, [portal.id])],
                }
            )

        # Deux clients, deux chauffeurs -- « mien » et « celui d'un autre » pour chaque test.
        cls.client_a = _portal_user("client-a")
        cls.client_b = _portal_user("client-b")
        cls.client_a.partner_id.write({"babana_is_customer": True})
        cls.client_b.partner_id.write({"babana_is_customer": True})

        cls.driver_user_a = _portal_user("driver-a")
        cls.driver_user_b = _portal_user("driver-b")
        cls.driver_a = cls.env["babana.driver"].create(
            {"user_id": cls.driver_user_a.id, "state": "approved",
             "employee_id": cls.env["hr.employee"].create({"name": "Chauffeur A"}).id}
        )
        cls.driver_b = cls.env["babana.driver"].create(
            {"user_id": cls.driver_user_b.id, "state": "approved",
             "employee_id": cls.env["hr.employee"].create({"name": "Chauffeur B"}).id}
        )

        cls.ride_a = cls._make_ride(cls.client_a, cls.driver_a, "in_progress")
        cls.ride_b = cls._make_ride(cls.client_b, cls.driver_b, "in_progress")

        # id_card plutôt que license : ce dernier exige une date d'expiration (L1-05), sans
        # rapport avec l'habilitation qu'on teste ici.
        cls.doc_a = cls.env["babana.driver.document"].create(
            {"driver_id": cls.driver_a.id, "document_type": "id_card",
             "storage_key": "seed/a/id.jpg", "mime_type": "image/jpeg"}
        )
        cls.doc_b = cls.env["babana.driver.document"].create(
            {"driver_id": cls.driver_b.id, "document_type": "id_card",
             "storage_key": "seed/b/id.jpg", "mime_type": "image/jpeg"}
        )

        cls.moto_a = cls.env["babana.motorcycle"].create(
            {"license_plate": "AA-111-AA", "driver_id": cls.driver_a.id}
        )
        cls.moto_b = cls.env["babana.motorcycle"].create(
            {"license_plate": "BB-222-BB", "driver_id": cls.driver_b.id}
        )

        cls.movement_a = cls.env["babana.cash.movement"].create(
            {"driver_id": cls.driver_a.id, "movement_type": "collection", "amount": 1000}
        )
        cls.movement_b = cls.env["babana.cash.movement"].create(
            {"driver_id": cls.driver_b.id, "movement_type": "collection", "amount": 1000}
        )

        cls.remittance_a = cls.env["babana.cash.remittance"].action_declare(
            driver=cls.driver_a, declared_amount=1000
        )
        cls.remittance_b = cls.env["babana.cash.remittance"].action_declare(
            driver=cls.driver_b, declared_amount=1000
        )

        cls.invoice_a = cls._make_invoice(cls.client_a.partner_id)
        cls.invoice_b = cls._make_invoice(cls.client_b.partner_id)

        cls.unrelated_partner = cls.env["res.partner"].create({"name": "Tiers sans lien"})

        # (modèle) -> (enregistrement « mien » pour A, enregistrement « d'un autre »)
        cls.records = {
            "babana.ride": (cls.ride_a, cls.ride_b),
            "babana.driver": (cls.driver_a, cls.driver_b),
            "babana.driver.document": (cls.doc_a, cls.doc_b),
            "babana.motorcycle": (cls.moto_a, cls.moto_b),
            "babana.cash.movement": (cls.movement_a, cls.movement_b),
            "babana.cash.remittance": (cls.remittance_a, cls.remittance_b),
            "account.move": (cls.invoice_a, cls.invoice_b),
        }
        # res.partner : « mien » dépend du rôle -> résolu dans le test.

    @classmethod
    def _make_ride(cls, client_user, driver, state):
        return (
            cls.env["babana.ride"]
            .with_context(babana_allow_state_write=True)
            .create(
                {
                    "client_id": client_user.partner_id.id,
                    "driver_id": driver.id,
                    "state": state,
                    "pickup_latitude": 4.0483,
                    "pickup_longitude": 9.7043,
                    "dropoff_latitude": 4.0611,
                    "dropoff_longitude": 9.7679,
                }
            )
        )

    @classmethod
    def _make_invoice(cls, partner):
        income = cls.env["account.account"].search(
            [("account_type", "=", "income")], limit=1
        )
        move = cls.env["account.move"].create(
            {
                "move_type": "out_invoice",
                "partner_id": partner.id,
                "invoice_line_ids": [
                    (0, 0, {"name": "Course", "quantity": 1, "price_unit": 700,
                            "account_id": income.id})
                ],
            }
        )
        move.action_post()
        move.message_subscribe(partner_ids=partner.ids)
        return move

    # ---------------------------------------------------------------------------------------
    # Helpers d'assertion -- toujours au nom de l'utilisateur
    # ---------------------------------------------------------------------------------------

    def _user_for_role(self, role):
        return {"client": self.client_a, "driver": self.driver_user_a}[role]

    def _mine_and_other(self, model, role):
        if model == "res.partner":
            mine = self._user_for_role(role).partner_id
            return mine, self.unrelated_partner
        return self.records[model]

    def _assert_no_model_access(self, model, user, operation):
        # write / create / unlink : aucun droit de modèle pour le portail, nulle part.
        Model = self.env[model].with_user(user)
        self.assertFalse(
            Model.has_access(operation),
            "%s : %s ne doit avoir AUCUN droit `%s` (matrice = none)"
            % (model, user.login, operation),
        )

    def _assert_reads_nothing(self, model, user):
        """`read` = none : soit aucun accès au modèle (AccessError), soit accès au modèle mais
        les règles cachent toute ligne pertinente (cas account.move pour un chauffeur)."""
        Model = self.env[model].with_user(user)
        try:
            Model.search([])
        except AccessError:
            return
        a, b = self.records.get(model, (Model.browse(), Model.browse()))
        self.assertFalse(
            Model.search([("id", "in", (a + b).ids)]),
            "%s : %s ne doit voir aucune ligne (matrice read=none)" % (model, user.login),
        )
        if a:
            with self.assertRaises(AccessError):
                a.with_user(user).read(["id"])

    def _assert_reads_own_only(self, model, user, mine, other):
        Model = self.env[model].with_user(user)
        visible = Model.search([("id", "in", (mine + other).ids)])
        self.assertIn(mine, visible, "%s : %s doit voir le sien" % (model, user.login))
        self.assertNotIn(
            other, visible,
            "%s : %s NE DOIT PAS voir celui d'un autre (c'est le test qui compte)"
            % (model, user.login),
        )
        # Lecture directe de « celui d'un autre » : refusée, pas seulement filtrée.
        with self.assertRaises(AccessError):
            other.with_user(user).read(["id"])

    def _assert_cannot_write(self, model, user, record):
        with self.assertRaises(AccessError):
            record.with_user(user).write(self._writable_vals(model))

    def _assert_cannot_create(self, model, user):
        with self.assertRaises(AccessError):
            self.env[model].with_user(user).create(self._writable_vals(model, for_create=True))

    def _assert_cannot_unlink(self, model, user, record):
        with self.assertRaises(AccessError):
            record.with_user(user).unlink()

    def _writable_vals(self, model, for_create=False):
        samples = {
            "babana.ride": {"pickup_label": "x"},
            "babana.driver": {"is_online": True},
            "babana.driver.document": {"rejection_reason": "x"},
            "babana.motorcycle": {"brand": "x"},
            "babana.cash.movement": {"reason": "x"},
            "babana.cash.remittance": {"declared_amount": 1},
            "res.partner": {"comment": "x"},
            "account.move": {"ref": "x"},
        }
        return dict(samples.get(model, {"name": "x"}))


def _make_matrix_test(model, role, op_index, expectation):
    operation = OPERATIONS[op_index]

    def test(self):
        user = self._user_for_role(role)
        if expectation == "none":
            if operation == "read":
                self._assert_reads_nothing(model, user)
            else:
                self._assert_no_model_access(model, user, operation)
            return
        # expectation == "own"
        if operation == "read":
            mine, other = self._mine_and_other(model, role)
            self._assert_reads_own_only(model, user, mine, other)
        elif operation == "write":
            mine, _ = self._mine_and_other(model, role)
            self._assert_cannot_write(model, user, mine)
        elif operation == "create":
            self._assert_cannot_create(model, user)
        elif operation == "unlink":
            mine, _ = self._mine_and_other(model, role)
            self._assert_cannot_unlink(model, user, mine)

    test.__name__ = "test_matrix__%s__%s__%s" % (
        model.replace(".", "_"), role, operation,
    )
    test.__doc__ = "matrice : %s / %s / %s attendu = %s" % (model, role, operation, expectation)
    return test


for _model, _roles in MATRIX_MODELS.items():
    for _role, _outcomes in _roles.items():
        for _i, _exp in enumerate(_outcomes):
            _t = _make_matrix_test(_model, _role, _i, _exp)
            setattr(TestAccessRights, _t.__name__, _t)


# -----------------------------------------------------------------------------------------
# Filet contre l'oubli (critère 2) + cas particuliers (critère 4) + 4e propriété (J31)
# -----------------------------------------------------------------------------------------

@tagged("post_install", "-at_install")
class TestAccessMatrixCompleteness(TransactionCase):
    def test_matrix_covers_every_babana_model(self):
        declared = set(
            self.env["ir.model"].search([("model", "=like", "babana.%")]).mapped("model")
        )
        covered = set(ACCESS_MATRIX["models"])
        missing = declared - covered
        stale = covered - declared
        self.assertFalse(
            missing,
            "Modèle(s) babana absent(s) de tests/fixtures/access_matrix.json -- un modèle "
            "nouveau échapperait au contrôle d'habilitation (L8-02 critère 2) : %s"
            % sorted(missing),
        )
        self.assertFalse(
            stale, "Modèle(s) dans la matrice qui n'existe(nt) plus : %s" % sorted(stale)
        )


@tagged("post_install", "-at_install")
class TestAccessSpecialCases(TransactionCase):
    """Les six cas particuliers de L8-02, plus la 4e propriété demandée à J31."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        portal = cls.env.ref("base.group_portal")

        def _portal_user(prefix):
            return cls.env["res.users"].create(
                {"name": prefix, "login": "%s-%s" % (prefix, uuid.uuid4()),
                 "email": "%s@example.invalid" % prefix, "groups_id": [(6, 0, [portal.id])]}
            )

        cls.client_user = _portal_user("sc-client")
        cls.other_client = _portal_user("sc-client-2")
        cls.client_user.partner_id.write({"babana_is_customer": True})
        cls.driver_user = _portal_user("sc-driver")
        cls.driver = cls.env["babana.driver"].create(
            {"user_id": cls.driver_user.id, "state": "approved",
             "employee_id": cls.env["hr.employee"].create({"name": "SC Chauffeur"}).id}
        )
        cls.ride = (
            cls.env["babana.ride"].with_context(babana_allow_state_write=True).create(
                {"client_id": cls.client_user.partner_id.id, "driver_id": cls.driver.id,
                 "state": "in_progress", "pickup_latitude": 4.05, "pickup_longitude": 9.70,
                 "dropoff_latitude": 4.06, "dropoff_longitude": 9.76}
            )
        )
        cls.doc = cls.env["babana.driver.document"].create(
            {"driver_id": cls.driver.id, "document_type": "id_card",
             "storage_key": "seed/sc/id.jpg", "mime_type": "image/jpeg"}
        )
        cls.movement = cls.env["babana.cash.movement"].create(
            {"driver_id": cls.driver.id, "movement_type": "collection", "amount": 1500}
        )
        cls.remittance = cls.env["babana.cash.remittance"].action_declare(
            driver=cls.driver, declared_amount=1500
        )

    # 1 -- Chauffeur tentant de lire le partenaire client APRÈS la fin de course --------------
    def test_driver_reads_client_partner_during_ride_but_not_after(self):
        partner = self.client_user.partner_id
        # Pendant la course (in_progress) : joignable.
        self.assertEqual(
            partner.with_user(self.driver_user).read(["id"])[0]["id"], partner.id
        )
        # La course se termine : l'accès disparaît immédiatement, sans rien toucher d'autre.
        self.ride.with_context(babana_allow_state_write=True).write({"state": "completed"})
        self.assertFalse(
            self.env["res.partner"].with_user(self.driver_user)
            .search([("id", "=", partner.id)])
        )
        with self.assertRaises(AccessError):
            partner.with_user(self.driver_user).read(["id"])

    def test_driver_never_reaches_a_client_of_someone_elses_active_ride(self):
        other_ride_client = self.other_client.partner_id
        self.env["babana.ride"].with_context(babana_allow_state_write=True).create(
            {"client_id": other_ride_client.id, "state": "requested",
             "pickup_latitude": 4.05, "pickup_longitude": 9.70,
             "dropoff_latitude": 4.06, "dropoff_longitude": 9.76}
        )
        self.assertFalse(
            self.env["res.partner"].with_user(self.driver_user)
            .search([("id", "=", other_ride_client.id)])
        )

    # 2 -- Client tentant de lire un document chauffeur par une relation ---------------------
    def test_client_cannot_read_driver_document_at_all(self):
        with self.assertRaises(AccessError):
            self.doc.with_user(self.client_user).read(["storage_key"])
        # ... ni par la relation depuis sa propre course.
        ride_as_client = self.ride.with_user(self.client_user)
        with self.assertRaises(AccessError):
            ride_as_client.mapped("driver_id.document_ids.storage_key")

    # Tableau L8-01 corrigé (8 sept.) -- « champs publics des chauffeurs proches » n'était pas
    # exprimable en règle d'enregistrement : les deux cellules `client` de `babana.driver` et
    # `babana.motorcycle` valent « aucun accès ORM ». La liste des chauffeurs proches est
    # servie par le service temps réel (liste blanche), l'identité du chauffeur affecté par le
    # contrôleur (liste blanche) -- jamais par l'ORM au nom du client.
    def test_client_has_no_orm_window_onto_drivers_or_motorcycles(self):
        Driver = self.env["babana.driver"].with_user(self.client_user)
        Motorcycle = self.env["babana.motorcycle"].with_user(self.client_user)
        moto = self.env["babana.motorcycle"].create(
            {"license_plate": "CC-333-CC", "driver_id": self.driver.id}
        )

        # Aucune ligne visible -- même celle du chauffeur de sa propre course active.
        self.assertFalse(Driver.search([("id", "=", self.driver.id)]))
        self.assertFalse(Motorcycle.search([("id", "=", moto.id)]))
        # Lecture directe : refusée, pas seulement filtrée.
        with self.assertRaises(AccessError):
            self.driver.with_user(self.client_user).read(["public_id"])
        with self.assertRaises(AccessError):
            moto.with_user(self.client_user).read(["license_plate"])
        # Ni par la relation depuis sa propre course.
        with self.assertRaises(AccessError):
            self.ride.with_user(self.client_user).mapped("driver_id.public_id")

    # 3 -- Chauffeur tentant de modifier son propre solde ----------------------------------
    def test_driver_cannot_touch_own_balance(self):
        # Un mouvement est immuable pour tout le monde (UserError, babana_cash_movement.write),
        # et le portail n'a de toute façon aucun droit d'écriture. AccessError hérite de
        # UserError -> assertRaises(UserError) couvre les deux (l'assertRaises d'Odoo n'accepte
        # pas un tuple d'exceptions).
        with self.assertRaises(UserError):
            self.movement.with_user(self.driver_user).write({"amount": 999999})
        # Et il ne peut pas non plus se créer un ajustement : aucun droit `create` portail.
        with self.assertRaises(AccessError):
            self.env["babana.cash.movement"].with_user(self.driver_user).create(
                {"driver_id": self.driver.id, "movement_type": "adjustment",
                 "amount": -100, "reason": "self-service"}
            )

    # 4 -- Chauffeur tentant de valider sa propre remise ----------------------------------
    def test_driver_cannot_validate_own_remittance(self):
        # Par l'ORM : pas de droit d'écriture portail sur babana.cash.remittance.
        with self.assertRaises(AccessError):
            self.remittance.with_user(self.driver_user).write({"counted_amount": 1500})
        # Par la méthode métier : refus explicite avant toute écriture (L5-04, critère 2).
        # AccessError hérite de UserError -> assertRaises(UserError) couvre les deux.
        with self.assertRaises(UserError):
            self.remittance.with_user(self.driver_user).action_validate(
                supervisor=self.driver_user, counted_amount=1500
            )

    # 5 -- Utilisateur mobile tentant d'écrire directement `state` sur une course ----------
    def test_mobile_user_cannot_write_state_on_a_ride(self):
        with self.assertRaises(AccessError):
            self.ride.with_user(self.client_user).write({"state": "cancelled"})
        with self.assertRaises(AccessError):
            self.ride.with_user(self.driver_user).write({"state": "completed"})

    # 6 -- Lecture d'un modèle standard par une relation non protégée ----------------------
    def test_no_leak_of_standard_models_through_relations(self):
        # hr.employee du chauffeur, atteint depuis la course du client : aucun accès portail.
        with self.assertRaises(AccessError):
            self.ride.with_user(self.client_user).mapped("driver_id.employee_id.name")
        # res.users du chauffeur, atteint depuis la course : idem.
        with self.assertRaises(AccessError):
            self.ride.with_user(self.client_user).mapped("driver_id.user_id.login")

    # 4e propriété (J31, révisée D55) -- une suspension empêche de TRAVAILLER, pas de VOIR ------
    def test_suspension_blocks_working_not_reading(self):
        """D55 (amoa/questions/REPONSES-2026-09-08.md §3). Avant : `state = 'approved'` figurait
        dans toutes les règles, si bien qu'un chauffeur suspendu -- ou en attente -- perdait la
        vue sur son compte courant, ses remises et la course qu'il était en train de faire.
        Retirer à un débiteur tout moyen de voir sa dette est le raisonnement de D29 retourné
        contre nous. Désormais la lecture de SES lignes reste, quel que soit l'état du dossier ;
        le blocage vit là où il doit, côté disponibilité."""
        Ride = self.env["babana.ride"]
        Movement = self.env["babana.cash.movement"]
        Doc = self.env["babana.driver.document"]
        Remittance = self.env["babana.cash.remittance"]
        remittance = self.remittance

        for state in ("suspended", "rejected", "pending", "approved"):
            self.driver.write({"state": state})

            # Il VOIT toujours ses propres lignes -- course en cours, compte courant, remises,
            # documents, et sa propre fiche.
            self.assertTrue(
                Ride.with_user(self.driver_user).search([("id", "=", self.ride.id)]),
                "état %s : le chauffeur ne voit plus sa course en cours" % state,
            )
            self.assertTrue(
                Movement.with_user(self.driver_user).search([("id", "=", self.movement.id)]),
                "état %s : le chauffeur ne voit plus son compte courant" % state,
            )
            self.assertTrue(
                Remittance.with_user(self.driver_user).search([("id", "=", remittance.id)]),
                "état %s : le chauffeur ne voit plus ses remises" % state,
            )
            self.assertTrue(
                Doc.with_user(self.driver_user).search([("id", "=", self.doc.id)]),
                "état %s : le chauffeur ne voit plus ses documents" % state,
            )
            self.assertEqual(
                self.driver.with_user(self.driver_user).read(["state"])[0]["state"], state
            )
            # ... mais jamais celles d'un autre : la règle reste « mes lignes ».
            self.assertFalse(
                Movement.with_user(self.driver_user).search(
                    [("driver_id", "!=", self.driver.id)]
                ),
                "état %s : le chauffeur voit le compte courant d'un autre" % state,
            )

        # En revanche, hors de l'état 'approved', il ne peut pas TRAVAILLER : passer en ligne
        # est refusé, motif distinct (L3-04) et contrainte du modèle.
        for blocked_state in ("suspended", "rejected", "pending"):
            self.driver.write({"state": blocked_state})
            self.assertEqual(
                self.driver._check_online_eligibility()[0],
                "DRIVER_NOT_APPROVED",
                "état %s : le chauffeur pourrait passer en ligne" % blocked_state,
            )
            with self.assertRaises(ValidationError):
                self.driver.write({"is_online": True})

        self.driver.write({"state": "approved"})
