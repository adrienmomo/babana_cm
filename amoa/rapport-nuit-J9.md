# Rapport de nuit — J9 (nuit du 17 août 2026)

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). Périmètre : correction courte (`addToPool` hors de `src/`), puis L3-17 en
entier — le câblage Odoo ↔ temps réel, seule tâche de la nuit.

**État de départ vérifié** : `master` propre au lancement (`c543420`, débrief J8 déjà commité).
`amoa/questions/REPONSES-2026-08-17.md` lu en entier avant d'ouvrir quoi que ce soit. Point 4 :
trois nuits de code (`reserveDriver`, `ProposalLifecycle`, `clearEngaged`) sans aucun appelant de
production — vérifié dans le dépôt, pas supposé sur la foi du débrief : `grep -rn` confirme que ni
`controllers/ride.py` ni aucun module `services/realtime/src` n'appelle ces fonctions avant cette
nuit.

---

## Correction — `addToPool` hors de `src/`

**Arbitrage déjà tranché par le débrief J8** (§1 de `REPONSES-2026-08-17.md`) : le `GEOADD`
inconditionnel sort de `src/redis/geo-index.ts` et devient une aide de test.

Retiré de `geo-index.ts`. Nouvelle aide `test/helpers/pool.ts` (`putInPool`) : marque en ligne
(`setOnline`) puis appelle le script d'éligibilité (`addEligibleToPool`) — le vrai chemin de
production, jamais un raccourci.

Cinq fichiers de test utilisaient `addToPool`, pas trois : les trois nommés par le débrief
(`nearby.test.ts`, `geo-index.test.ts`, `availability.test.ts`) **et** deux non mentionnés
(`test/reservation.test.ts`, `test/concurrency/reservation.test.ts`, tous deux issus de L3-06/
L3-06R). Vérifié par `grep -rn addToPool services/realtime` plutôt que supposé sur la liste du
débrief — même réflexe que celui que ce protocole demande pour les dépendances. Les deux derniers
appelaient déjà `setOnline` juste avant `addToPool` : remplacés directement par
`addEligibleToPool`, sans passer par `putInPool` (redondant, `setOnline` était déjà là).

`test/pool-single-writer.test.ts` (critère 6/6 bis) mis à jour : `geo-index.ts` et
`test/helpers/pool.ts` ajoutés à la liste des fichiers autorisés à *nommer* `GEOADD` dans un
commentaire descriptif (aucun appel réel dans l'un ni l'autre).

`npm test` (paquet `@babana/realtime`, contre Redis réel) : 91 tests, 20 suites, tout vert,
y compris le test du critère 6 lui-même — qui, pour la première fois, ne trouve plus aucune
exception documentée dans `src/` pour un `GEOADD` réel.

---

## L3-17 — Câblage Odoo ↔ temps réel

**Lu avant d'écrire** : `amoa/specs/L3-temps-reel.md` (L3-17 en entier), `L3-12` (appels sortants
— jamais réimplémentée, voir plus bas) et `L4-course.md` (L4-03, endpoints du cycle de vie).

### Le piège central, tranché avant tout le reste

Deux options posées par la spécification : rendre l'appel select-driver → temps réel idempotent
de bout en bout, ou le sortir de la transaction rejouable. **Choix : le premier.** Le second exige
de scinder `select-driver` en deux requêtes HTTP séparées par un aller-retour client (créer une
proposition « en attente » côté Odoo sans jamais appeler le temps réel dans la requête initiale,
puis une seconde requête qui déclenche l'appel hors de toute transaction Odoo rejouable) — une
refonte du contrat `SelectDriverRequest`/`Response` que rien ne demande cette nuit et qui déplace
le problème plus qu'il ne le résout : la seconde requête resterait elle-même rejouable par le même
mécanisme D25, une couche plus haut.

Rendu idempotent : `services/realtime/src/reservation/idempotency.ts` mémorise, dans Redis, la
réponse de la PREMIÈRE exécution pour une clé donnée, et la rejoue telle quelle pour toute
exécution suivante avec la même clé — jamais un second calcul. La clé vient d'Odoo
(`services/realtime_client.py`, entrée suivante) : l'identifiant d'idempotence du client s'il en a
fourni un (L4-03), sinon une clé composite course + chauffeur, stable à travers le rejeu d'Odoo
puisque ni l'une ni l'autre ne dépend d'un état de base de données que le rejeu remettrait à zéro.
TTL généreux (`RESERVATION_IDEMPOTENCY_TTL_SECONDS`, 60 s par défaut) devant le budget de rejeu
d'Odoo (`MAX_TRIES_ON_CONCURRENCY_FAILURE`, quelques secondes au pire).

**Le test qui prouve un vrai rejeu** (critère 3) n'est pas dans ce paquet : il exige un vrai
conflit PostgreSQL provoqué contre la pile réelle, technique déjà établie par L4-11
(`test/concurrency/ride-transitions.test.ts`) — des appels HTTP réellement concurrents sur la même
ligne `babana_ride`, jamais un double appel du test lui-même. Entrée dédiée plus bas, une fois le
côté Odoo écrit.

### Sens Odoo → temps réel : `POST /internal/reservations`

`services/realtime/src/http/internal.ts` — trois routes, authentifiées par
`REALTIME_SHARED_SECRET` (en-tête `X-Realtime-Secret`), jamais exposées publiquement (Caddy ne
route que `/rt/*` et `/s/*` vers ce service — vérifié dans `infra/caddy/Caddyfile` avant d'écrire
quoi que ce soit, pas supposé).

- `POST /internal/reservations` : réserve et propose. Enveloppée par `withIdempotency` (ci-dessus).
  Vérifie **la précondition C-03** (critère 8, signalée depuis L3-06, jamais vérifiée nulle part
  avant cette nuit) : `nearby/last-sent.ts` mémorise, par client, les identifiants envoyés au
  dernier `nearby.drivers` (`nearby/handler.ts::push`, TTL `NEARBY_LAST_SENT_TTL_SECONDS`) ; un
  chauffeur absent de cette liste renvoie `DRIVER_NOT_IN_LAST_LIST` **avant** toute tentative de
  réservation — rien à défaire ensuite.
- `POST /internal/reservations/release` : compensation (critère 4). Nouvelle méthode
  `ProposalLifecycle.cancel()` : annule le minuteur, efface les clés de proposition, relâche la
  réservation. Appelée par `_select_driver` (Odoo) quand `action_propose` échoue après une
  réservation réussie — sans elle, le chauffeur resterait hors du pool jusqu'à l'expiration de la
  réservation, sans course correspondante nulle part.
- `POST /internal/engagement/clear` : fin de course (critère 6). Efface l'engagement et réintègre
  immédiatement le chauffeur dans le pool si sa position est connue (`reintegrateIfEligible`,
  extraite de `releaseDriver` pour être partagée entre les deux usages — même geste, deux
  appelants).

`ProposalLifecycle` expose maintenant `{ wss, proposals }` (`ws/connection.ts`) plutôt que
seulement `wss` : `http/internal.ts` doit poser ses propositions sur la MÊME instance que celle qui
traite `proposal.accept`/`proposal.reject` côté WebSocket, pas sur une seconde isolée avec ses
propres minuteurs.

### Sens temps réel → Odoo : acceptation, refus, expiration

`services/realtime/src/odoo/rides.ts`. **Décision explicite, à documenter parce qu'elle s'écarte
d'une lecture littérale de la spécification** : ces trois appels sont **volontairement non
bloquants** pour `ProposalLifecycle` (`reportDriverAccepted`/`reportDriverRejected`, appelés sans
`await`). La résolution atomique côté Redis (`resolve.lua`) a déjà eu lieu et fait foi pour le
chauffeur et le client, tous deux connectés en temps réel — les faire attendre un aller-retour HTTP
vers Odoo avant `ride.assigned`/`ride.rejected` ajouterait une latence perceptible pour un bénéfice
qui n'est pas le leur, et surtout : **rien dans cette tâche ne construit la file persistante avec
rejeu que L3-12 doit apporter**. Un appel bloquant et jamais rejoué en cas d'échec durable serait
pire qu'un appel non bloquant avec la même limite assumée.

**Ce que ce choix coûte, en connaissance de cause.** Si l'appel Odoo échoue durablement (au-delà
des réessais déjà portés par `callOdoo`, L0-04), la course Odoo ne transitionne jamais vers
`assigned`/`rejected` — jusqu'à ce que la réconciliation (section suivante) constate l'écart côté
engagement et l'aligne. Pour l'acceptation, ce filet referme correctement l'état Redis (engagement
retiré si Odoo ne voit jamais la course comme active). Pour le refus/l'expiration, il n'existe **pas
de filet équivalent** aujourd'hui : une course Odoo bloquée en `proposed` après un refus dont
l'appel Odoo a échoué durablement empêche toute nouvelle proposition sur cette course
(`action_propose` n'accepte que `requested`/`rejected` en état source). Déposé dans
`amoa/questions/L3-17.md` plutôt que passé sous silence — c'est exactement le genre de trou que
L3-12 doit fermer, pas une réparation à improviser ce soir dans une tâche qui ne la porte pas.

Au passage, `message.payload.reason` de `proposal.reject` (C-02) était recueilli par
`ws/dispatch.ts` puis jamais utilisé nulle part (signalé par le commentaire de L3-07 lui-même) : il
est maintenant transmis à Odoo.

### La réconciliation (critère 7)

`services/realtime/src/driver/reconcile.ts`. Périodique (`ENGAGEMENT_RECONCILE_INTERVAL_SECONDS`,
20 s par défaut), démarrée une fois depuis `index.ts` comme `startReservationExpiryWatcher`.
`SCAN MATCH babana:driver:engaged:*` côté Redis (le pool tient en quelques dizaines de chauffeurs
au pilote — un `SCAN` est largement suffisant, pas besoin d'un second index à maintenir en plus des
marqueurs eux-mêmes) contre `POST /api/internal/drivers/engaged` côté Odoo (source de vérité, D27 :
ce module ne décide de rien, il reflète). Écart dans un sens : marqueur effacé, chauffeur réintégré
si sa position est connue. Écart dans l'autre : marqueur posé, **retrait du pool avant** la pose
(jamais l'inverse — la fenêtre entre les deux ne doit jamais laisser un chauffeur qu'Odoo dit engagé
apparaître, même un instant, comme disponible).

**Compté et journalisé, pas seulement corrigé** : un écart non nul déclenche un `console.warn`
nommant les identifiants concernés — un écart durablement non nul n'est pas un incident de
réconciliation, c'est le symptôme du gap documenté ci-dessus (appel non bloquant sans file de
rejeu), et doit rester visible plutôt que masqué.

### Tests (côté temps réel)

`test/internal.test.ts` (9 tests, Redis réel, serveur HTTP réel sur port éphémère) : les trois
routes internes, l'authentification par secret, la précondition C-03, `DRIVER_ALREADY_TAKEN`, et le
rejeu d'idempotence (même clé, même corps, deuxième appel → même réponse que le premier, chauffeur
non re-réservé) — cette dernière preuve isolée de tout ce qui pourrait la déclencher en production ;
la preuve avec un vrai rejeu Odoo est dans l'entrée suivante.

`test/reconcile.test.ts` (3 tests, Redis réel + faux serveur Odoo local à une route) : orphelin
effacé, marqueur manquant posé, cas cohérent ni touché ni compté.

`npm test` (paquet `@babana/realtime`) : 103 tests, 25 suites, tout vert.

### Câblage côté Odoo

`services/odoo/addons/babana/services/realtime_client.py` (sens Odoo → temps réel) et
`controllers/internal.py` (sens temps réel → Odoo reçu, secret partagé — `_common.
authenticated_internal_call`, `hmac.compare_digest`, jamais `==`, même réflexe que la vérification
de signature d'un jeton).

`controllers/ride.py::_select_driver` : appelle `reserve_and_propose` avant `action_propose` ;
`PG_CONCURRENCY_EXCEPTIONS_TO_RETRY` laissée passer sans relâcher la réservation (D25 — la
relâcher là aurait défait la réservation juste avant qu'Odoo ne rejoue avec la même clé, l'inverse
de ce que le critère 3 demande) ; toute autre exception relâche puis se propage.

**Découverte en vérifiant contre la pile réelle, pas supposée** : `action_cancel` ne touchait à
aucun état temps réel. Une course annulée depuis `'proposed'` laissait la réservation Redis vivre
jusqu'à son expiration (45 s, auto-guérison) ; annulée depuis `'assigned'`/`'in_progress'`, elle
laissait l'engagement en place **indéfiniment** — exactement le défaut D26 que L3-06R/L3-07 ont
passé deux nuits à fermer, rouvert par un angle que ni l'une ni l'autre spécification ne
couvrait. Trouvé par `test/concurrency/ride-transitions.test.ts` (scénario 1, L4-11) qui a
commencé à échouer avec `DRIVER_ALREADY_TAKEN` dès la deuxième itération une fois le câblage en
place — pas une supposition, un test existant qui s'est mis à échouer pour de bon.
**Corrigé** : `_cancel_ride` appelle désormais `release_reservation` et `clear_engagement` pour le
chauffeur annulé (les deux, idempotents, sans chercher lequel des deux états s'applique).

**Second effet découvert par le même test** (scénario 2, annulation contre acceptation
concurrentes) : appeler ces deux relâchements en bloquant la réponse HTTP de `/cancel` changeait
la latence relative des deux requêtes en course et biaisait systématiquement l'issue de la
concurrence (accept gagnait toujours, jamais l'inverse) — un artefact introduit par ce lot, pas un
défaut du mécanisme de verrouillage lui-même. `realtime_client.notify_cancellation_async` : les
deux appels partent dans un fil démon (`threading.Thread(daemon=True)`), jamais attendus par la
réponse au client — cohérent avec le choix déjà pris pour acceptation/refus/expiration (non
bloquant, section précédente). `release_reservation`/`clear_engagement` prennent désormais un
`driver_public_id: str`, pas un recordset `babana.driver` — un recordset lié au curseur de la
transaction appelante n'est pas sûr à passer à un fil séparé.

### Le test du critère 3 — un vrai rejeu, pas un double appel simulé

`test/concurrency/select-driver-replay.test.ts`. **Première version fausse, corrigée avant de la
garder** : envoyer N requêtes select-driver réellement concurrentes avec le **même** chauffeur et
la **même** clé d'idempotence, en espérant que l'idempotence absorbe les doublons. Elle ne le fait
pas de façon fiable — vérifié en pratique : N requêtes HTTP concurrentes deviennent N tentatives
concurrentes côté temps réel, qui peuvent toutes lire `withIdempotency` avant qu'aucune n'ait eu le
temps d'y écrire (rien ne verrouille la lecture-puis-écriture du cache, seule `reserve.lua`
elle-même est atomique). Ce n'est tout simplement pas ce que fait Odoo : le rejeu de D25 est
**séquentiel**, une seule requête HTTP externe rejouée par le même fil après l'échec de sa
première tentative — jamais deux fils concurrents qui se disputent le même chauffeur.

**La bonne provocation** : deux requêtes select-driver concurrentes sur la **même course**, avec
**deux chauffeurs différents** (donc deux clés d'idempotence distinctes, sans aliasing). Les deux
verrouillent la même ligne `babana_ride` dans `action_propose::_lock_for_update()` — même
mécanisme que L4-11 scénario 2. Le perdant subit un vrai `SerializationFailure` et Odoo rejoue SA
requête entière avec SA propre clé ; c'est ce rejeu, réellement déclenché par Postgres, qui
exerce le chemin de `withIdempotency`. Vérifié sur 8 itérations : exactement un succès à chaque
fois, le perdant proprement relâché (resélectionnable immédiatement sur une course neuve), le
gagnant resté réservé (une autre course ne peut pas le voler).

**Vérifié une fois que le test détecte bien le défaut** (même discipline que L3-13/L4-11) :
`withIdempotency` court-circuité temporairement dans `http/internal.ts` (recalcul systématique au
lieu de rejouer) → le test échoue bien, avec `DRIVER_ALREADY_TAKEN` sur une tentative qui avait
pourtant déjà réussi — exactement le symptôme que la spécification décrit. Fix restauré, retesté
vert.

**Flakiness résolue en cours de route, deux causes réelles, pas des artefacts de test à ignorer** :
1. La limitation de débit de `nearby.subscribe` (L3-05, critère 6) épuisée par un ré-abonnement à
   chaque tentative de vérification de visibilité — `waitForDriverVisible` (`test/concurrency/
   helpers/realtime.ts`) est devenu purement passif (écoute la diffusion périodique déjà active,
   ne réémet plus jamais `nearby.subscribe`), et les deux connexions client du test sont
   désormais ouvertes une seule fois pour tout le fichier, jamais par itération.
2. Les chauffeurs d'itérations précédentes, fermés par une simple coupure de socket, restaient
   dans le pool pendant toute la période de grâce de déconnexion (45 s) — au même point que les
   suivants, ils finissaient par déborder la limite des 5 plus proches (D14) et masquer les
   chauffeurs de l'itération courante. `takeDriverOffline` bascule explicitement hors ligne avant
   de fermer, retrait immédiat (L3-04) plutôt que différé.

Les deux causes touchent aussi potentiellement une vraie flotte à forte rotation ; documentées ici
parce qu'elles ont d'abord semblé être des défauts du câblage lui-même avant d'être identifiées
comme des artefacts du test — la distinction a demandé de vérifier, pas de supposer.

### Champ-pont L3-16 : un blocage découvert en vérifiant contre la pile réelle

En câblant la précondition C-03, `nearby.drivers` s'est révélé omettre **systématiquement** tout
chauffeur réel (aucun ne porte de profil en cache — L3-16, canal de profil Odoo → temps réel,
n'a jamais été implémentée ; seul `redis/driver-profiles.ts` existe, un champ-pont déjà documenté
dans `amoa/questions/L3-05.md`). Sans profil, aucun chauffeur ne peut jamais satisfaire C-03 —
un blocage total du chemin nominal, pas un cas limite. Les fixtures de test (Python et
TypeScript) seedent désormais ce cache directement, comme `test/nearby.test.ts` le fait déjà côté
`@babana/realtime` — mais **la vraie flotte reste bloquée tant que L3-16 n'existe pas**. Signalé
dans `amoa/questions/L3-17.md`, priorité pour la prochaine session : sans elle, aucune course ne
peut aboutir en production, même avec tout le reste de ce lot en place.

---

## Vérification finale, sur base fraîche

`make reset` (volumes Postgres et Redis effacés) puis `make up`, `sh infra/smoke-test.sh` (6
critères, tout `OK`), puis `make test` complet :

- Suite Odoo sur base vierge, module `babana` réinstallé : **338 tests, 0 échec** — et l'ensemble
  des modules Odoo dont il dépend (2085 tests au total avec les modules de base), également à 0
  échec, sur une base qui n'a jamais rien vu tourner avant ce lancement.
- `@babana/contracts` : 67/67.
- `@babana/realtime` : 103/103, dont les 9 nouveaux tests de `internal.test.ts` et les 3 de
  `reconcile.test.ts`.
- `@babana/concurrency-tests` (contre la pile réelle) : scénarios 1 et 2 de L4-11 (accept/cancel
  concurrents, désormais avec réservation réelle) et le test du critère 3 de L3-17 — 5/5, un
  scénario resté volontairement `SKIP` (encaissement, hors périmètre).
- `docs/contracts/verify-ride-state-machine.js` : `OK`.

`npm run typecheck --workspaces` et `npm run lint --workspaces` (tous paquets) : propres.
`tools/secret-scan/scan.sh` : aucun secret détecté.

Aucun raccourci pris sur cette vérification : c'est la même base fraîche qui a servi de révélateur
au 12 août (CLAUDE.md) qui a servi ici de dernier filet avant de déclarer la tâche finie.

---

## Ce qui reste ouvert pour la prochaine session

1. **L3-16** (profils chauffeur, canal Odoo → temps réel) — priorité absolue : sans elle, la
   précondition C-03 câblée cette nuit bloque **toute** sélection de chauffeur réel en production
   (`amoa/questions/L3-17.md` §0).
2. **L3-12** (file persistante avec rejeu pour les appels sortants du service temps réel) — le
   canal temps réel → Odoo construit cette nuit (acceptation, refus, expiration) n'a, en son
   absence, que les réessais en mémoire de `callOdoo` ; un Odoo indisponible plus longtemps que ces
   réessais laisse une course bloquée en `proposed` sans filet (`amoa/questions/L3-17.md` §1).
3. Les endpoints publics `/accept`/`/reject` (L4-03) restent un second chemin d'écriture qui
   contourne la réservation atomique — à trancher quand le câblage mobile de l'acceptation sera
   fait (`amoa/questions/L3-17.md` §2).
4. **L4-05/L5-01** — encaissement, neuvième nuit d'attente. Après L3-16, c'est ce qui manque pour
   une course démontrable de bout en bout jusqu'à l'encaissement.
5. **L3-08 à L3-12 (hors L3-12 déjà cité), L3-14, L3-15** — la seconde moitié du lot temps réel.
6. Le compte Google Play — inchangé.
