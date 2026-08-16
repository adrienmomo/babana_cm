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

## L5-03 — Modèle de remise de caisse

`babana.cash.remittance` (nouveau) : `reference` (séquence dédiée `babana.cash.remittance`,
préfixe `R%(year)s`, même patron que `babana.ride`), `public_id` (UUID, exposé à l'API mobile --
`CreateRemittanceResponseSchema` du contrat C-01 attendait déjà un `id` UUID), `driver_id`,
`expected_amount` (figé), `declared_amount`, `counted_amount`, `discrepancy_amount` (calculé),
`state`, `supervisor_id`, `declared_at`, `validated_at`, `discrepancy_reason`, `move_id`
(`account.move`, vide jusqu'à L5-05), `covered_movement_ids` (M2M vers `babana.cash.movement`),
`ride_ids` (calculé depuis `covered_movement_ids.ride_id`).

**Le gel se fait dans `create()`, pas dans une action dédiée.** `expected_amount` =
`driver._babana_cash_balance()` à l'instant de la création (pas le champ calculé `cash_balance`,
en cache -- même réflexe que `babana_cash_movement.py` l'applique déjà). `covered_movement_ids` =
les mouvements `collection` du chauffeur pas encore couverts par une remise précédente (recherche
`id not in <union des covered_movement_ids de toutes les remises existantes de ce chauffeur>`,
restreinte au type `collection` -- jamais aux mouvements `remittance` ou `adjustment`, qui ne
correspondent à aucune course). Cette restriction au type résout d'elle-même le risque qu'une
remise vienne un jour "couvrir" son propre mouvement de sortie ou celui d'une remise antérieure.

**`state` compte quatre valeurs (`draft`, `declared`, `validated`, `disputed`) mais `draft` n'est
jamais atteint par le chemin normal** : L5-04 (prochaine tâche) crée directement en `declared` via
`action_declare`. `draft` reste dans l'énumération pour respecter l'exhaustivité de la
spécification, documenté comme tel dans le `help` du champ -- pas un oubli.

**Immutabilité, deux formes distinctes.** `expected_amount` : jamais réécrit, à n'importe quel
état (`write()` lève dès que ce champ apparaît dans `vals`, inconditionnellement -- il ne s'agit
pas de protéger un état particulier, mais un fait déjà arrêté). Le reste des champs : bloqué
seulement une fois `state == 'validated'` (vérifié sur l'état AVANT l'écriture, donc la
transition elle-même vers `validated` passe -- même mécanisme que `babana_ride_state.py::write`).
`disputed` n'est délibérément pas bloqué : L5-06 doit encore pouvoir y référencer un traitement
d'écart après coup.

**Tests** (`test_remittance_model.py`, 7 cas, les transitions L5-04 n'existant pas encore --
création et écriture directes, comme `test_ride_state_machine.py` le faisait pour `babana.ride`
avant L4-02R) : gel du montant attendu malgré un encaissement postérieur, non-couverture d'une
course encaissée après coup, couverture explicite (une et deux courses), non-double-couverture
entre deux remises successives, écart nul avant validation puis calculé après, immutabilité
post-`validated`, et un contrôle négatif -- une remise `declared` reste modifiable (le
superviseur doit pouvoir y écrire `counted_amount`).

`make test` ciblé (`TestCashRemittanceModel`) : 7 tests, 0 échec.

---
