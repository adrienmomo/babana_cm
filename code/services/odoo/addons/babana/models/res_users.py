# Extension de res.users pour l'authentification Google (L1-01, D4).
from __future__ import annotations

import uuid

from odoo import api, fields, models


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
    def _babana_find_or_create_from_google(self, *, sub, email, name, role):
        """Retrouve un compte babana par `sub`, ou en crée un (L1-01, critères 1 et 6).

        Le rôle n'est plus stocké (L1-03R, `amoa/questions/L1-03R.md`) : il se lit désormais par
        l'existence d'un `babana.driver` rattaché (`_babana_role`), pas par une copie sur
        l'utilisateur. Un compte déjà existant conserve donc son rôle d'origine quel que soit le
        `role` transmis à ce rappel, sans qu'il faille rien figer explicitement à la création —
        un compte ne change pas de nature après coup, à l'image de l'irréversibilité des
        transitions de `babana.ride`.
        """
        existing = self.sudo().search([("google_sub", "=", sub)], limit=1)
        if existing:
            return existing

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
            # L1-01 demandait déjà de « créer ou rattacher le babana.driver ... correspondant » ;
            # resté en suspens tant que babana.driver n'existait pas (L1-03). Complété ici
            # (L1-03R) : voir amoa/questions/L1-03R.md pour la fiche hr.employee minimale créée
            # en même temps, faute d'un provisionnement RH préalable spécifié ailleurs.
            employee = self.env["hr.employee"].sudo().create({"name": vals["name"]})
            self.env["babana.driver"].sudo().create(
                {"employee_id": employee.id, "user_id": user.id}
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
