# D43 (constat du 11 septembre, amoa/questions/REPONSES-2026-09-11.md §1 ;
# amoa/05-prerequis-et-simulation.md §4 ter) : trois nuits de vues back-office écrites, testées,
# jamais ouvertes -- le mot de passe administrateur décrit depuis le premier jour comme posé
# depuis une variable d'environnement n'avait jamais été construit, et `admin`/`admin` ne
# permettait de s'authentifier nulle part.
#
# Même famille que test_currency_required.py et test_sql_constraints_in_db.py : rendre
# mécanique une vérification qu'aucune relecture de commentaire ne fait fiablement.
from __future__ import annotations

import os
from unittest import mock

from odoo.addons.babana import _post_init_admin_password
from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestAdminPasswordAppliedAtInstall(TransactionCase):
    """Vérifie l'effet réel du post_init_hook sur la base de test (ADMIN_PASSWORD est posée par
    infra/compose.dev.yaml, la même variable que celle sous laquelle `-i babana` a tourné pour
    préparer cette base -- make test, Makefile)."""

    def test_admin_password_matches_env_var(self):
        expected = os.environ.get("ADMIN_PASSWORD")
        self.assertTrue(
            expected,
            "ADMIN_PASSWORD doit être présente dans l'environnement du conteneur odoo pour que "
            "ce test ait un sens -- infra/compose.dev.yaml la pose ; si elle manque, "
            "l'installation elle-même aurait dû échouer avant d'atteindre ce test.",
        )
        admin = self.env.ref("base.user_admin")
        self.env.cr.execute("SELECT password FROM res_users WHERE id=%s", [admin.id])
        [hashed] = self.env.cr.fetchone()
        valid, _ = self.env["res.users"]._crypt_context().verify_and_update(expected, hashed)
        self.assertTrue(
            valid,
            "le mot de passe du compte admin doit correspondre à ADMIN_PASSWORD -- "
            "_post_init_admin_password (__init__.py) est censé l'avoir posé à l'installation.",
        )

    def test_admin_password_is_no_longer_the_odoo_default(self):
        admin = self.env.ref("base.user_admin")
        self.env.cr.execute("SELECT password FROM res_users WHERE id=%s", [admin.id])
        [hashed] = self.env.cr.fetchone()
        valid, _ = self.env["res.users"]._crypt_context().verify_and_update("admin", hashed)
        self.assertFalse(
            valid,
            "un back-office en admin/admin derrière une liste d'adresses autorisées reste un "
            "back-office en admin/admin (05-prerequis-et-simulation.md §4 ter).",
        )

    def test_admin_user_belongs_to_babana_admin_group(self):
        # Constat J43 (D68) : un mot de passe qui fonctionne mais ouvre sur une erreur d'accès
        # au premier écran Babana n'est pas un compte opérationnel. Sur une base réellement
        # fraîche (pas seulement rejouée sur une base qui portait déjà ce groupe depuis des
        # semaines), c'était exactement le cas avant ce correctif.
        admin = self.env.ref("base.user_admin")
        self.assertTrue(
            admin.has_group("babana.group_babana_admin"),
            "_post_init_admin_password doit ajouter base.user_admin à Babana/Administrateur, "
            "sans quoi ADMIN_PASSWORD donne un mot de passe qui ouvre sur une erreur d'accès.",
        )


class TestAdminPasswordHookWithoutEnvVar(TransactionCase):
    """Teste directement la fonction du hook plutôt que son effet -- son autre branche (variable
    absente) ne peut pas s'observer après coup : si elle s'était produite, l'installation aurait
    échoué et cette suite ne tournerait pas."""

    def test_raises_without_admin_password(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ADMIN_PASSWORD", None)
            with self.assertRaises(ValueError):
                _post_init_admin_password(self.env)

    def test_does_not_touch_admin_user_when_it_raises(self):
        admin = self.env.ref("base.user_admin")
        self.env.cr.execute("SELECT password FROM res_users WHERE id=%s", [admin.id])
        [before] = self.env.cr.fetchone()
        was_in_group = admin.has_group("babana.group_babana_admin")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ADMIN_PASSWORD", None)
            with self.assertRaises(ValueError):
                _post_init_admin_password(self.env)
        self.env.cr.execute("SELECT password FROM res_users WHERE id=%s", [admin.id])
        [after] = self.env.cr.fetchone()
        self.assertEqual(before, after)
        # La levée intervient avant toute écriture (mot de passe ET groupe) -- l'appartenance
        # au groupe n'est pas non plus modifiée par un appel qui a échoué en amont.
        self.assertEqual(admin.has_group("babana.group_babana_admin"), was_in_group)
