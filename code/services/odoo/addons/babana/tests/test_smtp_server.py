# L4-06 (constat du 3 septembre, en vérifiant l'envoi de facture de bout en bout, Mailpit) :
# SMTP_HOST/PORT/USER/PASSWORD/FROM sont documentées et posées sur le conteneur depuis 2026
# (infra/compose.yaml, infra/env/README.md -- "pour l'envoi de facture") mais rien ne les
# traduisait en `ir.mail_server` : `mail.mail.send()` tombait sur le repli d'Odoo (localhost:25)
# et échouait en silence (failure_reason, jamais remonté à l'écran).
#
# Même famille que test_admin_password.py (D43) : rendre mécanique une vérification qu'aucune
# relecture de commentaire ne fait fiablement.
from __future__ import annotations

import os

from odoo.tests.common import TransactionCase, tagged


@tagged("post_install", "-at_install")
class TestSmtpServerAppliedAtInstall(TransactionCase):
    """Vérifie l'effet réel de _post_init_mail_server sur la base de test (SMTP_HOST est posée
    par infra/compose.dev.yaml -- mailpit -- la même variable que celle sous laquelle `-i babana`
    a tourné pour préparer cette base, make test, Makefile)."""

    def test_mail_server_matches_env_vars(self):
        expected_host = os.environ.get("SMTP_HOST")
        self.assertTrue(
            expected_host,
            "SMTP_HOST doit être présente dans l'environnement du conteneur odoo pour que ce "
            "test ait un sens -- infra/compose.dev.yaml la pose (mailpit).",
        )
        server = self.env["ir.mail_server"].sudo().search([("smtp_host", "=", expected_host)], limit=1)
        self.assertTrue(
            server,
            "aucun ir.mail_server ne porte SMTP_HOST -- _post_init_mail_server (__init__.py) "
            "est censé l'avoir posé à l'installation.",
        )
        self.assertEqual(server.smtp_port, int(os.environ.get("SMTP_PORT") or 25))

    def test_a_missing_smtp_host_does_not_block_installation(self):
        # Pas un nouveau post_init (déjà joué), juste la garantie que la fonction elle-même ne
        # lève pas sans hôte -- contrairement à _post_init_admin_password (D43, sans repli) : une
        # base de développement ou de CI sans relais doit s'installer, seulement sans envoyer de
        # courrier (infra/env/.env.example laisse SMTP_HOST vide par défaut, exprès).
        from odoo.addons.babana import _post_init_mail_server

        count_before = self.env["ir.mail_server"].sudo().search_count([])
        original = os.environ.pop("SMTP_HOST", None)
        try:
            _post_init_mail_server(self.env)
        finally:
            if original is not None:
                os.environ["SMTP_HOST"] = original
        self.assertEqual(self.env["ir.mail_server"].sudo().search_count([]), count_before)
