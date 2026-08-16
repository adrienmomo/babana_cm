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

## L5-05 — Écriture comptable

**`account.move` natif, pas de modèle maison** (`01-architecture.md` §6) -- numérotation légale,
PDF et envoi par email acquis sans code supplémentaire.

**Le plan comptable de démonstration n'est pas OHADA.** Vérifié avant d'écrire quoi que ce soit
(`env["res.company"].chart_template`) : la base installe le plan générique d'Odoo
(`generic_coa`, comptes numérotés à l'anglaise), pas le plan OHADA en usage au Cameroun. Plutôt que
de prêter un rôle détourné à un compte générique existant (`121000`, déjà la créance client
standard) ou d'inventer de faux codes OHADA, `data/accounting_config.xml` pose trois comptes et un
journal propres au module -- valeurs par défaut explicitement provisoires, même réserve que
`CASH_LIMIT_FALLBACK` (`babana_driver.py`, "à confirmer en pilote"). Numérotation dans la famille
OHADA classe 4 (comptes de tiers) à titre indicatif, pas une prétention d'exactitude. Les quatre
comptes/journal sont ensuite lus par `ir.config_parameter` (invariant 5) -- un administrateur qui
installe un vrai plan OHADA au pilote repointe les quatre paramètres, sans toucher au code.

Le compte de caisse est un enregistrement XML explicite plutôt que le `default_account_id`
auto-provisionné par la création d'un journal `type='cash'` : vérifié en écrivant cette tâche
(`odoo shell`) qu'Odoo en crée bien un automatiquement, mais son xmlid n'est pas prévisible depuis
un fichier de données statique -- même compte réel, juste une référence stable pour y pointer.

**Deux paires débit/crédit distinctes**, jamais fusionnées : la caisse (`compte de caisse` /
`compte de créance`) pour `counted_amount`, et si l'écart est non nul, une seconde paire
(`compte d'écart` / `compte de créance`) pour la différence -- critère 3, "un écart absorbé dans le
montant principal est invisible au contrôle". La créance sur ce chauffeur est donc soldée en
comptabilité pour le montant attendu EN ENTIER (les deux paires s'additionnent), l'écart reclassé
sur son propre compte de suivi plutôt que laissé tel quel sur la créance générale. **Ceci ne
contredit pas D29** : le compte courant Odoo (`babana.cash.movement`, source réelle du plafond)
reste un système distinct, qui continue de porter l'écart au débit du chauffeur -- deux systèmes,
deux vérités compatibles, pas une seule redondante. Aucune ligne à montant nul : une remise sans
écart ne pose pas de paire écart, une remise entièrement en écart (`counted_amount` nul) ne pose
pas de paire caisse.

**Piège évité en écrivant `action_validate`** (retouché cette nuit) : la pièce comptable doit être
créée *avant* le `write()` qui pose `state='validated'`, jamais après dans un second `write()` --
l'immutabilité post-validation (critère 4 de L5-03) aurait sinon bloqué ce second appel, y compris
depuis l'intérieur de la même méthode. `move_id` part donc dans le même `write()` que la
transition, le montant de l'écart est calculé en Python (`expected_amount - counted_amount`)
plutôt que lu sur `discrepancy_amount` (champ calculé, qui ne refléterait le nouveau
`counted_amount` qu'après ce même `write()`). Trouvé en écrivant le test d'atomicité, pas en
production -- mais c'est exactement la classe de défaut que L4-05/D33 vient de documenter cette
nuit dans `odoo-pitfalls.md`, un cousin de la même famille.

**Immutabilité, vérifiée plutôt que supposée.** Une pièce postée refuse `unlink()`
(`UserError` natif d'Odoo) mais **accepte `write()` sur des champs non financiers** (`ref`,
`narration`) -- constaté en écrivant le test, pas un défaut de ce lot : Odoo protège les lignes
comptables (débit/crédit/compte), pas les champs de métadonnées. Le critère 5 ("annuler une pièce
validée est impossible sans passer par un mécanisme d'extourne tracé") est vérifié sur
`_reverse_moves()` (natif) plutôt que sur un blocage total de `write()`, qui n'existe pas et
n'aurait pas de sens à ajouter -- une pièce dont on ne pourrait plus jamais corriger le libellé ne
serait pas plus sûre, seulement plus pénible.

**Tests** (`test_remittance_accounting.py`, 8 cas) : pièce équilibrée, référence mutuelle
(`move.ref == remittance.reference`, `remittance.move_id == move`), écart sur son propre compte
avec le bon montant (scénario D29 : 45 000 dus, 40 000 remis, 5 000 en écart), absence de ligne
d'écart sur une remise complète, comptes/journal effectivement lus depuis la configuration (testé
en la changeant), configuration manquante bloque la validation sans rien appliquer (atomicité),
suppression directe refusée, extourne tracée qui fonctionne.

`make test` ciblé (`TestRemittanceAccounting`) : 8 tests, 0 échec. Suite complète relancée après
(`TestRemittanceValidation`, `TestRemittanceController`, `TestCashRemittanceModel`,
`TestCashLimitRealtimeChannel`, `TestSettlement`) : 33 tests, 0 échec -- aucune régression de la
restructuration d'`action_validate`.

---

## L5-06 — Traitement des écarts

**C'est ici que D29 devient réel.** Jusqu'à cette tâche, le compte courant *permettait* qu'un
écart reste au solde (rien ne l'empêchait) ; `action_validate` (L5-04) le *produit* mécaniquement
depuis hier soir (le mouvement `remittance` ne porte que `counted_amount`) ; cette tâche le rend
*visible* : `babana.cash.discrepancy`, créé systématiquement dans le même savepoint que la
validation dès que `discrepancy_amount` est non nul (critère 1).

**`amount` toujours positif, `direction` porte le sens.** Dans ce lot, `direction` vaut toujours
`shortfall` : une remise ne peut jamais dépasser le solde attendu (le mouvement `remittance`
correspondant serait refusé par la contrainte de L5-01, critère 4), donc `counted_amount` ne
dépasse jamais `expected_amount`. Le champ reste générique pour un mécanisme futur qui produirait
un excédent -- documenté comme non atteignable aujourd'hui plutôt que supprimé.

**Traitement par défaut vs. traitements explicites, séparés au niveau du mouvement.**
`left_on_balance` (le défaut, D29) ne crée **aucun** mouvement supplémentaire : l'écart pèse déjà
sur le solde du chauffeur par construction (le mouvement de la validation ne portait que le
montant compté), rien à journaliser de plus. `adjustment` et `withheld` (décisions humaines
explicites, jamais le comportement par défaut) créent chacun un mouvement `adjustment` de
`-amount`, tracé par un nouveau champ `babana.cash.movement.discrepancy_id` (critère 3) -- la
différence entre les deux décisions n'est pas mécanique, seulement le motif consigné pour
l'audit ; les deux ramènent le solde au même endroit.

**Alerte, deux mécanismes indépendants, l'un ou l'autre suffit.** Seuil cumulé (critère 4) et
seuil de série (critère 5) sur une fenêtre glissante, les trois paramétrables
(`babana.cash_discrepancy_alert_window_days`, `..._amount_threshold`, `..._series_count`,
invariant 5) : un montant cumulé qui dépasse le seuil déclenche l'alerte même pour un écart
unique déjà important ; un nombre d'écarts qui atteint le seuil de série la déclenche même si
chacun est trop petit pour jamais franchir le premier seuil seul -- "une série de petits écarts
qui ne cumulerait jamais assez" est exactement le détournement progressif que la spécification
demande de détecter. Vérifié au fil de l'eau, à la création de chaque écart (`create()`
surchargé), pas en cron différé -- un détournement en cours ne doit pas attendre le lendemain.
`driver.message_post` (chatter, `mail.thread` déjà hérité par `babana.driver`) plutôt qu'un champ
dédié -- visible immédiatement en back-office sans écran supplémentaire.

**Critère 2, deux couches.** `action_close` refuse une clôture sans `reason_category`, et une
contrainte `@api.constrains` refuse indépendamment `reason_category == 'other'` sans commentaire
-- la même règle vérifiée à deux endroits (l'action et le modèle) pour qu'une écriture directe au
back-office (hors du bouton) ne puisse pas la contourner.

**Vue back-office ajoutée bien que non listée dans les fichiers de la tâche** (`views/
babana_discrepancy_views.xml`) : la spécification la demande explicitement ("vue back-office
listant les écarts en attente, triés par ancienneté"), coût marginal, même patron que
`babana_remittance_views.xml` (`decision`/`reason_category`/`reason_comment` sont des champs de
formulaire, `button_close()` sans argument).

**Tests** (`test_discrepancy.py`, 11 cas) : création systématique sur écart non nul, absence sur
remise complète, reliquat au solde (critère 1 bis, le scénario 45 000/40 000/5 000 explicitement
demandé par la nuit), clôture refusée sans motif et sans commentaire pour 'autre', immutabilité
post-clôture, traitement par défaut sans mouvement supplémentaire (solde inchangé), ajustement
explicite qui trace un mouvement et solde le compte, alerte déclenchée par le montant cumulé (et
son contrôle négatif, sous le seuil), alerte déclenchée par la série (et son contrôle négatif, un
seul écart isolé n'alerte pas).

`make test` ciblé (`TestCashDiscrepancy`) : 11 tests, 0 échec. Suite élargie
(`TestCashDiscrepancy`, `TestRemittanceAccounting`, `TestRemittanceValidation`,
`TestRemittanceController`, `TestCashRemittanceModel`, `TestCashBalance`, `TestSettlement`,
`TestCashLimitOnlineEligibility`, `TestCashLimitRealtimeChannel`) : 70 tests, 0 échec.

**Ce qui manque encore pour que la nuit tienne sa promesse.** Le scénario du rapport de demain
matin (« un chauffeur qui remet 40 000 sur 45 000 dus, une remise validée, une écriture comptable
posée, et 5 000 qui restent à son solde et pèsent sur son plafond ») est maintenant démontrable de
bout en bout par `action_declare` + `action_validate` seuls, sans passer par L5-06 : le mouvement
`remittance`, l'écriture comptable et le reliquat sont tous des effets de la validation
elle-même (L5-04/L5-05). L5-06 ajoute la visibilité de l'écart (l'enregistrement dédié) et sa
détection en série -- une couche de traçabilité et de contrôle, pas une condition pour que le
scénario fonctionne.

---

## Arrêt propre après L5-06, L5-07 différée

**L5-07 (écran de recette, app Chauffeur) n'est pas commencée.** Vérifié avant de l'écarter,
pas supposé : `apps/driver/src/` n'existe pas -- ni `screens/`, ni `api/`, ni navigation. Le seul
fichier de l'app est `App.tsx` à la racine, et son propre commentaire le dit explicitement :
« Squelette L0-03 ... Aucun écran métier ce soir, hors du lot autorisé. » `apps/driver/src/api/
cash.ts` peut s'appuyer sur `createHttpClient` (`@babana/api-client`, déjà générique, construit
sur `HTTP_ENDPOINTS`) sans code nouveau à ce niveau, mais `CashScreen.tsx` demanderait de poser la
première pierre de la navigation et de l'architecture d'écran du lot L6 tout entier -- bien
au-delà du périmètre d'une tâche d'écran unique, et précisément la situation anticipée par la
consigne de ce soir (« l'écran peut attendre »).

Ce lot s'arrête donc ici, comme prévu. Le prochain lot à ouvrir L6 (les deux applications
mobiles, qui n'ont pas commencé) trouvera un back-end de caisse complet et testé à consommer :
`POST /remittances`, `GET /drivers/me/cash` (à vérifier -- non construit par ce lot, aucune tâche
ne le lui demandait explicitement) et l'historique des remises par chauffeur
(`babana.cash.remittance`, déjà consultable par `driver_id`).

---

## Vérification finale, sur base fraîche

`make reset` puis `make up`, puis `make test` complet (suite Odoo, `@babana/realtime`,
`@babana/contracts`, `@babana/concurrency-tests`, `npm run typecheck`, `npm run lint`) --
lancé en tâche de fond, résultat à confirmer dans une reprise de session si elle intervient avant
la fin de cette vérification. Les vérifications ciblées de chaque tâche (ci-dessus), elles, ont
toutes tourné contre une pile réellement réinstallée depuis la nuit du 16 août (`make reset`
initial de cette session, avant L5-03).

---
