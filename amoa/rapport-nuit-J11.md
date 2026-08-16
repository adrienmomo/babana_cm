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

## L5-04 — Validation de la remise

**`action_declare` et `action_validate`**, ajoutées à `babana_cash_remittance.py`. `action_declare`
crée directement à l'état `declared` (le gel vient de `create()`, L5-03). `action_validate`
compare `counted_amount` à `declared_amount` par `currency_id.compare_amounts` (même précision
que la correction D33/§3 de ce soir sur `action_settle`) : concordance -> `validated`, discordance
-> `disputed` -- **les deux produisent le même mouvement `remittance`**, de `-counted_amount`.
La discordance n'est pas un refus : c'est un signal à instruire (L5-06), pas un blocage.

**D29, concrètement.** Le mouvement ne porte jamais `expected_amount`, seulement
`counted_amount` -- une remise de 40 000 sur un solde de 45 000 laisse mécaniquement 5 000 au
compte courant, sans code dédié à ce cas : c'est la conséquence directe de ne journaliser que ce
qui a réellement été remis.

**Critère 2, vérifié par comparaison d'identité.** `self.driver_id.user_id == supervisor` --
un chauffeur qui possède aussi le groupe superviseur ne peut valider aucune remise dont il est le
chauffeur, quelle que soit la façon dont il est arrivé sur le formulaire.

**Critère 1, par les droits d'accès, pas par un contrôle explicite** -- même discipline que
`babana_driver.py::action_approve` : `action_validate`/`button_validate` appellent `write()` sans
`sudo()`, `ir.model.access.csv` n'ouvre l'écriture qu'à `group_babana_supervisor` et
`group_babana_admin`. **Trouvé en écrivant le test du critère 1** : `group_babana_supervisor`
seul ne suffit pas à lire `babana.driver` (aucune ligne ACL supervisor n'existait pour ce modèle)
ni les modèles de base (`res.currency`, pour `compare_amounts`) -- un vrai compte superviseur
porte toujours `base.group_user` (Utilisateur interne), attribué par l'écran "Utilisateurs"
d'Odoo, jamais par le seul groupe métier. Ligne ACL `access_babana_driver_supervisor` (lecture
seule, même forme que la ligne équivalente sur `babana.ride`) ajoutée pour combler le manque réel ;
`base.group_user` ajouté aux comptes de test pour refléter un compte réel.

**Déblocage, symétrique du blocage (L5-02).** `realtime_client.notify_cash_limit_cleared` (nouveau,
même patron D32/D33 que `notify_cash_limit_reached` : enregistrée au commit, jamais dans le
savepoint) appelle `POST /internal/drivers/cash-unblocked` (nouveau côté temps réel,
`http/internal.ts`) -- lève `cashBlockedKey` (`cash-guard.ts::unblockForCash`, exportée depuis
L5-02 spécifiquement pour cette tâche) et réintègre le chauffeur au pool s'il est par ailleurs
éligible (`reintegrateIfEligible`, même fonction que `clear_engagement`). Ne remet jamais
`is_online` à vrai -- le blocage retire une disponibilité, le lever n'en recrée pas une. Appelé
systématiquement en fin de validation dès lors que le nouveau solde repasse sous le plafond,
plutôt que de faire porter à la méthode un état "était-il bloqué avant ?" -- idempotent côté Redis
(DEL best-effort), donc sans coût réel sur un chauffeur qui n'était pas bloqué.

**Contrôleur** (`controllers/remittance.py`, `POST /remittances`) : même patron d'idempotence que
`RideController._dispatch` (clé `Idempotency-Key`, réponse rejouée plutôt que déclarer deux fois)
-- non prévu par le fichier de spécification lui-même, mais L5-07 (écran chauffeur) exige
explicitement ce rejeu et le réseau mobile est intermittent par hypothèse de travail (`CLAUDE.md`).
Statut public à trois valeurs (`pending`/`validated`/`rejected`, contrat C-01 déjà écrit avant ce
lot) mappé depuis les quatre états internes : `draft`/`declared` -> `pending`, `disputed` ->
`rejected`.

**Vue** (`views/babana_remittance_views.xml`) : `counted_amount` est un champ de formulaire
normal, modifiable tant que `declared` -- `button_validate()` ne prend donc aucun argument
(contrairement à `action_approve`/`action_reject` sur `babana.driver`, qui exigent un motif ou un
choix de fiche employé et donc un assistant). Bouton "Valider" visible seulement à l'état
`declared`, réservé à `group_babana_supervisor` par l'attribut `groups` -- redondant avec l'ACL,
volontairement (défense en profondeur).

**Piège rencontré : `tsx watch` n'a pas rechargé le service temps réel après l'ajout de la route.**
Le fichier modifié était bien visible dans le conteneur (montage bind), mais `curl` renvoyait
encore 404 sur `/internal/drivers/cash-unblocked` jusqu'à un redémarrage explicite du conteneur
(`docker compose restart realtime`) -- après quoi la route répondait. Cause non creusée plus loin
(watcher qui a raté un événement de montage bind sur ce système de fichiers plutôt qu'un défaut du
code) ; noté ici au cas où ça se reproduise plus tard dans la nuit : un 404 inattendu sur une route
tout juste ajoutée côté temps réel, vérifier d'abord qu'elle a vraiment rechargé avant de chercher
plus loin dans le code.

**Tests** (`test_remittance_validation.py`, 17 cas au total avec le contrôleur) : déclaration seule
ne touche pas le solde, montant non positif refusé, concordance/discordance, remise complète vs
partielle (le test D29 explicite), refus ACL pour un non-superviseur, refus pour le chauffeur qui
valide sa propre remise, déblocage effectif du plafond (`_check_online_eligibility()` ne renvoie
plus `CASH_LIMIT_REACHED`). Côté contrôleur : déclaration réussie, rejeu sur la même clé
d'idempotence (aucune seconde remise créée), montant invalide, chauffeur non approuvé. Côté canal
temps réel (`test_cash_limit.py`), symétrique des tests déjà écrits pour `notify_cash_limit_reached` :
la clé Redis tombe au commit, jamais au rollback.

`make test` ciblé (`TestRemittanceValidation`, `TestRemittanceController`,
`TestCashLimitRealtimeChannel`) : 17 tests, 0 échec. `npx tsc --noEmit` (`@babana/realtime`) :
propre.

**Vérification intermédiaire sur base fraîche.** `make reset && make up` puis `make test` complet :
suite Odoo (2156 tests, fresh) au vert, suite `@babana/realtime` avec un seul échec -- un test de
minuterie de grâce de déconnexion (`DisconnectGraceTimers`, L3-04) sans rapport avec ce lot,
reconfirmé vert isolément (`npx tsx --test test/availability.test.ts`, 7/7) : flakiness sous charge
(la machine faisait tourner la suite Odoo complète et un redémarrage Docker en parallèle), pas une
régression. La suite de concurrence (`@babana/concurrency-tests`, scénarios 1 à 3 de L4-11 plus le
critère 3 de L3-17) relancée séparément pour la même raison de timeout d'outil : 6/6, y compris le
scénario 3 (encaissement concurrent, débloqué la nuit dernière). Aucune trace des changements
L5-03/L5-04 dans ces deux suites -- elles n'ont pas de raison d'avoir bougé, vérifié plutôt que
supposé.

**Piège rencontré : `tsx watch` n'a pas rechargé le service temps réel après l'ajout de la route**
`/internal/drivers/cash-unblocked`. Le fichier modifié était bien visible dans le conteneur
(montage bind), mais `curl` renvoyait encore 404 jusqu'à un redémarrage explicite du conteneur
(`docker compose restart realtime`), après quoi la route répondait. Cause non creusée plus loin
(un événement de montage bind raté par le watcher, pas un défaut du code) ; noté au cas où ça se
reproduise : un 404 inattendu sur une route tout juste ajoutée côté temps réel, vérifier d'abord
qu'elle a vraiment rechargé avant de chercher plus loin dans le code.

---
