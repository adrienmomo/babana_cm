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
