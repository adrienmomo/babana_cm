from . import services
from . import models
from . import controllers

import logging

_logger = logging.getLogger(__name__)


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


# --------------------------------------------------------------------------------------------
# D53 -- plan comptable et devise (amoa/01-architecture.md §7)
# --------------------------------------------------------------------------------------------
#
# Jusqu'ici, deux choses arrivaient « gratuitement » avec les données de démonstration d'Odoo :
# le plan comptable générique (`generic_coa`) était chargé, et une société déjà pourvue
# d'écritures gardait la devise USD de la démo. `without_demo = all` (services/odoo/config/
# odoo.conf) supprime les deux -- il faut donc les reposer explicitement, et honnêtement :
#
#   1. babana charge lui-même `generic_coa`. Sans plan comptable, `account.move.post()` (la
#      pièce de remise de caisse, L5-05) n'a ni compte de change ni compte d'attente et
#      échoue. On ne réinvente pas un plan : on charge celui que la démo chargeait déjà, la
#      réserve « provisoire, à repointer sur SYSCOHADA avant le pilote » (05-prerequis §5)
#      reste entière.
#
#   2. La devise de la société est **exigée** en XAF, pas seulement souhaitée. Une fois la
#      base sans écriture (conséquence de `without_demo`), c'est possible sans contorsion ; le
#      hook lève si une écriture existe déjà, plutôt que de laisser le grand livre en USD
#      pendant que le contrôleur annonce « XAF » (controllers/quote.py, ride.py). Vérifié
#      mécaniquement par tests/test_currency_required.py, même famille que le test des
#      contraintes SQL de D52.
#
# Pourquoi un enchaînement de `_auto_install_template` plutôt qu'un simple `try_loading` ici :
# quand `account` s'installe sans plan sur la société, il programme le chargement de
# `generic_coa` pour la **fin** du chargement des modules (ir.module.module::_register_hook,
# via l'attribut de registre `_auto_install_template`). Ce chargement, sur une société sans
# écriture, **supprime d'abord tous les `account.account` / `account.journal` existants** puis
# pose ceux du modèle (account/models/chart_template.py::_load). Nos comptes babana, s'ils
# étaient créés par un XML `noupdate` ou par ce hook *avant* cet enchaînement, seraient donc
# détruits juste après -- c'est ce que faisait l'ancien data/accounting_config.xml sur une
# base fraîche sans démo (config_parameter pointant vers des ids supprimés). On se greffe
# donc APRÈS le chargement d'Odoo : il fait son ménage puis charge `generic_coa` sur une base
# vide, ensuite on ajoute les comptes babana par-dessus, ensuite on impose XAF.
# Voir code/docs/odoo-pitfalls.md.

_XAF_XMLID = "base.XAF"

# Comptes et journal de la remise de caisse (D8, L5-05). Repris tels quels de l'ancien
# data/accounting_config.xml : mêmes codes, mêmes libellés, mêmes clés de paramètre. La
# numérotation « famille OHADA classe 4 » reste purement indicative -- valeurs par défaut
# explicitement provisoires, repointées vers un vrai plan OHADA au pilote via les quatre
# ir.config_parameter, sans toucher au code (invariant 5).
_BABANA_ACCOUNTS = [
    {
        "xmlid": "babana_cash_remittance_cash_account",
        "name": "Caisse chauffeurs (babana)",
        "code": "57101",
        "account_type": "asset_cash",
        "param": "babana.cash_remittance_cash_account_id",
    },
    {
        "xmlid": "babana_cash_remittance_receivable_account",
        "name": "Créances sur les chauffeurs (babana)",
        "code": "42101",
        "account_type": "asset_receivable",
        "reconcile": True,
        "param": "babana.cash_remittance_receivable_account_id",
    },
    {
        # asset_receivable + reconcile : Odoo 18 refuse un compte de tiers non lettrable
        # ("You cannot have a receivable/payable account that is not reconcilable"). L'ancien
        # data/accounting_config.xml le posait non lettrable et passait -- la contrainte se
        # déclenche désormais par ce chemin de création. Un compte d'écart lettrable est de
        # toute façon correct : on le solde quand le chauffeur régularise (L5-06).
        "xmlid": "babana_cash_remittance_discrepancy_account",
        "name": "Écarts de caisse constatés (babana)",
        "code": "47101",
        "account_type": "asset_receivable",
        "reconcile": True,
        "param": "babana.cash_remittance_discrepancy_account_id",
    },
]
_BABANA_JOURNAL = {
    "xmlid": "babana_cash_remittance_journal",
    "name": "Caisse chauffeurs (babana)",
    "code": "BCAI",
    "type": "cash",
    "param": "babana.cash_remittance_journal_id",
}


def _post_init_currency_and_accounting(env):
    """post_init_hook : charge `generic_coa`, pose les comptes babana par-dessus, impose XAF.

    Ne tourne qu'à la première installation du module (Odoo n'exécute pas post_init_hook sur
    `-u`). Sur une base déjà installée, les comptes et la devise sont déjà en place ; un
    `make reset` est le chemin normal pour rejouer ce hook.
    """
    registry = env.registry

    def _finalise(env):
        _load_generic_coa_if_needed(env)
        _ensure_babana_accounting(env)
        _require_xaf_currency(env)

    if hasattr(registry, "_auto_install_template"):
        # `account` a programmé le chargement de generic_coa pour la fin du chargement des
        # modules -- on s'enchaîne juste après, pour que nos comptes ne soient pas emportés
        # par le ménage que ce chargement fait sur une base sans écriture.
        odoo_auto_install = registry._auto_install_template

        def _chained(env, _odoo_auto_install=odoo_auto_install):
            _odoo_auto_install(env)
            _finalise(env)

        registry._auto_install_template = _chained
    else:
        # `account` avait déjà un plan comptable sur la société (réinstallation du seul module
        # babana sur une base déjà comptable) : rien n'est programmé, on finalise tout de suite.
        _finalise(env)


def _load_generic_coa_if_needed(env):
    company = env.company or env.ref("base.main_company")
    if company.chart_template:
        return
    _logger.info("babana D53 : chargement du plan comptable generic_coa sur %s", company.name)
    env["account.chart.template"].try_loading("generic_coa", company, install_demo=False)


def _ensure_babana_accounting(env):
    company = env.company or env.ref("base.main_company")
    ModelData = env["ir.model.data"]
    Account = env["account.account"].with_company(company)
    Journal = env["account.journal"].with_company(company)
    Param = env["ir.config_parameter"]

    def _ref(xmlid):
        return env.ref("babana.%s" % xmlid, raise_if_not_found=False)

    for spec in _BABANA_ACCOUNTS:
        account = _ref(spec["xmlid"])
        if not account:
            account = Account.search([("code", "=", spec["code"])], limit=1) or Account.create(
                {
                    "name": spec["name"],
                    "code": spec["code"],
                    "account_type": spec["account_type"],
                    "reconcile": spec.get("reconcile", False),
                    "company_ids": [(6, 0, [company.id])],
                }
            )
            ModelData._update_xmlids([{
                "xml_id": "babana.%s" % spec["xmlid"],
                "record": account,
                "noupdate": True,
            }])
        Param.set_param(spec["param"], str(account.id))

    journal = _ref(_BABANA_JOURNAL["xmlid"])
    if not journal:
        journal = Journal.search([("code", "=", _BABANA_JOURNAL["code"])], limit=1) or Journal.create(
            {
                "name": _BABANA_JOURNAL["name"],
                "code": _BABANA_JOURNAL["code"],
                "type": _BABANA_JOURNAL["type"],
                "company_id": company.id,
                "default_account_id": _ref(_BABANA_ACCOUNTS[0]["xmlid"]).id,
            }
        )
        ModelData._update_xmlids([{
            "xml_id": "babana.%s" % _BABANA_JOURNAL["xmlid"],
            "record": journal,
            "noupdate": True,
        }])
    Param.set_param(_BABANA_JOURNAL["param"], str(journal.id))


def _require_xaf_currency(env):
    """La devise franc CFA est exigée à l'installation (D53), pas seulement souhaitée."""
    company = env.company or env.ref("base.main_company")
    xaf = env.ref(_XAF_XMLID)
    if not xaf.active:
        xaf.sudo().write({"active": True})
    if company.currency_id == xaf:
        return
    existing_moves = env["account.move"].sudo().search_count([("company_id", "=", company.id)])
    if existing_moves:
        raise ValueError(
            "D53 : impossible d'imposer la devise XAF -- la société %s porte déjà %d écriture(s) "
            "comptable(s). Une base qui arrive ici avec des écritures a chargé des données de "
            "démonstration (without_demo doit valoir `all`, services/odoo/config/odoo.conf) ou "
            "n'est pas fraîche (make reset)." % (company.name, existing_moves)
        )
    _logger.info("babana D53 : devise de la société %s -> XAF", company.name)
    company.sudo().write({"currency_id": xaf.id})
