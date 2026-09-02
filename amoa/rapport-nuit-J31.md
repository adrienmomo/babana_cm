# Rapport de nuit — J31

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition
de fini). Lu en entier : `CLAUDE.md`, `amoa/questions/REPONSES-2026-09-07.md`, la spécification
L8 (`amoa/specs/L8-securite.md`), les sections D52/D53 et §7/§9 quater de
`amoa/01-architecture.md`, le rapport J30.

Branche `J31-securite` (depuis `J30-demonstration`, non fusionnée). Un commit par tâche.

Périmètre confié :

1. **D53** — la devise franc CFA exigée à l'installation, et les données de démonstration
   d'Odoo qui ne s'installent plus.
2. **L8-01** — règles d'enregistrement des utilisateurs mobiles.
3. **L8-02** — matrice d'habilitation et tests générés.

---

## 1. D53 — devise exigée, données de démonstration retirées

### Ce que « sans données de démonstration » a réellement cassé

Le prompt demandait de vérifier ce que le retrait des données de démonstration casse. Réponse :
**tout le chaînage comptable de la remise de caisse (L5-05)**, de façon silencieuse.

Mécanisme. Quand `account` s'installe sur une société sans plan comptable, il **programme** le
chargement du plan générique `generic_coa` pour la toute fin du chargement des modules
(`ir.module.module._register_hook`, via l'attribut de registre `_auto_install_template`). Ce
chargement, sur une société **sans écriture** (`_existing_accounting()` faux), commence par
`unlink()` sur **tous** les `account.account` et `account.journal` existants, puis pose ceux du
modèle (`account/models/chart_template.py::_load`).

Avec les données de démonstration, invisible : la démo `account` chargeait `generic_coa` **et**
créait des écritures très tôt, donc quand babana posait ses trois comptes de remise (ancien
`data/accounting_config.xml`, `noupdate`) la société avait déjà plan + écritures, pas de
ménage. Sans démo : `account` s'installe sans plan → programme `generic_coa` → babana crée ses
comptes → fin du chargement → `_auto_install_template` supprime les comptes babana avec les
autres et charge `generic_coa`. Résultat sur une base réellement fraîche : les quatre
`ir.config_parameter` de la remise pointaient vers des ids supprimés, et **toute validation de
remise aurait échoué**. C'est le genre de défaut que seul un `make reset` révèle (CLAUDE.md,
« la base de développement est jetable »).

Documenté dans `code/docs/odoo-pitfalls.md` (nouvelle entrée).

### Le correctif — deux bouts

**a. `without_demo = all` dans `services/odoo/config/odoo.conf`.** Lu à la création de la base
(premier accès HTTP qui initialise `db_name`) comme à chaque `-i` : le seul endroit qui couvre
les deux chemins. Vérifié : plus aucune ligne `Module … : loading demo` à l'installation ;
`res_partner` passe de 162 à 6, `account_move` de 24 à 0.

**b. `post_init_hook` `_post_init_currency_and_accounting` (`addons/babana/__init__.py`).**
Il s'enchaîne à `registry._auto_install_template` : Odoo fait son ménage puis charge
`generic_coa` sur une base vide, **ensuite** le hook pose les comptes babana par-dessus,
**ensuite** impose la devise. `data/accounting_config.xml` est supprimé — les comptes, le
journal et les quatre paramètres sont désormais créés en Python (`_ensure_babana_accounting`),
mêmes codes (57101 / 42101 / 47101 / journal `BCAI`), mêmes clés de paramètre, xmlids
conservés (`ir.model.data._update_xmlids`).

Un seul changement de contenu forcé par Odoo 18 : le compte d'écart `47101`
(`asset_receivable`) devient **lettrable** (`reconcile=True`). Odoo 18 refuse « a
receivable/payable account that is not reconcilable » par ce chemin de création ; l'ancien XML
le posait non lettrable et passait. Un compte de tiers lettrable est de toute façon correct —
on le solde quand le chauffeur régularise (L5-06).

**c. La devise XAF est exigée**, pas seulement souhaitée (`_require_xaf_currency`). Le hook
active `base.XAF`, la pose sur la société, et **lève** si une écriture comptable existe déjà
(base non fraîche, ou données de démo chargées malgré le point a) plutôt que de laisser le
grand livre en USD pendant que le contrôleur annonce « XAF »
(`controllers/quote.py`, `ride.py`). Sur base fraîche sans démo : 0 écriture, la devise passe
à XAF sans contorsion (vérifié : `res_company.currency_id = XAF`, `chart_template = generic_coa`).

`services/odoo/scripts/seed.py::ensure_currency` ne pose plus la devise (le hook s'en charge) —
il **vérifie** et lève un `SystemExit` explicite si la base arrive en USD.

### Vérification mécanique — `tests/test_currency_required.py` (nouveau)

Même famille que `test_sql_constraints_in_db.py` (D52) : rendre mécanique une lecture qu'aucune
relecture ne fait fiablement. Quatre tests —

- devise de la société = `XAF`, active ;
- les champs `Monetary` de `babana.ride/quote/cash.movement/cash.remittance/cash.discrepancy/
  driver` ont pour devise par défaut celle de la société (XAF) ;
- `chart_template = generic_coa` chargé ;
- les quatre `ir.config_parameter` de la remise résolvent vers des enregistrements **vivants**
  (le garde-fou contre les ids pendants décrits plus haut).

Le `"currency": "XAF"` codé en dur dans les contrôleurs devient honnête par construction :
sans cette exigence, c'était une affirmation que rien ne garantissait.

### Fichiers

`code/services/odoo/config/odoo.conf` ; `code/services/odoo/addons/babana/__init__.py`,
`code/services/odoo/addons/babana/__manifest__.py` ;
`code/services/odoo/addons/babana/data/accounting_config.xml` (supprimé) ;
`code/services/odoo/addons/babana/models/babana_cash_remittance.py` (commentaire) ;
`code/services/odoo/addons/babana/tests/test_currency_required.py` (nouveau),
`code/services/odoo/addons/babana/tests/__init__.py` ;
`code/services/odoo/scripts/seed.py` ; `code/docs/odoo-pitfalls.md`.

---

## 2. L8-01 et 3. L8-02

_(entrées écrites avec le commit L8, qui suit celui-ci.)_

---

## 4. Passe finale

_(à compléter avec le commit L8.)_
