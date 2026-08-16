# Rapport de nuit — J11

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). `amoa/questions/REPONSES-2026-08-19.md` lu en entier avant d'ouvrir quoi que
ce soit. Deux corrections d'abord (D33, comparaison monétaire), puis le lot L5-03 à L5-07 dans
l'ordre, avec arrêt propre après L5-06 si le lot ne passe pas en entier — c'est la nuit où D29
devient réel.

---

## Corrections — D33 et comparaison monétaire (§2, §3 de REPONSES-2026-08-19.md)

**D33.** `action_settle` enregistrait l'appel sortant du contrôle de plafond
(`realtime_client.notify_cash_limit_reached`) depuis l'intérieur de son propre savepoint, en
appelant `babana.driver._babana_apply_cash_limit()` qui faisait les deux choses à la fois : écrire
`is_online=False` **et** enregistrer le rappel `cr.postcommit`. `cr.postcommit` ignore les
savepoints ; un rappel qui y est ajouté survit à l'annulation du savepoint dès lors que la
transaction englobante commite quand même — et ce dépôt le fait délibérément
(`_lock_for_update()`, pour renvoyer une erreur métier propre après un conflit).

Correctif : `_babana_apply_cash_limit()` ne fait plus que l'écriture Odoo (effet transactionnel,
reste dans le savepoint) et renvoie un booléen — le franchissement a-t-il eu lieu. `action_settle`
enregistre l'appel sortant **après la sortie réussie du savepoint**, à partir de ce booléen, jamais
depuis l'intérieur. `realtime_client.py` importé dans `babana_ride_state.py` (retiré de
`babana_driver.py`, devenu inutile là-bas).

Deux tests ajoutés à `test_settlement.py` : un contrôle positif (`notify_cash_limit_reached` est
bien appelé, avec le bon chauffeur, une fois le plafond franchi — jamais vérifié directement
jusqu'ici, seulement `is_online`) et un contrôle négatif qui simule le futur effet déjà planifié
pour rejoindre ce même savepoint (la facture, L4-06) : un effet qui échoue **après** le contrôle de
plafond, dans le même savepoint, ne doit laisser partir aucune notification. Aujourd'hui, rien ne
suit `_babana_apply_cash_limit()` à l'intérieur du savepoint — vérifié plutôt que supposé, donc le
test force artificiellement cette situation (`patch.object` sur `_babana_apply_cash_limit` pour lui
faire lever une erreur après avoir fait son écriture réelle) plutôt que d'attendre L4-06 pour le
prouver.

Ajouté aussi un test structurel (AST, `TestRealtimeCommitHookLint` dans
`test_realtime_commit_hook.py`, même classe que le lint D32 déjà en place) : aucun appel
`realtime_client.<fonction gated>` ne doit être lexicalement imbriqué dans un `with
...savepoint():`, dans les mêmes fichiers (`controllers/`, `models/`) que le lint D32 balaie déjà.
Limite assumée et documentée dans le test : c'est un balayage lexical, pas un graphe d'appels — il
n'aurait pas attrapé le défaut d'origine (le savepoint et l'appel gated vivaient dans deux fichiers
différents, reliés seulement par l'appel de méthode). La protection réelle contre une régression de
*ce* défaut précis est le test négatif ci-dessus ; le balayage AST est une seconde ligne de défense
contre la version la plus directe de l'erreur (un appel gated collé dans le même savepoint qui le
motive).

Entrée ajoutée à `code/docs/odoo-pitfalls.md` : « `cr.postcommit` ignore les savepoints », même
famille que les trois pièges déjà documentés.

**Comparaison monétaire.** `action_settle` comparait `amount_collected` à `expected_amount` par
égalité stricte de flottants. Remplacé par `self.currency_id.compare_amounts(amount_collected,
expected_amount) != 0` — la comparaison Odoo standard, à la précision de la devise. Pas un défaut
actif aujourd'hui (XAF sans sous-unité, montants déjà arrondis à l'unité), mais son mode de
défaillance était brutal : un montant qui porterait un jour une fraction aurait rendu l'encaissement
définitivement impossible pour la course concernée. Test ajouté : un montant qui diffère de l'attendu
par une fraction flottante infinitésimale (`1200.00000000001` contre `1200`) est accepté.

`make test` ciblé (`TestSettlement`, `TestRealtimeCommitHookLint`) contre la pile déjà en marche :
15 tests, 0 échec. Vérification complète sur base fraîche différée à la fin du lot L5 (voir
dernière section de ce rapport).

---
