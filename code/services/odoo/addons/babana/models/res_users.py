# Extension de res.users pour l'authentification Google (L1-01, D4).
from __future__ import annotations

import uuid

from odoo import api, fields, models

# D45 (amoa/questions/REPONSES-2026-08-29.md §1) : sans ceci, tout compte hérite du fuseau par
# défaut d'Odoo (Europe/Brussels, donnée de démo) -- pour la base de données, chaque chauffeur de
# Douala habite Bruxelles, et toute fenêtre "aujourd'hui" calculée depuis son fuseau (context_today,
# babana_driver.py::_babana_cash_collected_today) se décale d'autant. Paramétrable (invariant 5) :
# le jour où le service dépasse le Cameroun, cette valeur doit changer sans toucher au code.
DEFAULT_ACCOUNT_TZ_PARAM = "babana.default_account_tz"
DEFAULT_ACCOUNT_TZ_FALLBACK = "Africa/Douala"


class ResUsers(models.Model):
    _inherit = "res.users"

    google_sub = fields.Char(
        string="Identifiant Google (sub)",
        index=True,
        copy=False,
        help="Identifiant stable de compte Google (claim 'sub'). Jamais l'email, qui peut "
        "changer côté Google sans que le compte babana ne bouge (L1-01, critère 6).",
    )
    babana_public_id = fields.Char(
        string="Identifiant public babana",
        index=True,
        copy=False,
        default=lambda self: str(uuid.uuid4()),
        help="Identifiant exposé aux apps mobiles (UserIdSchema, C-01) — jamais l'identifiant "
        "Odoo interne, séquentiel et devinable.",
    )
    _sql_constraints = [
        (
            "babana_google_sub_unique",
            "unique(google_sub)",
            "Ce compte Google est déjà rattaché à un autre utilisateur babana.",
        ),
        (
            "babana_public_id_unique",
            "unique(babana_public_id)",
            "Collision d'identifiant public babana — ne devrait jamais se produire (UUID).",
        ),
    ]

    @api.model
    def _babana_find_or_create_from_google(self, *, sub, email, name, role, ip_address=None):
        """Retrouve un compte babana par `sub`, ou en crée un (L1-01, critères 1 et 6).

        Le rôle n'est plus stocké (L1-03R, `amoa/questions/L1-03R.md`) : il se lit désormais par
        l'existence d'un `babana.driver` rattaché (`_babana_role`), pas par une copie sur
        l'utilisateur. Un compte déjà existant conserve donc son rôle d'origine quel que soit le
        `role` transmis à ce rappel, sans qu'il faille rien figer explicitement à la création —
        un compte ne change pas de nature après coup, à l'image de l'irréversibilité des
        transitions de `babana.ride`.

        `ip_address` (L1-01, critère 10) n'est utilisée que pour la limitation de débit sur la
        création d'une candidature chauffeur -- ignorée pour un compte existant ou un rôle client.
        """
        existing = self.sudo().search([("google_sub", "=", sub)], limit=1)
        if existing:
            return existing

        if role == "driver":
            # Avant toute écriture : un abus déjà commis (compte créé) n'a plus besoin d'être
            # bloqué, seule la prévention compte (L1-01, critère 10).
            self.env["babana.driver"]._check_candidacy_rate_limit(ip_address)

        portal_group = self.env.ref("base.group_portal")
        # self.env.company résout via self.env.user.company_id -- vide sous auth='none', qui
        # lie la requête à uid=None (ir_http._auth_method_none). base.main_company est résolu
        # par xmlid, indépendamment de l'utilisateur courant.
        company = self.env.ref("base.main_company")
        vals = {
            "name": name or email or "Utilisateur babana",
            "login": f"google:{sub}",
            "email": email,
            "google_sub": sub,
            "tz": self.env["ir.config_parameter"]
            .sudo()
            .get_param(DEFAULT_ACCOUNT_TZ_PARAM, DEFAULT_ACCOUNT_TZ_FALLBACK),
            "company_id": company.id,
            "company_ids": [(6, 0, [company.id])],
            # Aucun groupe métier (L0-02) : les droits passent exclusivement par les règles
            # d'enregistrement (L8-01). group_portal est l'idiome Odoo pour un compte qui
            # s'authentifie sans jamais accéder au back-office.
            "groups_id": [(6, 0, [portal_group.id])],
        }
        user = self.sudo().with_context(no_reset_password=True).create(vals)

        if role == "client":
            # res.users crée automatiquement son partner_id (mécanisme natif Odoo) ; L1-04
            # marque ce partenaire comme client babana et y reporte le sub Google, pour que le
            # client soit retrouvable depuis la facturation (account.move, L4-06) sans passer
            # par le compte de connexion.
            user.partner_id.sudo().write(
                {"babana_is_customer": True, "babana_google_sub": sub}
            )
        elif role == "driver":
            # L1-03R2 (correction du 13 août -- amoa/questions/REPONSES-2026-08-13.md) : un
            # sign-in chauffeur crée une candidature, jamais une fiche hr.employee -- la version
            # L1-03R de ce bloc créait les deux, ouvrant une porte de pollution RH et de spam
            # (n'importe quel compte Google avec role=driver faisait naître un employé). state
            # par défaut 'pending', employee_id vide : c'est L1-06 (hors de ce lot), la
            # validation du dossier par un gestionnaire, qui crée ou rattache la fiche RH --
            # seul endroit du système où cette écriture a désormais lieu.
            self.env["babana.driver"].sudo().create(
                {"user_id": user.id, "signup_ip_address": ip_address}
            )

        return user

    def _babana_role(self):
        """Rôle babana de ce compte -- dérivé, jamais stocké (L1-03R).

        Un `babana.driver` rattaché signale un compte chauffeur ; à défaut, un compte babana est
        toujours un compte client. Remplace le champ-pont `babana_role` de L1-01.
        """
        self.ensure_one()
        if self.env["babana.driver"].sudo().search_count([("user_id", "=", self.id)]):
            return "driver"
        return "client"

    def _babana_driver(self):
        """Fiche `babana.driver` rattachée à ce compte, vide si aucune (L1-03R)."""
        self.ensure_one()
        return self.env["babana.driver"].sudo().search([("user_id", "=", self.id)], limit=1)
