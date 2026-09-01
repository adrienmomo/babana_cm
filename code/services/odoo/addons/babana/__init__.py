from . import services
from . import models
from . import controllers


def _pre_init_backfill_unique_defaults(env):
    """Remplit, colonne par colonne, les identifiants uniques posés par valeur par défaut sur des
    tables **déjà peuplées** à l'installation -- avant que `registry.load` ne pose les contraintes
    `_sql_constraints` (D52, amoa/01-architecture.md §9 quater).

    Le cas : `res.users.babana_public_id` a `default=lambda self: str(uuid.uuid4())`. Quand Odoo
    ajoute une colonne stockée avec `default` sur une table qui a déjà des lignes (les sept comptes
    système d'Odoo existent avant ce module), il la remplit par un `UPDATE ... SET col = <valeur>`
    où `<valeur>` est le `default` évalué **une seule fois** -- les sept comptes reçoivent le même
    UUID, et `unique(babana_public_id)` échoue alors à la création. Odoo journalise l'échec et
    poursuit : la table reste sans garantie d'unicité, et une contrainte qui échoue en silence
    ressemble exactement à une contrainte qui protège.

    `pre_init_hook` s'exécute uniquement à la première installation, après `registry.setup_models`
    et **avant** `registry.load` (donc avant `_add_sql_constraints`). On crée la colonne et on la
    remplit ici, ligne par ligne : `gen_random_uuid()` est volatile, PostgreSQL l'évalue par
    ligne, chaque compte reçoit donc un identifiant distinct. Odoo voit ensuite la colonne déjà
    présente et peuplée, ne rejoue pas son remplissage en une passe, et la contrainte se pose.

    Corollaire à garder en tête : tout futur `default` générant un identifiant unique sur une
    table peuplée à l'installation (aujourd'hui `res.partner` ne l'est pas pour
    `babana_google_sub`, mais c'est une coïncidence, pas une garantie) doit passer par ici. Le
    test `tests/test_sql_constraints_in_db.py` compare mécaniquement les contraintes déclarées à
    celles réellement présentes en base et attrapera l'oubli.
    """
    env.cr.execute(
        "ALTER TABLE res_users ADD COLUMN IF NOT EXISTS babana_public_id varchar"
    )
    env.cr.execute(
        "UPDATE res_users SET babana_public_id = gen_random_uuid()::text "
        "WHERE babana_public_id IS NULL"
    )
