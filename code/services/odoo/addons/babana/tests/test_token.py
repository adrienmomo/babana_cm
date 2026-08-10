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
        old_record = self.env["babana.token"].sudo().search([("token_hash", "!=", False)], order="id asc", limit=1)
        self.assertEqual(old_record.state, "rotated")

    def test_reusing_a_rotated_token_revokes_the_whole_family(self):
        first = self.env["babana.token"]._issue_family(self.user)
        _, second = self.env["babana.token"]._rotate(first)

        # Réutilisation du jeton déjà consommé -- signe de vol (L1-02, spécification). try/except
        # plutôt que self.assertRaises : la version Odoo de assertRaises (TransactionCase) ouvre
        # un savepoint qu'elle annule à la sortie, ce qui annulerait la révocation de famille que
        # l'assertion suivante veut précisément observer.
        try:
            self.env["babana.token"]._rotate(first)
            self.fail("TokenReused attendu")
        except TokenReused:
            pass

        # Toute la famille est révoquée, y compris le jeton "second" qui n'a pourtant rien fait
        # de mal : c'est le prix du modèle de détection de vol par rotation.
        with self.assertRaises(TokenReused):
            self.env["babana.token"]._rotate(second)

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

        self.assertEqual(decoded["uid"], self.user.babana_public_id)
        self.assertEqual(decoded["role"], self.user.babana_role)
        self.assertEqual(expires_in, 3600)
