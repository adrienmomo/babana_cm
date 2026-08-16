# Rapport de nuit — J10

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). `amoa/questions/REPONSES-2026-08-18.md` lu en entier avant d'ouvrir quoi que
ce soit. Deux blocs : d'abord débloquer et consolider (L3-16, D30, D31, D32), puis l'encaissement
mécanique (L4-05, L5-01, L5-02) si le premier bloc est fini et vert.

---

## L3-16 — Profils chauffeurs lisibles par le service temps réel, et D30

**Canal interne**, extension de l'authentification existante (`_common.authenticated_internal_call`,
même secret partagé que L3-17) plutôt qu'un second mécanisme : `controllers/internal_profiles.py`
expose `POST /api/internal/drivers/profiles`, par lot, liste blanche construite champ par champ
(jamais `driver.read()`). `firstName` vient du premier mot du nom complet de `employee_id` (aucun
champ prénom séparé sur `hr.employee` dans ce lot — choix d'implémentation non spécifié, à corriger
le jour où un vrai prénom existe). `rating` reste `None` tant que `rating_count` est à 0 (champ-pont
L1-03, [PONT — remplacé par L4-09]) : servir `0.0` aurait inventé une note. `photoUrl` toujours
`None` — aucun document de type photo de profil dans ce lot.

Côté temps réel, `redis/driver-profiles.ts` cesse d'être le hash provisoire de L3-05
(`amoa/questions/L3-05.md`, champ-pont retiré de `code/docs/bridge-fields.md` — il n'y figurait pas
explicitement, seul `driver-profiles.ts` portait la mention). `getDriverProfiles` (nouveau) reçoit
les candidats d'une requête `nearby`, lit le cache en un aller-retour Redis par candidat, et
déclenche **au plus un appel Odoo par lot** (`odoo/driver-profiles.ts`, critère 3) pour les entrées
absentes ou périmées — jamais un par chauffeur. Aucun TTL Redis sur les clés elles-mêmes : une
expiration TTL aurait fait disparaître un profil déjà lu dès qu'Odoo devient injoignable plus
longtemps que la fraîcheur voulue, l'inverse du critère 2. La fraîcheur se gère par une clé
compagnon (`fetched-at`) ; une entrée périmée déclenche une tentative de rafraîchissement, jamais
une suppression. `setDriverProfile` reste l'écrivain canonique du cache, utilisé aussi bien en
production que par les fixtures de test — un seul chemin d'écriture pour le cache, pas deux formats
différents.

**D30, la correction de fond.** L'ancienne règle — un chauffeur sans profil en cache est omis de
`nearby.drivers` — a produit un blocage total en production (aucun chauffeur réel ne portait de
profil, `amoa/questions/REPONSES-2026-08-18.md` §2). La règle elle-même était mauvaise, pas
seulement incomplète : un défaut de cache ne doit jamais retirer un chauffeur de la flotte, même
famille de panne que le marqueur d'engagement resté en place (D26). `NearbyDriverSchema` (C-01)
rend `firstName`, `photoUrl`, `rating`, `motorcycleClass` nullables ; `projectNearbyDrivers`
n'omet plus jamais un candidat, il complète les champs de profil absents par `null`. Seule
l'absence de **position** écarte un chauffeur (sans position, pas de distance) — inchangé,
`findNearby` ne renvoie que des candidats positionnés.

Conséquence en cascade : `_redis_fixture.py` (le seed Redis direct de L3-05, utilisé uniquement par
`_make_selectable_driver` dans `test_ride_controller.py`) n'a plus de raison d'exister — un
chauffeur en ligne et positionné apparaît désormais dans `nearby.drivers` sans qu'aucun profil ne
soit préchargé, exercant pour de vrai le canal L3-16 (Odoo répond avec le nom réel de l'employé de
test) plutôt que de le contourner. Fichier supprimé, usage retiré.

**Tests** : `services/realtime/test/driver-profiles.test.ts` (nouveau, faux serveur Odoo local —
même patron que `reconcile.test.ts`) couvre le lot unique, l'absence jamais inventée, le critère 2
(Odoo injoignable sert le dernier connu), la fraîcheur (pas d'appel si l'entrée est récente, appel
si périmée). `test/nearby.test.ts` : le test "omis" devient "reste présent, champs à `null`" (D30) ;
les autres adaptés à la nouvelle signature (`config` en premier argument de `projectNearbyDrivers`).
`test_internal_profiles_controller.py` (nouveau, Odoo, `HttpCase`) couvre l'authentification, les
quatre champs, le lot, la liste blanche stricte (recherche textuelle de fuite dans le JSON sérialisé),
l'absence d'un identifiant inconnu. `test_ride_controller.py` : plus de seed de profil, 19 tests du
fichier toujours verts.

`npx tsc --noEmit` (paquet `@babana/realtime`) et `npm run build -w @babana/contracts` propres.
Suite Odoo complète (`-u babana --test-enable`) : 293 tests, 1 échec —
`TestBabanaToken.test_rotate_produces_new_pair_and_invalidates_old`, artefact de base ancienne déjà
identifié le 15 août (`amoa/questions/REPONSES-2026-08-15.md`, vert sur base fraîche à chaque
vérification) ; reconfirmé sur `make reset` complet en fin de session (voir entrée de vérification
finale).

---

## D31 — un seul chemin d'écriture sur l'acceptation et le refus

`/rides/{id}/accept` et `/rides/{id}/reject` retirés de `controllers/ride.py`, de `packages/contracts/src/http/ride.ts` (schémas, types, catalogue d'erreurs, exemples — `startRideResponseExample` référence désormais un exemple `assigned` local plutôt que l'ancien `acceptRideResponseExample`) et du registre `HTTP_ENDPOINTS` (`packages/contracts/src/http/index.ts`, 21 → 19 endpoints). Le seul chemin d'écriture restant est `proposal.accept` / `proposal.reject` en temps réel (C-02), déjà câblé par L3-17 (`proposal/lifecycle.ts` résout atomiquement puis appelle `odoo/rides.ts::reportDriverAccepted`/`reportDriverRejected`, qui écrivent dans Odoo par le canal interne `controllers/internal.py`) : rien à construire ici, seulement retirer le second chemin qui l'ignorait.

**La preuve ne disparaît pas avec l'endpoint** (instruction explicite du débrief). `test/concurrency/ride-transitions.test.ts` (L4-11) vise désormais `/api/internal/rides/{id}/driver-accepted`, authentifié par le secret partagé (nouvelle aide `callInternalEndpoint`, `test/concurrency/helpers/odoo-session.ts`) plutôt que par un jeton de chauffeur — le verrouillage d'Odoo (`_lock_for_update()`) reste le même, que l'appelant soit un vrai chauffeur passé par le temps réel ou, comme ici, directement le canal interne.

**Effet de bord découvert en le câblant : le scénario 2 de L4-11 devenait injuste.** Depuis que l'acceptation vise le canal interne (authentification par secret partagé, sans résolution d'utilisateur ni recherche du chauffeur affecté), elle est structurellement plus rapide que `/cancel` (authentification complète par jeton) — sur 12 itérations à égalité de départ, l'acceptation gagnait 12 fois sur 12, et le critère 2 bis (« les deux ordres doivent se produire ») ne pouvait plus jamais être observé. Avant D31, les deux endpoints avaient un coût d'authentification comparable ; ce n'est plus le cas. Corrigé par un stager délibéré de 10 ms, alterné par itération — les deux appels restent réellement concurrents (le décalage reste largement sous le temps de traitement serveur, les deux transitions continuent de se disputer le même verrou de ligne), seul l'ordre de départ est rééquilibré. Vérifié : les deux ordres s'observent de nouveau sur 12 itérations.

**Conséquence en cascade côté Odoo** : `test_ride_controller.py` n'a plus d'endpoint public à appeler pour amener une course à `assigned` en préparation d'un test — nouvelle aide `_accept_via_internal_channel` (secret partagé). `test_unassigned_driver_cannot_accept` (critère 3 de L4-03, qui testait l'autorisation REST — disparue avec l'endpoint) devient `test_unassigned_driver_cannot_be_recorded_as_accepting` : la garantie qui reste est celle du modèle (`action_accept`, `by_driver != self.driver_id` → `RIDE_INVALID_TRANSITION`, pas `DRIVER_NOT_IN_PROPOSAL`) — l'identité de connexion, elle, est désormais garantie côté temps réel (`proposal.accept`, invariant L3-01), pas testable depuis ce fichier.

**Nettoyage lié à D30** (touché en passant, ces mêmes fichiers) : `test/concurrency/helpers/realtime.ts::seedDriverProfile` n'est plus une condition de visibilité depuis D30 — un chauffeur en ligne et positionné apparaît dans `nearby.drivers` sans profil. Gardé quand même, commentaire mis à jour : sans lui, le premier `nearby.drivers` qui montre un chauffeur fraîchement en ligne dans ces tests de concurrence déclencherait un aller-retour Odoo réel (L3-16) au lieu de lire un cache déjà chaud, ce qui aurait pu introduire une variation de temps d'exécution (critère 4 de L4-11).

**Vérifications** : suite Odoo complète (`-u babana --test-enable`) 297 tests, 1 échec (même artefact de base ancienne, `test_rotate_produces_new_pair_and_invalidates_old`). `npm run build -w @babana/contracts` (19 endpoints). `npx tsc --noEmit` sur `test/`. L4-11 scénario 1 en entier (20 itérations × 8 appels simultanés) : vert. Scénario 2 (12 itérations, avec le stagger) : vert, les deux ordres observés (`bothSucceeded` et `onlyCancelSucceeded` tous deux non nuls).

---

## D32 — l'appel sortant part au commit, jamais pendant

**Le défaut trouvé en relecture (§4 de `amoa/questions/REPONSES-2026-08-18.md`), corrigé.** `notify_cancellation_async` lançait son fil démon pendant la transaction Odoo d'annulation ; `clear_engagement`, appelée depuis `_complete_ride`, faisait un appel HTTP direct, tout aussi pendant. Si la transaction échoue au commit (D25 : rejeu sur conflit de sérialisation, ou échec définitif), Redis avait déjà été modifié pour une décision qui n'a pas eu lieu côté Odoo — le chauffeur revient au pool avec une course toujours vivante, ou perd son marqueur d'engagement en pleine course.

**`env.cr.postcommit` est le point d'accroche qu'Odoo fournit pour ça** (lu dans `sql_db.py` avant d'écrire quoi que ce soit : `Cursor.commit()` exécute `postcommit.run()` ; `Cursor.rollback()` fait `postcommit.clear()` — sans exécution). Encapsulé côté fonction plutôt que laissé à la discrétion de chaque site d'appel : `clear_engagement(env, *, driver_public_id)` et `notify_cancellation_async(env, driver_public_id)` exigent désormais `env` en premier argument et font elles-mêmes `env.cr.postcommit.add(...)` — impossible d'oublier le point d'accroche à un futur site d'appel, une erreur de frappe lève un `TypeError` plutôt que de laisser passer un appel non gardé. `release_reservation` et `reserve_and_propose` restent inchangées : la première compense une transaction qui va de toute façon être annulée (rien à attendre), la seconde précède délibérément la transition (c'est son résultat qui l'autorise) — ni l'une ni l'autre n'a de commit à attendre, et le documenter était déjà fait par L3-17.

**Le test qui devait échouer d'abord.** Vérifié manuellement contre l'ancien code (`git stash` temporaire de `realtime_client.py`) : appeler `clear_engagement(driver_public_id=...)` sans aucune notion de commit supprimait la clé Redis immédiatement — confirmé avant d'écrire le correctif, pas supposé. `test_realtime_commit_hook.py` (nouveau) le prouve contre la vraie pile (`make up`) avec une fausse implémentation de `env.cr` fidèle à la vraie (`_FakeCursor`, `commit()`/`rollback()` reproduisant exactement `sql_db.py`) : programmer l'appel puis **annuler** la transaction ne touche aucune clé Redis (chauffeur test, marqueurs d'engagement et de réservation seedés directement, lus en RESP minimal — la clé de la preuve, pas un mock de notre propre code) ; programmer l'appel puis **commiter** finit par l'effacer (le test qui prouve que le premier ne passe pas par accident, même piège que L3-13/L4-11). Piège rencontré en l'écrivant : `HttpCase` bloque tout appel HTTP sortant non explicitement autorisé en mode test (garde-fou générique d'Odoo) — sans le même `_request_handler` que `test_ride_controller.py`, les deux tests « commit » échouaient pour la mauvaise raison (aucun appel n'atteint jamais le service temps réel dans ce processus, pas un problème de point d'accroche).

**Frontière de lint (CLAUDE.md, déjà inscrite par le débrief).** `TestRealtimeCommitHookLint` balaie `controllers/*.py` par recherche (même principe que `pool-single-writer.test.ts`, D26) : tout appel à `clear_engagement`/`notify_cancellation_async` doit porter `env` en premier argument. La protection réelle est déjà structurelle (signature de fonction) ; ce test est le filet contre l'oubli que CLAUDE.md demande explicitement.

**Vérifications** : suite Odoo complète (`-u babana --test-enable`) 298 tests, 1 échec (même artefact de base ancienne). `test_realtime_commit_hook.py` : 5 tests, tous verts. L4-11 (6 itérations, scénarios 1 et 2) rejoué après le correctif : vert, confirme que `_complete_ride`/`_cancel_ride` fonctionnent toujours de bout en bout avec l'appel désormais différé au commit.

**Flakiness diagnostiquée, pas tolérée (correctif de suivi, même commit que L5-01).** `test_notify_cancellation_async_touches_no_redis_key_if_the_transaction_rolls_back` échouait environ une fois sur trois en suite complète. Cause : les tests seedaient un marqueur d'engagement pour un `driver_public_id` fictif (simple UUID, sans course réelle) -- exactement ce que la réconciliation périodique du service temps réel (`driver/reconcile.ts`, critère 7, toutes les 20 s par défaut) traite comme un orphelin et efface, indépendamment de tout ce que ce fichier teste. Le taux d'échec observé (~1/3) correspond exactement à la probabilité qu'un tic de 20 s tombe dans la fenêtre d'1 s du test. Corrigé : les quatre tests qui seedent une clé d'engagement s'appuient désormais sur une vraie course `assigned` (nouvelle aide `_really_engaged_driver_public_id`), légitimement connue d'`/api/internal/drivers/engaged` -- 4 exécutions consécutives de la suite, toutes vertes. (Tentative de correctif intermédiaire, écartée : `self.env.cr.commit()` dans le fixture, en espérant forcer la visibilité cross-connexion -- sous `--test-enable`, `self.env.cr` reste un `TestCursor` même en `HttpCase`, et son `commit()` ne pousse rien à la vraie base ; l'essai a fait passer le taux d'échec de 1/3 à 4/4, signe qu'il cassait autre chose. Retiré.)

---

Bloc 1 terminé, tout vert. Début du Bloc 2 -- l'encaissement, partie mécanique (L4-05, L5-01,
L5-02), avec D28 et D29 arbitrés le 18 août (`01-architecture.md` §7).

## L5-01 — Compte courant chauffeur

**`babana.cash.movement`** (nouveau modèle) : `driver_id`, `movement_type` (`collection` /
`remittance` / `adjustment`), `amount` signé, `ride_id` (origine, nullable -- `remittance_id`
n'existe pas encore, `babana.cash.remittance` est L5-03, hors de ce lot ; même raisonnement que
`invoice_id` sur `babana.ride`, un champ ajouté par la tâche qui en a besoin, pas avant), `reason`
(obligatoire pour un ajustement). Auteur et horodatage : `create_uid`/`create_date` natifs d'Odoo,
pas de champ redondant. Immuable : `write()` et `unlink()` lèvent inconditionnellement, y compris
sous `sudo()` -- testé explicitement des deux façons.

**Le solde n'est jamais stocké librement** (critère 1) : `babana.driver.cash_balance` reste un
champ calculé (déjà le cas depuis L1-03, en champ-pont) mais somme désormais réellement le journal,
via un nouveau champ `movement_ids` (`One2many`) et `@api.depends("movement_ids.amount")` --
**pas** un recalcul manuel par `search()` dans le compute lui-même. Piège trouvé en écrivant
`test_settle_forces_the_driver_offline_when_crossing_the_cash_limit` : un compute sans dépendance
déclarée reste en cache après la création d'un mouvement (aucun champ de `babana.driver`
lui-même n'est écrit par cette création, donc rien ne signale à l'ORM que le solde déjà lu est
périmé) -- `_babana_apply_cash_limit` ne voyait jamais le nouveau solde. `@api.depends` corrige la
classe de bug, pas seulement ce site d'appel.

**Une remise supérieure au solde est refusée** (critère 4) via une contrainte
(`_check_collection_and_remittance_never_go_negative`) qui recalcule le solde après le mouvement
candidat (une méthode Python dédiée, `_babana_cash_balance()`, séparée du champ calculé -- la
contrainte a besoin d'une lecture garantie fraîche pendant que le `create()` du mouvement qu'elle
valide est encore en cours, pas d'une valeur qui pourrait être mise en cache avant). **Seul un
ajustement motivé peut produire un solde négatif** (spécification, testé
`test_an_adjustment_with_a_reason_is_accepted_and_can_go_negative`) : la contrainte ne s'applique
qu'aux types `collection`/`remittance`, jamais `adjustment`.

**D29 rendu possible, pas encore utilisé** : une remise partielle laisse un solde non nul qui
continue de peser sur le plafond (`test_a_partial_remittance_leaves_a_nonzero_balance`) -- rien
dans ce modèle ne force le solde à zéro après une remise, contrairement à ce qu'une lecture rapide
de D8 point 4 ("la remise... remet le solde à zéro") pourrait laisser croire : ça n'est vrai que
pour une remise *complète*. L5-06 (traitement des écarts, hors de ce lot) décidera du reste.

**Correction en passant, découverte en lisant `babana_driver.py` avant d'écrire quoi que ce soit**
(le réflexe que ce protocole demande) : `babana_driver_cash_balance_not_negative`, une contrainte
SQL posée le 10 août sur `cash_balance`, n'a jamais pu s'appliquer -- `cash_balance` n'est pas un
champ stocké (`compute` sans `store=True`), et Odoo n'a donc jamais eu de colonne réelle sur
laquelle poser ce `CHECK` (log au démarrage : *"unable to add constraint ... as check(cash_balance
>= 0)"*, silencieusement ignoré depuis huit nuits). Retirée : elle aurait de toute façon été fausse
sous D29/L5-01 (un ajustement motivé peut légitimement produire un solde négatif) ; la vraie
protection est la contrainte au niveau du mouvement, pas du solde dérivé.

Champ-pont résolu : `cash_balance` retiré de `code/docs/bridge-fields.md`.

`code/services/odoo/addons/babana/tests/test_cash_balance.py` (nouveau, 15 tests) : solde calculé,
immutabilité (avec et sans `sudo()`), signe attendu par type, remise excessive refusée, D29,
ajustement motivé/non motivé, référence à la course d'origine.

## L4-05 — Encaissement espèces

`action_settle(by_driver, amount_collected)` remplace le stub minimal du 17 août. Montant vérifié
contre `final_amount or estimated_amount or 0` **avant** tout effet (`SETTLEMENT_AMOUNT_MISMATCH`
si différent, aucun effet appliqué) ; puis trois effets dans un `with self.env.cr.savepoint():`
unique -- transition, mouvement `collection` (L5-01), contrôle de plafond (L5-02) -- même patron
que `action_propose` (index unique, 16 août) pour la traduction d'un conflit. **La génération de
facture (L4-06) n'est pas dans ce lot** -- écart déposé, `amoa/questions/L4-05.md` : le périmètre
de la nuit ("un montant se déplace, un journal l'enregistre, un seuil bloque") ne la nomme pas,
elle représente à elle seule un lot substantiel, et rien n'empêche de la rejoindre au même
savepoint quand L4-06 sera construite.

`POST /rides/{id}/settle` (déjà entièrement spécifié par le contrat C-01, jamais implémenté) :
traduit HTTP en appel de méthode, rien de plus -- réponse `{rideId, state, amountCollected,
driverCashBalance}`, pas le `_summary()` générique des autres endpoints (le contrat en décide
autrement pour celui-ci). `SETTLEMENT_AMOUNT_MISMATCH` mappée en 409 (même famille que
`DRIVER_ALREADY_TAKEN` : ce que l'appelant croyait vrai a changé, pas une erreur de saisie).

**Preuve d'atomicité** (critère 2, `test_settlement.py`) : `babana.cash.movement.create` mocké
pour lever une `UserError` en plein savepoint -- la course reste `completed`, aucun mouvement
n'existe, le solde reste à zéro. Sans le savepoint, la transition aurait déjà été écrite avant
l'échec du mouvement.

Cinq call sites existants (`test_ride_state_machine.py`, `test_ride_state_machine_generated.py`,
`test_partition_invariant.py`) appelaient `action_settle(by_driver=driver)` sans montant --
signature désormais incompatible, corrigés pour passer le montant attendu de chaque fixture. Le
test généré (L4-10) construisait ses rides `completed` sans `final_amount`/`estimated_amount` :
`amount_collected=0` aurait passé la vérification de montant mais heurté la contrainte "montant
non nul" de L5-01 -- fixture corrigée avec un montant plausible plutôt que la contrainte assouplie
(CLAUDE.md : ne jamais adapter le code qui protège à un test qui suppose moins).

**Piège rencontré, déjà documenté** (`code/docs/odoo-pitfalls.md`) : un test créant une seconde
course `in_progress` pour le même chauffeur juste après un `action_complete()` heurtait l'index
unique partiel -- le `write()` de la transition n'était pas encore poussé en base.
`flush_recordset()` explicite, comme le pitfall le prescrit déjà.

## L5-02 — Plafond d'encaisse bloquant

**D28 appliqué au modèle existant, pas seulement au nouveau code.** `babana.driver.cash_limit`
existait déjà (10 août, L1-03) comme champ *stocké*, avec une valeur par défaut à la création --
exactement le "plafond par chauffeur, réglable par un gestionnaire" que la spécification d'origine
décrivait, et que D28 (18 août) écarte explicitement. Converti en champ calculé
(`_compute_cash_limit`/`_inverse_cash_limit`, même patron défensif que `cash_balance` : l'inverse
lève une erreur explicite plutôt que d'ignorer silencieusement une écriture directe), lisant
`babana.cash_limit` -- un seul paramètre pour toute la flotte, aucune possibilité de divergence
entre chauffeurs. Paramètre renommé `babana.default_cash_limit` → `babana.cash_limit` ("défaut"
suggérait une dérogation possible, ce que D28 exclut). `amoa/specs/L5-caisse.md` corrigé pour
refléter D28 (le débrief l'a explicitement arbitré).

**Deux points de blocage, câblés côté temps réel** (`services/realtime/src/driver/cash-guard.ts`,
nouveau) :
1. `pool-eligibility.lua` porte désormais une cinquième condition (non bloqué pour plafond),
   symétrique des quatre existantes (en ligne, non réservé, non engagé) -- un chauffeur bloqué qui
   continue d'émettre sa position ne revient jamais au pool.
2. `ws/dispatch.ts` vérifie le blocage avant de résoudre `proposal.accept` : une proposition émise
   juste avant le franchissement est traitée comme un refus explicite, jamais acceptée.

**Chaîne complète, testée à chaque bout** : `action_settle` détecte le franchissement
(`babana.driver._babana_apply_cash_limit`, dans le même savepoint que l'encaissement, critère 3)
et appelle `realtime_client.notify_cash_limit_reached(env, ...)` -- au commit, jamais pendant (D32,
même patron que `clear_engagement`). Côté temps réel, `POST /internal/drivers/cash-blocked`
(nouveau) pose la clé et retire immédiatement du pool. `test_cash_limit.py` (Odoo, nouveau) prouve
le canal réel jusqu'à Redis, avec et sans commit (même technique que `test_realtime_commit_hook.py`)
; `test/cash-guard.test.ts` (nouveau) prouve les deux points de blocage contre Redis réel, dont un
scénario bout en bout (une vraie proposition, bloquée après coup, résolue comme un refus --
`ride.rejected` reçu par le client, jamais `ride.assigned`).

**Écart déposé, `amoa/questions/L5-02.md`** : le seuil d'alerte (critère 5) n'est pas implémenté --
il dépend de L7-05 (notifications), qui n'existe pas du tout dans ce dépôt. Rien à câbler qui ne
puisse rien déclencher.

## Vérifications de fin de Bloc 2

Suite Odoo complète (`-u babana --test-enable`) : 331 tests, 1 échec (même artefact de base
ancienne, `test_rotate_produces_new_pair_and_invalidates_old`, reconfirmé sur base fraîche en fin
de session). `npm run typecheck --workspaces` et `npm run lint --workspaces` propres sur tout
l'arbre. Suite `@babana/realtime` complète (`npm test`, contre Redis réel) : 110 tests, tout vert.

## Vérification finale sur base fraîche, et L4-11 scénario 3 débloqué

`make reset` puis `make up` puis `make test` (le vrai chemin, `-i babana` sur une base neuve
plutôt que `-u`) : **2130 tests Odoo, 0 échec, 0 erreur** -- y compris
`test_rotate_produces_new_pair_and_invalidates_old`, vert comme attendu sur base fraîche (artefact
de base ancienne, pas un défaut réel, confirmé une fois de plus). 397 tests portés par le module
`babana` lui-même.

**`POST /rides/{id}/settle` existant maintenant, le scénario 3 de L4-11 (« encaissement
concurrent »), laissé `test.skip` depuis sa création, est débloqué.** Deux `action_settle`
réellement simultanés sur la même course `completed` : exactement un succès, l'autre
`RIDE_INVALID_TRANSITION`, un seul mouvement de compte courant créé -- vérifié par requête RPC
directe (`babana.cash.movement`, `search_count`), pas seulement par les codes de retour. 20
itérations, toutes vertes, aux côtés des scénarios 1 et 2 rejoués sans régression.

**Piège trouvé en l'écrivant, du genre que ce protocole demande de ne pas contourner.** La première
version amenait la course jusqu'à `completed` en acceptant par le canal interne
(`/api/internal/rides/{id}/driver-accepted`, comme le scénario 1) -- raisonnable en apparence,
puisque D31 en fait le seul chemin d'écriture restant. Mais appeler ce canal directement contourne
`ProposalLifecycle.accept()` côté temps réel : la réservation posée par `propose()` n'est jamais
relâchée, le minuteur d'expiration de la proposition (30 s par défaut) n'est jamais annulé. La
course avance bien côté Odoo, mais le chauffeur reste « réservé » indéfiniment côté Redis --
invisible dans `nearby.drivers` dès la deuxième itération, `waitForDriverVisible` finit par
expirer après 20 s. Les scénarios 1 et 2 ne l'avaient jamais révélé : leur nettoyage entre
itérations passe par `/cancel`, qui relâche la réservation en effet de bord sans le nommer. Le
scénario 3, qui termine par `settled` plutôt que par une annulation, n'avait pas ce filet.

**Corrigé en acceptant par le VRAI chemin** (nouvelle aide `acceptProposalOverWs`,
`helpers/realtime.ts`, `proposal.accept` sur la connexion WebSocket du chauffeur) plutôt qu'en
élargissant artificiellement le nettoyage entre itérations pour compenser un raccourci de test. Le
canal interne reste le bon choix pour le scénario 1 (qui teste précisément le verrouillage
d'Odoo) ; il ne l'est pas ici, où l'acceptation n'est qu'une préparation.

Un second ajustement, même famille que le générateur L4-10 plus haut : `createRideRequest`
(`helpers/odoo-session.ts`, partagée par les trois scénarios) ne posait aucun montant --
`action_settle` aurait refusé la création du mouvement de compte courant (L5-01, montant non nul).
`estimated_amount: 1500` ajouté, sans effet sur les scénarios 1 et 2, qui ne regardent jamais ce
champ.

---
