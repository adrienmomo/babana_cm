# Tests de l'envoi push (L7-01) : cycle de vie du jeton d'appareil (babana.device.token) et
# service d'envoi (services/push.py). Le piège de la tâche est le cycle de vie -- un jeton périmé
# qui reste en base envoie dans le vide et ment sur une notification qu'on croit délivrée.
from __future__ import annotations

from unittest.mock import patch

from odoo.tests.common import TransactionCase, tagged

from ..services import push
from ..services.push import PushMessage, PushResult


def _msg():
    return PushMessage(title="Titre", body="Corps", data={"screen": "Proposal", "rideId": "r-1"})


@tagged("post_install", "-at_install")
class TestDeviceTokenLifecycle(TransactionCase):
    def setUp(self):
        super().setUp()
        self.Token = self.env["babana.device.token"]
        self.user_a = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub="push-a", email="push-a@example.invalid", name="A", role="client"
        )
        self.user_b = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub="push-b", email="push-b@example.invalid", name="B", role="client"
        )

    def _active(self, user):
        return self.Token._active_tokens_for_users(user)

    def test_a_user_can_carry_several_devices(self):
        self.Token._register_token(self.user_a, "tok-phone", "android")
        self.Token._register_token(self.user_a, "tok-tablet", "ios")

        self.assertEqual(set(self._active(self.user_a).mapped("token")), {"tok-phone", "tok-tablet"})

    def test_re_registering_the_same_pair_reactivates_without_duplicate(self):
        row = self.Token._register_token(self.user_a, "tok-1", "android")
        first_registered_at = row.registered_at
        row.write({"active": False})

        again = self.Token._register_token(self.user_a, "tok-1", "web")

        self.assertEqual(again, row)
        self.assertTrue(again.active)
        self.assertEqual(again.platform, "web")
        self.assertGreaterEqual(again.registered_at, first_registered_at)
        self.assertEqual(
            self.Token.with_context(active_test=False).search_count(
                [("user_id", "=", self.user_a.id), ("token", "=", "tok-1")]
            ),
            1,
        )

    def test_one_token_can_belong_to_several_accounts(self):
        # Un appareil réinstallé, ou partagé : le même jeton pour deux comptes -- deux lignes,
        # jamais un doublon silencieux ni une violation de contrainte.
        row_a = self.Token._register_token(self.user_a, "tok-shared", "android")
        row_b = self.Token._register_token(self.user_b, "tok-shared", "android")

        self.assertNotEqual(row_a, row_b)
        self.assertTrue(row_a.active and row_b.active)

    def test_active_tokens_exclude_deactivated_ones(self):
        self.Token._register_token(self.user_a, "live", "android")
        dead = self.Token._register_token(self.user_a, "dead", "android")
        dead.write({"active": False})

        self.assertEqual(self._active(self.user_a).mapped("token"), ["live"])

    def test_deactivate_tokens_hits_every_account_that_holds_it(self):
        # Un jeton d'enregistrement invalide l'est pour quiconque le porte (critère 2).
        self.Token._register_token(self.user_a, "tok-shared", "android")
        self.Token._register_token(self.user_b, "tok-shared", "android")
        self.Token._register_token(self.user_a, "tok-a-only", "android")

        self.Token._deactivate_tokens(["tok-shared"])

        self.assertEqual(self._active(self.user_a).mapped("token"), ["tok-a-only"])
        self.assertFalse(self._active(self.user_b))

    def test_deactivate_for_user_is_idempotent(self):
        self.Token._deactivate_for_user(self.user_a, "never-seen")  # ne lève pas
        self.Token._register_token(self.user_a, "tok-1", "android")
        self.Token._deactivate_for_user(self.user_a, "tok-1")
        self.Token._deactivate_for_user(self.user_a, "tok-1")

        self.assertFalse(self._active(self.user_a))


@tagged("post_install", "-at_install")
class TestPushDispatch(TransactionCase):
    def setUp(self):
        super().setUp()
        push.reset_provider_cache()
        push.drain_sent()
        self.Token = self.env["babana.device.token"]
        self.user = self.env["res.users"].sudo()._babana_find_or_create_from_google(
            sub="push-dispatch", email="push-dispatch@example.invalid", name="U", role="client"
        )

    def tearDown(self):
        push.reset_provider_cache()
        super().tearDown()

    def test_the_default_provider_is_the_simulator_no_firebase_needed(self):
        # Critère 4 : un parcours complet sans compte Firebase. Aucune variable d'environnement
        # posée dans les tests -> le simulateur.
        self.assertTrue(push.provider_is_simulated())
        self.assertIsInstance(push.get_provider(), push.ConsolePushProvider)

    def test_unknown_provider_name_fails_loudly(self):
        with patch.dict("os.environ", {"PUSH_PROVIDER": "carrier-pigeon"}):
            push.reset_provider_cache()
            with self.assertRaises(RuntimeError):
                push.get_provider()

    def test_fcm_provider_without_credentials_fails_loudly_never_falls_back(self):
        # D43 : non configuré, on échoue -- jamais un repli silencieux sur le simulateur ni sur
        # un vrai envoi inattendu.
        with patch.dict("os.environ", {"PUSH_PROVIDER": "fcm"}, clear=False):
            push.reset_provider_cache()
            with self.assertRaises(RuntimeError):
                push.get_provider()

    def test_console_provider_logs_and_reports_no_invalid_token(self):
        result = push.ConsolePushProvider().send(["a-token", "b-token"], _msg())

        self.assertEqual(result.sent, 2)
        self.assertEqual(result.invalid_tokens, ())
        self.assertEqual(len(push.recent_sent()), 1)

    def test_dispatch_sends_to_active_tokens_and_marks_them_used(self):
        r1 = self.Token._register_token(self.user, "tok-1", "android")
        r2 = self.Token._register_token(self.user, "tok-2", "ios")

        result = push.dispatch(self.env, (self.user.id,), _msg())

        self.assertEqual(result.sent, 2)
        self.assertTrue(r1.last_used_at and r2.last_used_at)
        self.assertEqual(len(push.recent_sent()), 1)

    def test_dispatch_with_no_token_sends_nothing(self):
        result = push.dispatch(self.env, (self.user.id,), _msg())
        self.assertEqual(result, PushResult(sent=0, invalid_tokens=()))

    def test_invalid_token_feedback_deactivates_only_that_token(self):
        # Critère 2 : le nettoyage se fait QUAND le fournisseur le signale.
        r_good = self.Token._register_token(self.user, "good", "android")
        r_bad = self.Token._register_token(self.user, "bad", "android")

        fake = _FakeProvider(invalid=("bad",))
        with patch.object(push, "get_provider", return_value=fake):
            push.dispatch(self.env, (self.user.id,), _msg())

        r_good.invalidate_recordset()
        r_bad.invalidate_recordset()
        self.assertTrue(r_good.active)
        self.assertFalse(r_bad.active)

    def test_notify_users_async_only_schedules_a_postcommit_hook(self):
        # Critère 3 : rien n'est envoyé pendant la transaction -- seulement au commit, et sur un
        # fil de fond. Critère 5 : un envoi lent/raté ne touche pas la transaction appelante.
        self.Token._register_token(self.user, "tok-1", "android")
        spawned = []
        with patch.object(push, "_spawn", side_effect=lambda *a: spawned.append(a)):
            push.notify_users_async(self.env, self.user, _msg())
            self.assertEqual(spawned, [], "aucun envoi avant le commit")
            self.env.cr.postcommit.run()

        self.assertEqual(len(spawned), 1)
        dbname, user_ids, message = spawned[0]
        self.assertEqual(user_ids, (self.user.id,))
        self.assertEqual(message.title, "Titre")

    def test_notify_users_async_ignores_an_empty_recipient_set(self):
        empty = self.env["res.users"].browse()
        with patch.object(push, "_spawn", side_effect=AssertionError("ne doit pas être appelé")):
            push.notify_users_async(self.env, empty, _msg())

    def test_the_background_send_swallows_every_failure(self):
        # Critère 5 : aucune exception ne remonte du fil de fond, quelle que soit la panne.
        with patch.object(push, "dispatch", side_effect=RuntimeError("Firebase indisponible")):
            push._run_in_new_cursor(self.env.cr.dbname, (self.user.id,), _msg())  # ne lève pas


class _FakeProvider:
    name = "console"

    def __init__(self, invalid=()):
        self._invalid = tuple(invalid)
        self.calls = []

    def send(self, tokens, message):
        self.calls.append((list(tokens), message))
        return PushResult(sent=len(tokens), invalid_tokens=self._invalid)
