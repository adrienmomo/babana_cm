# Rapport de nuit — J2 (nuit du 10 au 11 août 2026)

Tenu au fil de l'eau, même structure que `amoa/rapport-nuit.md`. Périmètre : corrections
C-03R/L0-01R puis chemin critique L1-01 → L1-02 → L1-03 → L1-04 → L4-01 → L4-02
(`amoa/PROMPT-NUIT-J2.md`).

---

## Corrections (phase 1)

### C-03R — reprise de la machine à états

**Fait, fusionné.** `code/docs/contracts/ride-state-machine.md`, `ride-state-machine.json` et
`verify-ride-state-machine.js` repris pour refléter l'invariant reformulé
(`amoa/01-architecture.md` §2, révision du 10 août) : sept événements métier nommés écrivent
dans Odoo (demande, proposition, acceptation, refus, annulation, fin de course, encaissement),
plus aucun compte de « quatre moments », plus de distinction `partition_moment`/`closure`.

**Changement de comportement documenté, pas seulement de vocabulaire** : `requested → proposed`
et `proposed → rejected` (et `rejected → proposed`) écrivent désormais dans Odoo au moment où
ils se produisent — l'ancienne version différait ces écritures. Chaque refus reste une décision
humaine unique, donc le nombre d'écritures reste borné par le nombre de décisions.

`in_progress → cancelled` (chauffeur uniquement, motif obligatoire, signalement au back-office)
ajoutée à la table ; l'interdiction générale de cette transition, retirée et remplacée par une
interdiction ciblée sur l'acteur client seulement.

Script de vérification : ne compte plus les écritures, vérifie que toute écriture Odoo est
rattachée à un événement métier nommé, que les sept événements sont tous utilisés au moins une
fois, et qu'aucun déclencheur de transition n'évoque un mécanisme temporel/positionnel interdit
(position, ETA, distance en cours, minuteur). `node docs/contracts/verify-ride-state-machine.js`
passe.

**Écart relevé** (deuxième changement de protocole, lecture de L4-07 avant L4-01/L4-02) :
`rejected → cancelled` figure dans C-03 (corrigé) mais est absente du tableau de règles de
L4-07. Déposé dans `amoa/questions/L4-07.md`, hypothèse retenue pour L4-02 : traiter comme
`requested → cancelled`.

### L0-01R — compose et SMTP

**Fait, fusionné.** `mailpit` déplacé de `infra/compose.yaml` vers `infra/compose.dev.yaml`
(service simulé, D19) — pile de base à six services. `SMTP_HOST`/`SMTP_PORT` littéraux
remplacés par des variables d'environnement ; `SMTP_USER`/`SMTP_PASSWORD` ajoutées.
`SMTP_PROD_*` (cinq variables documentées par anticipation) retirées de
`infra/env/README.md` et `.env.example`, remplacées par `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/
`SMTP_PASSWORD`/`SMTP_FROM` — mêmes variables, valeurs différentes selon l'environnement, même
mécanisme que `GOOGLE_JWKS_URL`.

**Choix d'implémentation non spécifié** : `SMTP_FROM` ajoutée par cohérence (renommage de
`SMTP_PROD_FROM`) bien que l'instruction ne citait que quatre variables — sans elle,
l'adresse d'expédition des factures n'aurait plus eu de source configurable du tout.

**Vérifié** : `make up` → neuf conteneurs sains (six de base + trois simulés). `make verify` et
`make secrets-scan` passent. Réinstallation du module `babana` sans erreur avec les nouvelles
variables (`SMTP_HOST=mailpit SMTP_PORT=1025` confirmés dans le conteneur Odoo).

---

## Chemin critique (phase 2)

### L1-01 — contrôleur d'authentification Google

**Fait, fusionné.** `controllers/auth.py`, `services/google_identity.py`, `models/res_users.py`,
`tests/test_auth.py`, `tests/test_google_identity.py`. Vérification serveur complète contre
`mock-google-identity` : signature RS256 contre JWKS, `iss`, `aud` (liste blanche), `exp`
(tolérance de 10 s), `email_verified` — dans cet ordre, jamais de décodage non vérifié. Cache
JWKS respectant `Cache-Control: max-age`, testé isolément par mock (aucune requête sortante au
second appel dans la fenêtre). Compte retrouvé par `google_sub`, jamais par email.

**Trois défauts de contrat trouvés en implémentant** (détail complet :
`amoa/questions/L1-01.md`) : `GoogleAuthRequestSchema` n'avait pas de champ `role` (nécessaire
pour savoir s'il faut créer un `babana.driver` ou un client) ; `AuthSessionSchema.user` n'avait
pas de `driverStatus` (nécessaire au critère d'acceptation 8, chauffeur non approuvé) ;
`DRIVER_NOT_APPROVED` figurait à tort dans le catalogue d'erreurs de cet endpoint alors que
l'authentification ne le renvoie jamais. Les trois corrigés dans `packages/contracts` et
`docs/contracts/http-api.md`, avec test de non-régression.

**Deux défauts Odoo trouvés en écrivant les tests**, tous deux liés à `auth='none'` qui lie la
requête à `uid=None` : (1) les routes `auth='none'` sont `readonly=True` par défaut depuis
Odoo 18 (support des répliques de lecture) — la création d'utilisateur échouait avec
`ReadOnlySqlTransaction` tant que `readonly=False` n'était pas explicite ; (2) `env.user` vide
sous `uid=None` fait échouer des hooks internes `hr`/`mail` qui appellent
`self.env.user.has_group(...)` pendant la création — `.sudo()` seul ne suffit pas, il faut
rebasculer sur un `env` avec un `uid` réel (`request.env(user=SUPERUSER_ID)`).

`babana.driver` (L1-03) et l'extension `res.partner` (L1-04) n'existant pas encore, `res.users`
porte trois champs-pont explicitement documentés comme transitoires (`babana_role`,
`babana_driver_state`, `babana_refresh_token_hash`) — à faire disparaître par L1-03/L1-02.

**Vérifié** : `make test` passe en entier (13 tests du module `babana`, `tsc --noEmit` et lint
sur tout l'arbre, `verify-ride-state-machine.js`).

### L1-02 — jetons applicatifs

**Fait, fusionné.** `models/babana_token.py`, `controllers/auth.py` (étendu),
`tests/test_token.py`. Rotation à chaque renouvellement, réutilisation d'un jeton déjà consommé
révoque toute la famille (testé aux deux niveaux, modèle et HTTP), `_revoke_all_for_user` prêt
pour la suspension d'un chauffeur (L1-06, hors de ce lot). Remplace le champ-pont de L1-01
(`babana_refresh_token_hash`) par le mécanisme complet.

**Contrat corrigé** (`amoa/questions/L1-02.md`) : la règle générale « `Authorization: Bearer`
sur tous les endpoints sauf `/auth/google` » rendait `/auth/refresh` inutilisable au moment
précis où il sert — un `accessToken` expiré est justement ce qui amène à l'appeler.
`/auth/refresh` et `/auth/logout` rejoignent `/auth/google` comme routes authentifiées par le
jeton du corps, pas par l'en-tête.

**Piège de framework de test rencontré** : `self.assertRaises` d'Odoo (`TransactionCase`) ouvre
un savepoint qu'il annule à la sortie du bloc — les écritures faites par le code testé à
l'intérieur d'un `assertRaises` ne survivent pas au bloc. Pour prouver qu'une révocation de
famille persiste et affecte un *second* appel, il a fallu sortir le premier appel d'un
`assertRaises` (try/except manuel) et ne garder le mécanisme Odoo que pour la dernière
assertion.

**Vérifié** : `make test` passe en entier (24 tests babana).

### L1-03 — modèle `babana.driver`

**Fait, fusionné.** `models/babana_driver.py`, `tests/test_driver.py`. `is_online` contraint à
`state == approved` par `@api.constrains` ; `write()` force `is_online = False` dès que `state`
quitte `approved`, y compris si l'appelant tente les deux dans le même appel. `cash_balance` est
un champ calculé avec un `inverse` qui lève explicitement une erreur — un compute sans inverse
est silencieusement ignoré par `write()` dans l'ORM Odoo, ce qui ne suffisait pas à prouver le
critère d'acceptation 4 (trouvé en écrivant le test). `cash_limit` hérite d'un paramètre système
(`babana.default_cash_limit`), jamais codé en dur dans une transaction.

**Deux champs omis, forward-dépendances vers des modèles absents** (`amoa/questions/L1-03.md`) :
`motorcycle_id` (`babana.motorcycle`, L1-07 — un `Many2one` vers un modèle absent empêche
l'installation, ce n'est pas un choix) ; `rating_avg`/`rating_count`/`ride_count`, champs-pont à
0 en attendant `babana.rating` (L4-09) et `babana.ride` (L4-01). **Critère d'acceptation 3 non
testé ce soir** — recalcul de `rating_avg` à chaque avis, invérifiable sans L4-09 — documenté
plutôt que couvert par un test décoratif. É3 (compatibilité commission) satisfait par
construction : tous les champs financiers sont calculés et indépendants.

**Vérifié** : `make test` passe en entier (32 tests babana).

### L1-04 — modèle client sur `res.partner`

**Fait, fusionné.** `models/res_partner.py`, `tests/test_partner.py`. Extension classique
(`babana_is_customer`, `babana_google_sub` unique, `babana_phone_verified`,
`babana_rides_count`, `babana_emergency_contact`), pas de modèle séparé. `res_users.py` (L1-01)
mis à jour pour marquer le `partner_id` auto-créé à la création d'un compte `client`. Le
contrôleur renvoie désormais le vrai `phoneVerified` côté client (toujours faux en pratique tant
que L1-09 n'existe pas, mais ce n'est plus un champ-pont — c'est la valeur réelle d'un champ
jamais encore écrit). Côté chauffeur, `phoneVerified` reste un champ-pont : rien ne relie
`res.users` à sa fiche `babana.driver` pour l'instant.

**Vérifié** : `make test` passe en entier (37 tests babana), y compris qu'une facture s'émet à
un client babana sans traitement particulier (critère 3).

### L4-01 — modèle `babana.ride`

**Fait, fusionné.** `models/babana_ride.py`, `data/babana_ride_sequence.xml`,
`tests/test_ride_model.py`. `state` encore librement modifiable — le verrou des transitions est
L4-02, la tâche suivante. Deux index uniques partiels PostgreSQL (créés dans `init()`, non
exprimables via `_sql_constraints`) empêchent en base un chauffeur ou un client d'avoir deux
courses actives à la fois. Refus portés par `babana.ride.rejection` (One2many), pas par des
courses distinctes. La règle tarifaire est gelée **par valeur** (`fare_rule_snapshot`, JSON)
plutôt que référencée — ce que la spécification demandait déjà, et qui absorbe sans compromis
l'absence de `babana.fare.rule` (L2-01, hors de ce lot).

**Quatre champs omis** (`amoa/questions/L4-01.md`), même schéma que `motorcycle_id` sur
`babana.driver` : `moto`, `zones`, `estimation référencée`, `promotion` référencent des modèles
du lot L2 ou de L1-07, absents ce soir — un `Many2one` vers un modèle inexistant empêche
l'installation. « Notation » n'est pas portée par des champs scalaires sur `babana.ride` : le
fichier annoncé par L4-09 (`models/babana_rating.py`) implique un modèle séparé.

**Vérifié** : `make test` passe en entier (44 tests babana), y compris les deux contraintes
d'unicité prouvées au niveau base (pas applicatif, via `psycopg2.Error` sur une tentative
directe) et la survie du gel tarifaire à la mutation d'une « règle vivante » simulée.

### L4-02 — machine à états

**Développée sur la branche `L4-02-state-machine`, commitée, NON FUSIONNÉE** — à relire avant
fusion, comme demandé. `models/babana_ride_state.py` (huit méthodes `action_*`, une par
transition de C-03), `write()` surchargé pour interdire toute écriture directe de `state` et
toute modification après `settled` ou des champs figés après `completed` — y compris via
`sudo()`. `_lock_for_update` (`SELECT ... FOR UPDATE`) sérialise les transitions concurrentes.

**Le test explicitement demandé** — deux courses au même nombre de décisions humaines mais à
distance et durée très différentes produisent exactement le même nombre d'écritures Odoo —
est dans `tests/test_partition_invariant.py`. Il compte les appels réels à
`create()`/`_babana_write_transition()`, pas un décompte manuel : six décisions, six écritures,
identique pour une course de 1 km/5 min et une de 40 km/45 min.

**Une hypothèse posée puis invalidée par le code lui-même, en cours de nuit** : `action_start`
(démarrage, `assigned → in_progress`) devait initialement ne rien écrire dans Odoo, fidèle à
C-03R. Le premier test de `action_complete` a immédiatement échoué : sa précondition
(`state == in_progress`) ne pouvait jamais être satisfaite si rien n'écrit jamais cette valeur —
la course entière restait bloquée en `assigned` pour toujours. Corrigé : `action_start` écrit
`state = in_progress`. `01-architecture.md` §2 ne liste toujours pas « démarrage » parmi ses
sept événements nommés — écart non résolu, laissé pour arbitrage humain plutôt que de retoucher
une seconde fois une décision d'architecture sans validation (détail complet et deux autres
points, dont l'écart de portée L4-01/C-03 sur `action_request` et le point d'accroche
`_babana_journalize` en attendant L8-09 : `amoa/questions/L4-02.md`).

**Le critère de concurrence (4) est prouvé correct, mais le test qui le vérifie est instable
dans le harnais** : `tests/test_ride_state_concurrency.py` monte deux vraies connexions
PostgreSQL et deux threads pour prouver qu'un seul des deux `action_accept` concurrents réussit.
Vérifié manuellement hors du harnais de test (`odoo shell`) : le mécanisme se résout en 0,01 s,
exactement un succès et un `SerializationFailure` PostgreSQL propre. **Mais** exécuté sous
`odoo --test-enable`, le même test prend systématiquement 60 à 185 secondes et échoue parfois
sur le délai d'attente malgré une fenêtre généreuse (90 s) — cause non identifiée ce soir
(ni épuisement du pool de connexions, ni verrou PostgreSQL réel, ni fragmentation de table ne
l'expliquent). **Laissé rouge par endroits, documenté, ni désactivé ni affaibli** — à
investiguer avant de fusionner cette branche.

**Le reste de la suite passe** : 95 tests au total sur la branche (dont les 7 autres critères
d'acceptation dans `tests/test_ride_state_machine.py` — transitions valides et interdites,
écriture directe bloquée y compris via `sudo()`, immuabilité `completed`/`settled`, historique
des refus).

---

## Contradictions trouvées entre spécifications

1. **C-03 vs L4-07 — `rejected → cancelled`** (`amoa/questions/L4-07.md`). C-03 liste la
   transition, L4-07 ne la couvre pas dans son tableau de règles état × acteur. Hypothèse
   retenue pour L4-02 : traiter comme `requested → cancelled`.

2. **`01-architecture.md` §2 vs le fonctionnement réel de la machine à états — le démarrage
   d'une course** (`amoa/questions/L4-02.md`, point 2). La liste des sept événements métier qui
   écrivent n'inclut pas « démarrage » (`assigned → in_progress`), et `ride-state-machine.md`
   affirmait initialement que cette transition n'écrit rien. Le code a démontré que c'est
   intenable : sans cette écriture, `action_complete` ne peut jamais être atteinte, aucune
   course ne peut jamais se terminer. Corrigé au niveau du code (`action_start` écrit
   désormais), mais `01-architecture.md` lui-même n'a pas été retouché — décision d'architecture,
   validation humaine requise avant de trancher si « démarrage » doit rejoindre la liste des sept
   événements ou rester une exception assumée.

3. **L4-01 vs C-03 — portée de « course active » pour le client** (`amoa/questions/L4-02.md`,
   point 1). La contrainte de base de données de L4-01 (`ACTIVE_STATES`) ne couvre que
   `proposed`/`assigned`/`in_progress` ; la précondition de `draft → requested` dans
   `ride-state-machine.md` inclut aussi `requested`. L4-01 étant déjà fusionné et testé, l'écart
   est comblé en Python dans `action_request` plutôt que par une reprise de la contrainte de
   base — à unifier si cet écart de portée (contrainte DB vs contrôle applicatif) gêne plus tard.

4. **L1-01 vs C-01 (trois points, contrat déjà figé)** — `amoa/questions/L1-01.md` : `role`
   absent de `GoogleAuthRequestSchema`, `driverStatus` absent de `AuthSessionSchema.user`,
   `DRIVER_NOT_APPROVED` présent à tort dans le catalogue d'erreurs de `/auth/google`. Les trois
   corrigés dans le contrat, avec test de non-régression.

5. **L1-02 vs C-01** — `amoa/questions/L1-02.md` : la règle générale d'authentification par
   en-tête rendait `/auth/refresh` inutilisable au moment précis où il sert. Corrigé : ces deux
   routes s'authentifient par le jeton du corps.

6. **L4-02 vs le découpage des tâches — « Journalise (L8-09) »** (`amoa/questions/L4-02.md`,
   point 3). L8-09 dépend de L4-02 dans `03-decoupage-taches.md`, pas l'inverse : le modèle
   d'audit immuable qu'on demande à L4-02 d'appeler n'existe pas encore et ne peut pas exister
   avant que L4-02 ne soit fini. Point d'accroche stable posé (`_babana_journalize`), à
   remplacer par L8-09 sans toucher aux transitions.

---

## Divers

**`amoa/CLAUDE.md`** : un doublon exact (byte pour byte) du `CLAUDE.md` racine existe dans
`amoa/CLAUDE.md` (constaté en tout début de session, avant toute modification). `amoa/` ne
devrait contenir aucun `CLAUDE.md` d'après la structure documentée par `CLAUDE.md` lui-même.
Contenu identique au fichier racine (donc pas de divergence d'instructions), mais probablement
un fichier égaré d'une session précédente — à vérifier et supprimer si effectivement superflu.

**Fragilité de test trouvée et corrigée sur du code déjà fusionné.** En travaillant sur L4-02,
`tests/test_ride_model.py::test_rejections_are_carried_by_the_same_ride` (L4-01, déjà fusionné)
a échoué à cause de lignes `babana.ride` résiduelles laissées par une session de diagnostic
manuel plus tôt dans la nuit (`odoo shell`, hors du harnais de test habituel). Le test comptait
toutes les courses de la base (`search_count([])`) plutôt que de filtrer sur la sienne — corrigé
directement sur `master` (commit séparé, hors branche de tâche, fragilité de test pure sans
rapport avec L4-02 elle-même).

---

## État à l'arrivée et suite

**Fusionné sur `master`** : C-03R, L0-01R, L1-01, L1-02, L1-03, L1-04, L4-01. `make up` produit
une pile saine à neuf conteneurs, `make test`/`make verify`/`make secrets-scan` passent tous les
trois. L'authentification fonctionne de bout en bout contre `mock-google-identity`, jetons
d'accès et de renouvellement inclus, rotation et révocation de famille comprises. Le domaine
`babana.driver`/`res.partner`/`babana.ride` est posé.

**Sur la branche `L4-02-state-machine`, prête à relire, non fusionnée** : la machine à états
complète, huit transitions, invariant de partition prouvé par un test dédié. Deux points
demandent un arbitrage humain avant fusion : le point 2 des contradictions ci-dessus (démarrage
et la liste des sept événements) et la fiabilité du test de concurrence sous `--test-enable`
(mécanisme prouvé correct, harnais instable).

**Ce que je ferais ensuite** : dans l'ordre, (1) trancher le point 2 — si « démarrage » rejoint
la liste des sept événements de `01-architecture.md` §2 ou reste une exception documentée ;
(2) investiguer la lenteur du test de concurrence sous `--test-enable` avant de fusionner
L4-02 — instrumenter précisément où les 60 à 185 secondes sont perdues, hypothèse à tester en
premier : un comportement propre au processus `odoo --test-enable` lui-même plutôt qu'à
PostgreSQL ; (3) une fois L4-02 fusionnée, L4-03 (endpoints du cycle de vie) devient
attaquable — c'est la suite naturelle du chemin critique vers J3.
