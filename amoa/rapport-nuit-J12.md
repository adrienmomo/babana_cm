# Rapport de nuit — J12

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). `amoa/questions/REPONSES-2026-08-20.md` lu en entier avant d'ouvrir quoi que
ce soit — §1 de ce document est la correction la plus coûteuse de la semaine, arbitrée en D34.
Deux corrections d'abord (D34, l'endpoint manquant), puis la première pierre de L6 : abstraction
carte et navigation, connexion Google Sign-In. Pas d'écran métier cette nuit.

---

## D34 — la créance ne se solde qu'à hauteur du reçu

**Ce qui était faux.** `_babana_post_accounting_entry` (L5-05) créditait la créance chauffeur du
montant attendu **en entier** (`counted_amount + discrepancy_amount`), en reclassant l'écart sur
son propre compte à la même écriture. En comptabilité, un chauffeur qui remettait 40 000 sur
45 000 dus ne devait donc plus rien — alors que D29 et le compte courant (`babana.cash.movement`)
disaient encore 5 000 dus, et que ces 5 000 continuaient de peser sur son plafond. Deux systèmes
prétendant chacun dire la vérité, et la disant en sens opposé. La dérive se voyait à la remise
suivante : les 5 000 manquants remis, la créance créditée de 5 000 de plus, passage en **solde
créditeur** — les livres affirmant que l'entreprise devait de l'argent à un chauffeur qui lui en
devait.

**Le correctif** (`babana_cash_remittance.py`) :

- `_babana_post_accounting_entry` ne prend plus qu'un paramètre (`counted_amount`) et ne pose
  qu'**une seule paire** débit/crédit : caisse au débit, créance au crédit, pour le seul montant
  réellement compté. Aucune pièce du tout si `counted_amount` est nul (rien de reçu, rien à
  journaliser) — `move_id` reste alors vide, `action_validate` (déjà correct sur ce point) le
  gérait déjà pour le mouvement de compte courant, il fallait le même réflexe côté comptabilité.
- Nouvelle méthode `_babana_post_discrepancy_writeoff(amount)` : compte d'écart au débit, créance
  au crédit, pour le reliquat. Appelée **uniquement** depuis
  `babana_cash_discrepancy.py::action_close`, et seulement quand la décision n'est pas
  `left_on_balance` — c'est-à-dire seulement au moment où une décision humaine (ajustement,
  retenue) éteint réellement la dette. Le traitement par défaut de D29 (ne rien décider) ne pose
  toujours aucune écriture, exactement comme il ne pose toujours aucun mouvement de compte
  courant : ne rien décider, c'est laisser la dette où elle est, dans les deux systèmes à la fois.
- Nouveau champ `babana.cash.discrepancy.write_off_move_id`, symétrique de
  `adjustment_movement_id` : vide pour le défaut D29, référence la pièce d'extinction pour un
  traitement explicite. Ajouté à la vue formulaire à côté de son symétrique.

**Deux tests qui comptent, ajoutés à `test_remittance_accounting.py` :**

- `test_the_accounting_shortfall_matches_the_running_balance` — le reliquat non crédité en
  comptabilité (`expected_amount - credited`) égale exactement `driver.cash_balance` tant
  qu'aucune décision n'a été prise. Les deux systèmes se vérifient l'un l'autre au lieu de se
  contredire, comme le demande le critère 3 réécrit de L5-05.
- `test_two_successive_partial_remittances_never_leave_the_receivable_in_a_credit_balance` — le
  scénario exact de l'arbitrage : 45 000 dus, 40 000 remis, puis 5 000 remis. `driver.cash_balance`
  tombe à 0 après la seconde remise (jamais négatif), et le total réellement crédité sur le compte
  de créance (`account.move.line`, sommé sur les deux pièces) vaut 45 000, pas plus. La seconde
  remise nait avec `expected_amount = 5000` (le solde restant à l'instant de sa création), pas
  45 000 — gel déjà correct depuis L5-03, vérifié ici dans le nouveau contexte.

Complété par `test_the_validation_move_never_touches_the_discrepancy_account` (renommé et réécrit
depuis l'ancien `test_a_discrepancy_produces_a_distinct_line_on_the_discrepancy_account` : la
validation ne doit plus jamais produire de ligne sur le compte d'écart), et côté
`test_discrepancy.py`, `test_an_explicit_adjustment_writes_off_the_remaining_receivable` (la pièce
d'extinction existe, est postée, et le total crédité sur la créance atteint 45 000 une fois la
dette éteinte) et son contrôle négatif `test_the_default_treatment_posts_no_write_off_move`.

`make test` ciblé (`TestRemittanceAccounting`, `TestCashDiscrepancy`) contre la pile déjà en
marche : 24 tests, 0 échec. Vérification complète sur base fraîche en fin de session (voir
dernière section).

**Le plan comptable.** Rien à faire ici — l'arbitrage (comptes provisoires conservés, validation
par un comptable entrée dans les prérequis) a déjà été déposé la nuit dernière dans
`01-architecture.md` §7 et `05-prerequis-et-simulation.md` §5, avant le début de cette session.

---

## `GET /drivers/me/cash` — le trou signalé la nuit dernière

Le contrat C-01 (`settlement.ts`) prévoit l'endpoint depuis le début, mais aucune tâche du
découpage ne le demandait explicitement — signalé comme tel dans le rapport de J11
(`REPONSES-2026-08-20.md` §4). Pas de tâche dédiée dans `amoa/specs/` : décision d'implémentation
non spécifiée (nommage, emplacement), tranchée et avancée plutôt que bloquée, comme le permet
`CLAUDE.md`.

**Placé dans `controllers/driver.py`** (`DriverController`), à côté de `/drivers/me/availability`
plutôt que dans un fichier calqué sur le nom du contrat (`settlement.ts` porte aussi
`POST /rides/{id}/settle`, déjà dans `RideController`) — les deux routes `/drivers/me/*`
partagent l'authentification et le même contrôleur logique côté chauffeur. Route `GET`, pas de
`readonly=False` : cet endpoint ne modifie rien, le défaut d'Odoo 18 convient déjà.

**`balance` et `limit`** : lecture directe de `driver.cash_balance` / `driver.cash_limit`, déjà
calculés (L5-01, L5-02) — aucune règle nouvelle. **`collectedToday`** : nouvelle méthode
`babana_driver.py::_babana_cash_collected_today`, somme des mouvements `collection` du jour
(le seul type qui correspond à « courses réglées du jour », L5-07). `fields.Date.context_today`,
pas `fields.Date.today()` — cas explicitement réservé par `code/docs/odoo-pitfalls.md` : un
chauffeur qui regarde son écran dans son propre fuseau horaire, pas un cron ni une valeur par
défaut sans utilisateur connecté.

**Tests** (`test_driver_cash_controller.py`, nouveau, même patron que
`TestRemittanceController` — jeton réel via `_issue_access_token`, pas le parcours Google mock
complet) : solde/plafond/encaissé corrects sur plusieurs encaissements, une déclaration de remise
seule ne modifie pas l'encaissé du jour (seule la validation touche le compte courant, L5-04),
chauffeur non approuvé rejeté (`DRIVER_NOT_APPROVED`), jeton absent rejeté (`UNAUTHORIZED`),
forme de la réponse limitée aux trois champs du contrat. Module enregistré dans
`tests/__init__.py` (oublié une fois, corrigé en vérifiant que la suite ciblée trouvait bien les
tests — 0 test chargé silencieusement la première fois, jusqu'à l'ajout).

`make test` ciblé (`TestDriverCashController`) : 5 tests, 0 échec. `code/docs/contracts/
http-api.md` mis à jour : la mention « Non implémenté (L4-03) » en tête de la section Caisse
était stale depuis L4-05/L5-05 (le règlement de course est implémenté depuis longtemps) —
retirée.
