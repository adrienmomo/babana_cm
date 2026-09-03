# D53 (amoa/01-architecture.md §7) : la devise franc CFA est **exigée** à l'installation, pas
# seulement souhaitée -- et le plan comptable qui la portait via les données de démonstration
# est désormais chargé par le module lui-même (__init__.py::_post_init_currency_and_accounting).
#
# Même famille que test_sql_constraints_in_db.py : rendre mécanique une vérification qu'aucune
# relecture ne fait fiablement. Le `"currency": "XAF"` écrit en dur dans controllers/quote.py
# et controllers/ride.py n'est honnête que si la base garantit XAF ; ce test est cette
# garantie. Une base qui repasse en USD (données de démo réintroduites, société non fraîche)
# fait échouer la suite ici, pas en production devant un auditeur.
from __future__ import annotations

from odoo.tests.common import TransactionCase, tagged

_EXPECTED_CURRENCY = "XAF"

# Les modèles babana qui portent un montant, avec le paramètre minimal pour instancier une
# ligne (create ne pousse pas les contraintes @api.constrains tant qu'on ne flush pas).
_MONETARY_MODELS = [
    "babana.ride",
    "babana.quote",
    "babana.cash.movement",
    "babana.cash.remittance",
    "babana.cash.discrepancy",
    "babana.driver",
]

# Clés ir.config_parameter posées par le hook D53 : chacune doit résoudre vers un
# enregistrement réellement présent (le chargement de generic_coa en fin d'installation a
# longtemps supprimé ceux de l'ancien accounting_config.xml en laissant les clés pendantes).
_ACCOUNTING_PARAMS = [
    ("babana.cash_remittance_journal_id", "account.journal"),
    ("babana.cash_remittance_cash_account_id", "account.account"),
    ("babana.cash_remittance_receivable_account_id", "account.account"),
    ("babana.cash_remittance_discrepancy_account_id", "account.account"),
    ("babana.invoice_journal_id", "account.journal"),
    ("babana.invoice_income_account_id", "account.account"),
]


@tagged("post_install", "-at_install")
class TestCurrencyRequired(TransactionCase):
    def test_company_currency_is_xaf(self):
        currency = self.env.company.currency_id
        self.assertEqual(
            currency.name,
            _EXPECTED_CURRENCY,
            "D53 : la devise de la société doit être le franc CFA -- l'API annonce « XAF » en "
            "dur, le grand livre doit dire la même chose.",
        )
        self.assertTrue(currency.active, "la devise XAF de la société doit être active")

    def test_monetary_fields_default_to_the_company_currency(self):
        xaf = self.env.company.currency_id
        for model in _MONETARY_MODELS:
            field = self.env[model]._fields.get("currency_id")
            self.assertIsNotNone(field, "%s doit porter un champ currency_id" % model)
            default = field.default(self.env[model]) if field.default else None
            self.assertEqual(
                self.env["res.currency"].browse(default),
                xaf,
                "%s.currency_id doit défaut à la devise de la société (XAF), sinon un montant "
                "peut être libellé dans une autre monnaie que celle affichée (D53)." % model,
            )

    def test_generic_coa_is_loaded(self):
        # Sans données de démonstration, c'est le module babana qui charge le plan comptable :
        # s'il ne l'a pas fait, account.move.post() (remise de caisse, L5-05) n'a pas de quoi
        # s'équilibrer.
        self.assertEqual(
            self.env.company.chart_template,
            "generic_coa",
            "D53 : le plan comptable generic_coa doit être chargé sur la société",
        )

    def test_accounting_config_parameters_resolve_to_live_records(self):
        Param = self.env["ir.config_parameter"].sudo()
        for key, model in _ACCOUNTING_PARAMS:
            raw = Param.get_param(key)
            self.assertTrue(raw, "paramètre %s absent -- le hook D53 ne l'a pas posé" % key)
            record = self.env[model].browse(int(raw))
            self.assertTrue(
                record.exists(),
                "%s pointe vers %s#%s qui n'existe pas -- clé pendante laissée par le "
                "chargement de generic_coa (D53, code/docs/odoo-pitfalls.md)" % (key, model, raw),
            )
