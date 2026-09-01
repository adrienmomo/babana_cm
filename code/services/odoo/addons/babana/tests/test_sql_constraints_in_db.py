# D52 (amoa/01-architecture.md §9 quater) : une contrainte déclarée n'est pas une contrainte
# posée. Deux fois -- le solde chauffeur (20 août, champ non stocké) puis l'identifiant public
# d'un utilisateur (J29, colonne à valeur par défaut sur table peuplée) -- une contrainte SQL
# déclarée dans le module n'existait pas en base : Odoo journalise l'échec de création et
# poursuit l'installation. Une contrainte qui échoue en silence ressemble exactement à une
# contrainte qui protège, et personne ne relit ce qui est déjà écrit.
#
# Ce test rend la vérification mécanique : pour chaque contrainte `_sql_constraints` que le
# module déclare (Odoo les reflète dans `ir.model.constraint`), il exige une entrée
# correspondante dans `pg_constraint`. Ajouter un `_sql_constraints` qui ne peut pas se poser
# fait échouer la suite -- même filet que les tests générés depuis des données (machine à états,
# habilitations).
from __future__ import annotations

from odoo.tests.common import TransactionCase, tagged
from odoo.tools import sql as sql_tools


@tagged("post_install", "-at_install")
class TestSqlConstraintsInDb(TransactionCase):
    def test_every_declared_sql_constraint_exists_in_db(self):
        module = self.env["ir.module.module"].search([("name", "=", "babana")], limit=1)
        self.assertTrue(module, "module babana introuvable dans ir.module.module")

        declared = self.env["ir.model.constraint"].search([("module", "=", module.id)])
        self.assertTrue(
            declared, "aucune contrainte reflétée pour le module -- le test ne prouverait rien"
        )

        checked = 0
        missing = []
        for constraint in declared:
            # `ir.model.constraint` trace aussi les clés étrangères des Many2one (definition
            # vide, nom déjà résolu) : hors sujet ici, on ne vérifie que les `_sql_constraints`
            # explicites du module, qui portent une `definition` (`unique(...)`, `check(...)`).
            if not constraint.definition or not constraint.model:
                continue
            checked += 1
            table = self.env[constraint.model.model]._table
            # `ir.model.constraint.name` est le nom non tronqué `{table}_{clé}` ; PostgreSQL le
            # limite à 63 caractères et Odoo applique alors `make_identifier` (préfixe + crc32).
            # On reconstruit le nom réel avec la fonction d'Odoo pour suivre son schéma.
            pg_name = sql_tools.make_identifier(constraint.name)
            self.env.cr.execute(
                """
                SELECT 1
                FROM pg_constraint
                WHERE conname = %s AND conrelid = %s::regclass
                """,
                (pg_name, table),
            )
            if not self.env.cr.fetchone():
                missing.append(
                    f"  - {constraint.name}  ({constraint.definition})  sur {table}"
                )

        # Garde-fou : si la réflexion changeait et ne renvoyait plus rien d'exploitable, le test
        # passerait à vide. Le module déclare aujourd'hui 19 contraintes `_sql_constraints`.
        self.assertGreaterEqual(
            checked,
            15,
            f"seulement {checked} contraintes vérifiées -- la source d'énumération a changé, "
            "ce test ne protège plus rien",
        )
        self.assertFalse(
            missing,
            "Contraintes déclarées par le module mais ABSENTES de pg_constraint -- elles ont "
            "échoué en silence à l'installation (D52) :\n" + "\n".join(missing),
        )
