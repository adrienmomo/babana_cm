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

## 2. L8-01 — règles d'enregistrement des utilisateurs mobiles

### Ce qui existait, et ce qui n'existait pas

Avant cette nuit : **aucun `ir.rule` pour les comptes mobiles, aucune ligne `ir.model.access`
pour `base.group_portal` sur un modèle babana.** Les contrôleurs authentifiés s'exécutent en
super-utilisateur (`controllers/_common.py::authenticated_user`, `request.env(user=SUPERUSER_ID)`),
et scopent leurs requêtes à la main (`ride.client_id == user.partner_id`). Les règles de cette
tâche sont donc de la **défense en profondeur** : elles filtrent les lignes pour tout accès qui
passerait par l'ORM au nom du mobile, et elles rendent la matrice L8-02 prouvable.

### Les règles posées (`security/babana_record_rules.xml`, nouveau)

Toutes des règles de **groupe** sur `base.group_portal` (`global` = False → combinées en OU),
`perm_read` seul.

| Modèle | Domaine |
|---|---|
| `babana.ride` | `client_id = user.partner_id` **OU** (`driver_id.user_id = user` ET `driver_id.state = approved`) |
| `babana.driver` | `user_id = user` ET `state = approved` — le chauffeur, sa seule fiche |
| `babana.driver.document` | `driver_id.user_id = user` ET `driver_id.state = approved` |
| `babana.motorcycle` | idem |
| `babana.cash.movement` | idem |
| `babana.cash.remittance` | idem |
| `res.partner` | `babana_reachable_by_current_driver = True` (s'ajoute en OU à la règle portail native qui donne déjà sa propre fiche) |
| `account.move` | **règle native d'Odoo** `account.account_invoice_rule_portal` — « ses factures » au client, rien au chauffeur |

`ir.model.access.csv` : six lignes `base.group_portal` ajoutées (`babana.ride`, `babana.driver`,
`babana.driver.document`, `babana.motorcycle`, `babana.cash.movement`, `babana.cash.remittance`),
**`perm_read` uniquement** — `1,0,0,0`. Aucune écriture directe pour un utilisateur mobile, nulle
part (critère 5). Tous les autres modèles babana : **aucune ligne portail** → un mobile ne peut
pas les lire du tout par l'ORM.

### La ligne la plus délicate : `res.partner` (critère 4)

« Le chauffeur doit joindre son passager pendant la course, et ne doit plus y accéder après. »
Le piège d'une règle écrite en deux conditions indépendantes (`state in (assigned,in_progress)`
d'un côté, `driver_id.user_id = me` de l'autre) : un chauffeur qui a **terminé** une course
avec le client A puis en a une **active** avec le client B verrait réapparaître A — chaque
condition est vraie, mais sur des courses différentes.

Corrigé par un champ `res.partner.babana_reachable_by_current_driver`, non stocké, avec méthode
`search` : le lookup part de `babana.ride` et lie les deux conditions à **une seule et même
course**. `sudo()` sur ce lookup (il alimente la règle, il ne doit pas être filtré par elle).
Testé par la positive **et** par la négative (course terminée → accès perdu immédiatement ;
client d'une course active d'un autre chauffeur → jamais joignable).

### Modèles standard hérités (critère 6)

`res.users`, `hr.employee` atteints par relation depuis une course : aucun accès portail →
`AccessError`. Testé (`test_no_leak_of_standard_models_through_relations`).

### Fichiers

`code/services/odoo/addons/babana/security/babana_record_rules.xml` (nouveau) ;
`code/services/odoo/addons/babana/security/ir.model.access.csv` ;
`code/services/odoo/addons/babana/models/res_partner.py` (champ + search) ;
`code/services/odoo/addons/babana/__manifest__.py`.

---

## 3. L8-02 — matrice d'habilitation et tests générés

### La matrice (`tests/fixtures/access_matrix.json`)

Pour chaque `rôle × modèle × opération` (read/write/create/unlink), le résultat attendu :
`own` (voit les siennes, jamais celles d'un autre) ou `none` (toute tentative lève
`AccessError`). **Les 18 modèles `babana.*`** y figurent, plus `account.move` et `res.partner`
au titre des modèles hérités exposés. write/create/unlink = `none` partout.

### Les tests (`tests/test_access_rights.py`, nouveau)

- **Générés** depuis la matrice : `setattr` d'une méthode `test_matrix__<modèle>__<rôle>__<op>`
  par cellule. Chaque test accède **au nom de l'utilisateur** (`with_user`), jamais en
  super-utilisateur avec un filtre (critère 3).
- `read` + `own` : l'utilisateur voit le sien **et ne voit pas celui d'un autre** (les deux) ;
  la lecture directe de « celui d'un autre » lève `AccessError`, pas seulement filtrée.
- `read` + `none` : soit aucun accès modèle, soit accès modèle mais règles cachant toute ligne
  (cas `account.move` pour un chauffeur).
- write/create/unlink + `none` : `has_access(op)` faux.
- **Filet contre l'oubli** (critère 2) : `test_matrix_covers_every_babana_model` compare
  `ir.model` (`babana.%`) à la matrice — un modèle nouveau non ajouté fait échouer la suite.
- **Six cas particuliers** (classe `TestAccessSpecialCases`) : chauffeur → partenaire client
  pendant puis après la course ; client → document chauffeur par relation ; chauffeur →
  modifier son solde ; chauffeur → valider sa propre remise ; mobile → écrire `state` sur une
  course ; lecture d'un modèle standard par relation.
- **4e propriété (J31)** : `test_suspended_or_rejected_driver_loses_access_immediately` — un
  chauffeur `approved` voit ses données ; passé à `suspended`, puis `rejected`, puis `pending`,
  il reçoit une **liste vide** (course, compte courant, documents) et `AccessError` sur sa
  propre fiche ; retour à `approved`, l'accès revient. Sans expiration de jeton.

### La règle que la matrice a le plus de mal à exprimer

**« Le chauffeur joint le client pendant la course, plus après. »**

C'est la seule ligne du tableau qui n'est ni `own` ni `none` : c'est un accès **fenêtré dans
le temps et lié à un état transitoire d'un autre modèle**. La matrice la note `own` pour
`res.partner / driver` (le chauffeur voit sa propre fiche, jamais une fiche arbitraire) et
délègue la partie fenêtrée à deux tests de cas particulier dédiés — parce qu'un tableau
`rôle × modèle × opération` n'a pas de colonne « et seulement tant que la course est active ».
Les trois autres propriétés du prompt (un chauffeur ne lit que ses courses, un client aucun
document chauffeur, personne le compte courant d'un autre) tiennent en une cellule ; celle-là
non. C'est là que je regarderais en premier une régression : un élargissement du domaine
`res.partner` (ou du champ `babana_reachable_by_current_driver`) passerait les tests `own` de
la matrice sans broncher — seuls `test_driver_reads_client_partner_during_ride_but_not_after`
et `test_driver_never_reaches_a_client_of_someone_elses_active_ride` l'attraperaient.

### Fichiers

`code/services/odoo/addons/babana/tests/fixtures/access_matrix.json` (nouveau) ;
`code/services/odoo/addons/babana/tests/test_access_rights.py` (nouveau) ;
`code/services/odoo/addons/babana/tests/__init__.py`.

---

## 4. Passe finale

Validation unitaire faite au fil de l'eau, sur bases jetables recréées à chaque fois
(`babana_t`, `babana_nodemo`) :

- **D53 sur base réellement fraîche sans démo** (`-i babana`, `without_demo` effectif) :
  `res_company.currency_id = XAF`, `chart_template = generic_coa`, `res_partner` 6 lignes
  (162 avec démo), `account_move` 0, les comptes `57101/42101/47101` + journal `BCAI`
  présents, les 4 `ir.config_parameter` résolus.
- **Suite babana complète** (`-i babana --test-enable --test-tags /babana` sur base fraîche
  sans démo) : **683 tests, 0 échec, 0 erreur** (612 à J30 + `test_currency_required` +
  la matrice L8-02 générée + cas particuliers).

`make reset` + `make seed` + `make test` complet + vérification visuelle des francs CFA
au back-office : **commit `amoa: passe finale J31` séparé** (rejoue tout le flux sur la
base de développement, qui est alors jetée et refaite).

Note : sur une installation `-i babana` réellement fraîche (sans `--test-tags`), quatre
tests **du cœur d'Odoo** échouent — `base.tests.test_configmanager` (×4),
`test_upgrade_code` (×2), `test_overrides.test_unlink` (×1). Ils ne touchent pas babana :
`test_configmanager` compare la configuration par défaut et bute sur le `odoo.conf`
personnalisé du dépôt (`addons_path`, `db_name`, `list_db`… présents avant J31) ;
`test_overrides.test_unlink` bute sur la surcharge `unlink()` de `babana.assignment`
(L1-08, avant J31). Aucun n'est une régression J31, et le flux `make test` documenté par
J30 (après `make seed`, seule la suite babana est rejouée) ne les exécute pas.

---

## Ce qui me laisse un doute pour quelqu'un de réel

1. **Les contrôleurs mobiles s'exécutent toujours en super-utilisateur.** Les règles L8-01 sont
   de la défense en profondeur : elles ne s'appliquent pas au chemin réel de l'API aujourd'hui
   (`authenticated_user()` renvoie un env `SUPERUSER_ID`). Elles deviennent la protection réelle
   le jour où un contrôleur fera `.with_user(user)` pour ses lectures — refactor hors périmètre
   J31. Les tests L8-02 prouvent l'isolement des règles, pas celui de l'API en production.

2. **`babana.driver` fermé au client par l'ORM.** La spécification L8-01 dit « champs publics
   des chauffeurs proches » pour le client ; je l'ai traduit par **aucun accès ORM** — la liste
   des chauffeurs proches est servie par le service temps réel (sudo), l'identité du chauffeur
   affecté par le contrôleur (sudo). C'est plus strict que le tableau, et cohérent avec « ne
   fais pas confiance aux droits d'accès seuls ». À valider : si un besoin ORM apparaît côté
   client, il faudra une règle `driver-de-ma-course` explicite (même patron que `res.partner`).

3. **`_auto_install_template` est un attribut privé du registre Odoo.** Le hook D53 s'y
   enchaîne. Si une version d'Odoo change ce mécanisme, `test_currency_required` et
   `test_remittance_accounting` échouent bruyamment sur base fraîche — le défaut est visible,
   pas silencieux. Mais c'est un point de couplage à connaître avant une montée de version.

4. **La devise n'est ré-imposée qu'à l'installation.** `post_init_hook` ne rejoue pas sur
   `-u babana` ni au redémarrage. Un changement manuel de devise après coup n'est rattrapé que
   par `test_currency_required` et par le garde-fou de `seed.py`. « Exigée à l'installation »
   au sens strict.
