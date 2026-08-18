# Tests de babana.token (L1-02) : émission, rotation, révocation de famille sur réutilisation,
# révocation globale (suspension), et validation de l'accessToken sans appel à Odoo.
from __future__ import annotations

import os
from datetime import timedelta

import jwt

from odoo.fields import Datetime
from odoo.tests.common import TransactionCase, tagged

from ..models.babana_token import TokenExpired, TokenNotFound, TokenReused


@tagged("post_install", "-at_install")
class TestBabanaToken(TransactionCase):
    def setUp(self):
        super().setUp()
        self.user = (
            self.env["res.users"]
            .sudo()
            ._babana_find_or_create_from_google(
                sub="sub-token-test",
                email="token-test@example.invalid",
                name="Test Token",
                role="client",
            )
        )

    def test_rotate_produces_new_pair_and_invalidates_old(self):
        first = self.env["babana.token"]._issue_family(self.user)

        user, second = self.env["babana.token"]._rotate(first)

        self.assertEqual(user, self.user)
        self.assertNotEqual(first, second)
        # L'ancien jeton ne peut plus être utilisé : ce n'est pas un simple non-effet, c'est
        # exactement le scénario de réutilisation testé ci-dessous.
        # Recherche par le hachage de `first`, jamais par "le plus ancien id de la table" :
        # d'autres tests (test_auth.py, HttpCase, requêtes HTTP réelles donc commitées, pas
        # rollback comme TransactionCase) laissent des enregistrements babana.token antérieurs
        # dans la même base -- un tri par id global attrapait le mauvais enregistrement et ce
        # test échouait selon l'ordre d'exécution des suites. Défaut pré-existant, découvert en
        # vérifiant la suite sur base fraîche avant la session J14 (CLAUDE.md, "la base de
        # développement est jetable").
        old_record = self.env["babana.token"].sudo().search(
            [("token_hash", "=", self.env["babana.token"]._hash(first))]
        )
        self.assertEqual(old_record.state, "rotated")

    def test_reusing_a_rotated_token_revokes_the_whole_family(self):
        first = self.env["babana.token"]._issue_family(self.user)
        _, second = self.env["babana.token"]._rotate(first)

        # Réutilisation au-delà de la fenêtre de grâce (D36) -- une réutilisation immédiate, dans
        # la fenêtre, est désormais un rejeu légitime (voir les tests D36 plus bas), pas un vol.
        # flush_recordset() avant la relecture par _rotate() : un write() n'est pas garanti
        # poussé en base avant la requête SQL suivante dans la même transaction
        # (code/docs/odoo-pitfalls.md).
        rotated_record = self.env["babana.token"].sudo().search(
            [("token_hash", "=", self.env["babana.token"]._hash(first))]
        )
        rotated_record.write({"rotated_at": Datetime.now() - timedelta(hours=1)})
        rotated_record.flush_recordset(["rotated_at"])

        # try/except plutôt que self.assertRaises : la version Odoo de assertRaises
        # (TransactionCase) ouvre un savepoint qu'elle annule à la sortie, ce qui annulerait la
        # révocation de famille que l'assertion suivante veut précisément observer.
        try:
            self.env["babana.token"]._rotate(first)
            self.fail("TokenReused attendu")
        except TokenReused:
            pass

        # Toute la famille est révoquée, y compris le jeton "second" qui n'a pourtant rien fait
        # de mal : c'est le prix du modèle de détection de vol par rotation.
        with self.assertRaises(TokenReused):
            self.env["babana.token"]._rotate(second)

    # --- D36 : fenêtre de grâce sur la réutilisation -------------------------------------------

    def _set_grace_seconds(self, seconds: int) -> None:
        self.env["ir.config_parameter"].sudo().set_param(
            "babana.token_reuse_grace_seconds", str(seconds)
        )

    def test_reuse_within_the_grace_window_replays_the_same_pair(self):
        # Critère 3 bis, juste avant la borne : la fenêtre vaut 10 s, le jeton a été remplacé
        # voici 9 s -- toujours dans la fenêtre.
        self._set_grace_seconds(10)
        first = self.env["babana.token"]._issue_family(self.user)
        _, second = self.env["babana.token"]._rotate(first)
        rotated_record = self.env["babana.token"].sudo().search(
            [("token_hash", "=", self.env["babana.token"]._hash(first))]
        )
        rotated_record.write({"rotated_at": Datetime.now() - timedelta(seconds=9)})
        # flush_recordset() : un write() n'est pas garanti poussé en base avant la requête SQL
        # que _rotate() émet juste après (code/docs/odoo-pitfalls.md).
        rotated_record.flush_recordset(["rotated_at"])

        user, replayed = self.env["babana.token"]._rotate(first)

        self.assertEqual(user, self.user)
        # Le couple rejoué est celui déjà émis -- jamais un troisième jeton.
        self.assertEqual(replayed, second)
        self.assertEqual(rotated_record.state, "rotated")
        # "second" reste utilisable : aucune révocation ne s'est produite dans la fenêtre.
        self.env["babana.token"]._rotate(second)

    def test_reuse_past_the_grace_window_still_revokes_the_family(self):
        # Critère 3 bis, juste après la borne : la fenêtre vaut 10 s, le jeton a été remplacé
        # voici 11 s -- la fenêtre est dépassée, le comportement d'avant D36 reprend.
        self._set_grace_seconds(10)
        first = self.env["babana.token"]._issue_family(self.user)
        _, second = self.env["babana.token"]._rotate(first)
        rotated_record = self.env["babana.token"].sudo().search(
            [("token_hash", "=", self.env["babana.token"]._hash(first))]
        )
        rotated_record.write({"rotated_at": Datetime.now() - timedelta(seconds=11)})
        rotated_record.flush_recordset(["rotated_at"])

        # try/except plutôt que self.assertRaises : la version Odoo de assertRaises
        # (TransactionCase) ouvre un savepoint qu'elle annule à la sortie -- ça annulerait la
        # révocation de famille et l'effacement de next_token_ciphertext que les assertions suivantes
        # veulent précisément observer (même piège que
        # test_reusing_a_rotated_token_revokes_the_whole_family).
        try:
            self.env["babana.token"]._rotate(first)
            self.fail("TokenReused attendu")
        except TokenReused:
            pass

        # La famille entière est révoquée, "second" y compris -- même effet qu'une réutilisation
        # sans fenêtre de grâce (test_reusing_a_rotated_token_revokes_the_whole_family).
        with self.assertRaises(TokenReused):
            self.env["babana.token"]._rotate(second)
        # Le couple rejouable ne doit plus traîner en base une fois la fenêtre reconnue dépassée.
        self.assertFalse(rotated_record.next_token_ciphertext)

    # --- D37 : le remplaçant rejouable ne survit jamais en clair -------------------------------

    def test_next_token_is_never_stored_in_clear(self):
        # Critère 3 ter : lit la table, pas le champ par son nom -- sinon on ne prouve que
        # "le champ qu'on a choisi de lire est absent", pas que la valeur en clair n'existe
        # nulle part sur la ligne. C'est le test qui aurait échoué contre l'implémentation
        # d'avant D37 (amoa/questions/REPONSES-2026-08-23.md §1).
        first = self.env["babana.token"]._issue_family(self.user)
        _, second = self.env["babana.token"]._rotate(first)

        # flush_recordset() : un write() n'est pas garanti poussé en base avant la requête SQL
        # brute qui suit dans la même transaction (code/docs/odoo-pitfalls.md).
        rotated_record = self.env["babana.token"].sudo().search(
            [("token_hash", "=", self.env["babana.token"]._hash(first))]
        )
        rotated_record.flush_recordset(["token_hash", "next_token_ciphertext"])

        self.env.cr.execute(
            "SELECT token_hash, next_token_ciphertext FROM babana_token WHERE token_hash = %s",
            (self.env["babana.token"]._hash(first),),
        )
        token_hash, ciphertext = self.env.cr.fetchone()
        self.assertNotEqual(token_hash, second)
        self.assertIsNotNone(ciphertext)
        self.assertNotIn(second, ciphertext)

    def test_cron_purges_ciphertext_past_grace_window_even_if_nobody_returns(self):
        # Critère 3 quater, le cas normal : un client qui renouvelle et ne repasse jamais avec
        # l'ancien jeton -- personne ne déclenche jamais l'effacement en présentant `first` à
        # nouveau, seule la tâche périodique peut donc le faire.
        self._set_grace_seconds(10)
        first = self.env["babana.token"]._issue_family(self.user)
        self.env["babana.token"]._rotate(first)

        rotated_record = self.env["babana.token"].sudo().search(
            [("token_hash", "=", self.env["babana.token"]._hash(first))]
        )
        self.assertTrue(rotated_record.next_token_ciphertext)  # encore dans la fenêtre

        rotated_record.write({"rotated_at": Datetime.now() - timedelta(seconds=11)})
        rotated_record.flush_recordset(["rotated_at"])

        self.env["babana.token"]._cron_purge_expired_replay_ciphertext()

        self.assertFalse(rotated_record.next_token_ciphertext)

    def test_reusing_an_explicitly_revoked_token_ignores_the_grace_window(self):
        # Un jeton "revoked" (vol déjà détecté, suspension, déconnexion explicite) ne bénéficie
        # jamais de la fenêtre de grâce, même présenté immédiatement -- ce n'est pas le même
        # scénario qu'une rotation naturelle interrompue par le réseau.
        self._set_grace_seconds(3600)
        first = self.env["babana.token"]._issue_family(self.user)
        self.env["babana.token"]._revoke(first)

        with self.assertRaises(TokenReused):
            self.env["babana.token"]._rotate(first)

    def test_unknown_token_raises_not_found(self):
        with self.assertRaises(TokenNotFound):
            self.env["babana.token"]._rotate("ce-jeton-n-a-jamais-existe")

    def test_expired_token_raises_expired(self):
        raw = self.env["babana.token"]._issue_family(self.user)
        record = self.env["babana.token"].sudo().search([], order="id desc", limit=1)
        record.write({"expires_at": Datetime.now() - timedelta(days=1)})

        with self.assertRaises(TokenExpired):
            self.env["babana.token"]._rotate(raw)

    def test_revoke_all_for_user_invalidates_every_active_token(self):
        # Critère d'acceptation 4 : la suspension d'un chauffeur invalide ses jetons de
        # renouvellement. La suspension elle-même est L1-06 (hors de ce lot) ; ce test prouve
        # que le point d'entrée qu'elle appellera fonctionne.
        token_a = self.env["babana.token"]._issue_family(self.user)
        token_b = self.env["babana.token"]._issue_family(self.user)

        self.env["babana.token"]._revoke_all_for_user(self.user)

        with self.assertRaises(TokenReused):
            self.env["babana.token"]._rotate(token_a)
        with self.assertRaises(TokenReused):
            self.env["babana.token"]._rotate(token_b)

    def test_logout_revokes_only_that_token_not_the_family(self):
        first = self.env["babana.token"]._issue_family(self.user)
        _, second = self.env["babana.token"]._rotate(first)

        self.env["babana.token"]._revoke(second)

        # Une déconnexion volontaire ne doit pas se comporter comme une détection de vol : elle
        # ne révoque que le jeton concerné. (Ici la famille n'a plus de jeton actif de toute
        # façon puisque "first" est déjà "rotated" et "second" vient d'être "revoked" -- le test
        # vérifie que _revoke ne lève rien et ne touche que l'enregistrement ciblé.)
        record = self.env["babana.token"].sudo().search([("token_hash", "=", self.env["babana.token"]._hash(second))])
        self.assertEqual(record.state, "revoked")

    def test_access_token_is_verifiable_by_signature_alone(self):
        # Critère d'acceptation 5 : le service temps réel valide l'accessToken localement avec
        # le secret partagé, sans appel à Odoo. On le prouve en décodant sans toucher à
        # l'environnement Odoo au-delà de la lecture de la variable JWT_SECRET.
        from ..controllers.auth import _issue_access_token

        access_token, expires_in = _issue_access_token(self.user)
        decoded = jwt.decode(access_token, os.environ["JWT_SECRET"], algorithms=["HS256"])

        self.assertEqual(decoded["sub"], self.user.babana_public_id)
        self.assertEqual(decoded["role"], self.user._babana_role())
        self.assertNotIn("driverId", decoded)  # role == 'client' ici (D23)
        self.assertEqual(expires_in, 3600)

    def test_access_token_carries_driver_id_distinct_from_sub(self):
        # D23 : driverId est obligatoire sur un jeton chauffeur, et distinct de sub
        # (babana.driver.public_id contre res.users.babana_public_id) -- c'est exactement la
        # confusion que la nuit du 15 août a identifiée comme risque (amoa/questions/
        # REPONSES-2026-08-15.md §1).
        from ..controllers.auth import _issue_access_token

        driver_user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub="sub-token-driver-test",
            email="token-driver-test@example.invalid",
            name="Test Token Driver",
            role="driver",
        )
        access_token, _ = _issue_access_token(driver_user)
        decoded = jwt.decode(access_token, os.environ["JWT_SECRET"], algorithms=["HS256"])

        driver = driver_user._babana_driver()
        self.assertEqual(decoded["sub"], driver_user.babana_public_id)
        self.assertEqual(decoded["driverId"], driver.public_id)
        self.assertNotEqual(decoded["driverId"], decoded["sub"])
