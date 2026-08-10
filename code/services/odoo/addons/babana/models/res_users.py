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
    babana_role = fields.Selection(
        [("client", "Client"), ("driver", "Chauffeur")],
        string="Rôle babana",
        copy=False,
        help="Fixé une fois pour toutes à la création du compte (L1-01) ; un compte ne change "
        "jamais de rôle après coup.",
    )
    babana_driver_state = fields.Selection(
        [
            ("pending", "En attente"),
            ("approved", "Approuvé"),
            ("rejected", "Rejeté"),
            ("suspended", "Suspendu"),
        ],
        string="Statut chauffeur (champ-pont)",
        copy=False,
        help="Champ transitoire : babana.driver (L1-03) n'existe pas encore au moment de L1-01. "
        "L1-03 doit le remplacer par une délégation à babana.driver.state — ne pas construire "
        "de nouvelle logique dessus, il est appelé à disparaître (amoa/questions/L1-01.md).",
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

        Le rôle n'est significatif qu'à la création. Un compte déjà existant conserve son rôle
        d'origine quel que soit le `role` transmis à ce rappel — un compte ne change pas de
        nature après coup, à l'image de l'irréversibilité des transitions de `babana.ride`.
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
            "babana_role": role,
            "company_id": company.id,
            "company_ids": [(6, 0, [company.id])],
            # Aucun groupe métier (L0-02) : les droits passent exclusivement par les règles
            # d'enregistrement (L8-01). group_portal est l'idiome Odoo pour un compte qui
            # s'authentifie sans jamais accéder au back-office.
            "groups_id": [(6, 0, [portal_group.id])],
        }
        if role == "driver":
            vals["babana_driver_state"] = "pending"
        user = self.sudo().with_context(no_reset_password=True).create(vals)

        if role == "client":
            # res.users crée automatiquement son partner_id (mécanisme natif Odoo) ; L1-04
            # marque ce partenaire comme client babana et y reporte le sub Google, pour que le
            # client soit retrouvable depuis la facturation (account.move, L4-06) sans passer
            # par le compte de connexion.
            user.partner_id.sudo().write(
                {"babana_is_customer": True, "babana_google_sub": sub}
            )

        return user
